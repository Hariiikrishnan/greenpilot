// Phase 12 HTTP onboarding E2E (wire path).
//
// Boots the real Express app on an ephemeral port against the
// migration-provisioned database and walks the new-customer lifecycle over
// the wire: register → org (idempotent retry) → onboarding overview → CRM
// init → complete → team invite/accept → settings guards → WhatsApp status.
// Cross-tenant forgery is rejected throughout. Skips cleanly without a DB.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

let pool = null;
let dbAvailable = false;
let server = null;
let base = '';
const TAG = `ob12-${Date.now().toString(36)}`;

function jar() {
  const cookies = [];
  return {
    async fetch(path, opts = {}) {
      const res = await globalThis.fetch(`${base}${path}`, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          ...(cookies.length > 0 ? { Cookie: cookies.join('; ') } : {}),
          ...(opts.headers || {}),
        },
        body: opts.body !== undefined ? opts.body : undefined,
      });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) cookies.push(c.split(';')[0]);
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    },
  };
}

const owner = jar();   // registers (org owner, viewer app role + owner grants)
const member = jar();  // plain user added as member
const invitee = jar(); // registers with the invited email, then accepts
const stranger = jar();// owner of an unrelated org (cross-tenant checks)

let orgA = null;
let orgStranger = null;

async function mkUser(name, password) {
  const email = `${TAG}-${name}@ob12.test`;
  await pool.query(
    `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
     VALUES ($1, $2, 'x', $3, 'viewer')
     ON CONFLICT (email) DO NOTHING`,
    [`${TAG}-${name}`, email, name]
  );
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 4);
  await pool.query(`UPDATE coexistence.forgecrm_users SET password = $1 WHERE email = $2`, [hash, email]);
  return email;
}

before(async () => {
  try {
    pool = require('../src/db');
    await pool.query('SELECT 1');
    const { runMigrations } = require('../src/db/migrate');
    await runMigrations(pool);
    dbAvailable = true;
  } catch {
    return;
  }
  const { app } = require('../src/index');
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const memberEmail = await mkUser('member', `${TAG}-pw`);
  let r = await member.fetch('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: memberEmail, password: `${TAG}-pw` }),
  });
  assert.equal(r.status, 200, 'member login works');

  const strangerEmail = await mkUser('stranger', `${TAG}-pw`);
  r = await stranger.fetch('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: strangerEmail, password: `${TAG}-pw` }),
  });
  assert.equal(r.status, 200, 'stranger login works');
  r = await stranger.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} stranger-org` }) });
  assert.equal(r.status, 201, 'stranger creates own org');
  orgStranger = r.body.id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    const { shutdownSendQueue } = require('../src/queue/sendQueue');
    const { shutdownAgentQueue } = require('../src/queue/agentQueue');
    const { shutdown: shutdownMediaQueue } = require('../src/queue/mediaQueue');
    const { shutdownAutomationQueue } = require('../src/queue/automationQueue');
    await shutdownSendQueue().catch(() => {});
    await shutdownAgentQueue().catch(() => {});
    await shutdownMediaQueue().catch(() => {});
    await shutdownAutomationQueue().catch(() => {});
  } catch { /* already torn down */ }
  if (!dbAvailable) return;
  await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE display_phone_number LIKE '1555%' AND organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.pipeline_stages WHERE pipeline_id IN (SELECT id FROM coexistence.pipelines WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%'))`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.pipelines WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.organization_invitations WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.organization_members WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE name LIKE '${TAG}%')`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.organizations WHERE name LIKE '${TAG}%'`).catch(() => {});
  await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE username LIKE '${TAG}-%' OR email LIKE '${TAG}-%'`).catch(() => {});
  await pool.end();
});

function wire(name, fn) {
  test(name, async (t) => {
    if (!dbAvailable) {
      t.skip('no database reachable');
      return;
    }
    await fn();
  });
}

wire('register creates user + personal org + session; duplicate is 409', async () => {
  const email = `${TAG}-owner@ob12.test`;
  const r = await owner.fetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'supersecret1', displayName: 'Owner', organizationName: `${TAG} acme` }),
  });
  assert.equal(r.status, 201);
  assert.ok(r.body.user);
  assert.ok(r.body.organization?.id);
  orgA = r.body.organization.id;
  // Signup owner can already see team pages (page grants, least-privilege app role).
  assert.ok(r.body.user.pages.includes('chats'), 'owner grant includes chats');

  const dup = await owner.fetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'supersecret1' }),
  });
  assert.equal(dup.status, 409);
});

wire('org creation is idempotent under Idempotency-Key (no duplicate on retry)', async () => {
  const key = `${TAG}-org-key-1`;
  const payload = JSON.stringify({ name: `${TAG} retry-org` });
  const first = await owner.fetch('/api/v1/orgs', { method: 'POST', headers: { 'Idempotency-Key': key }, body: payload });
  assert.equal(first.status, 201);
  const retry = await owner.fetch('/api/v1/orgs', { method: 'POST', headers: { 'Idempotency-Key': key }, body: payload });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.id, first.body.id);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.organizations WHERE name = $1`, [`${TAG} retry-org`]
  );
  assert.equal(rows[0].n, 1);
});

wire('onboarding overview reflects real state (org done, whatsapp pending, incomplete)', async () => {
  const r = await owner.fetch('/api/v1/settings/overview', { headers: { 'X-Org-Id': orgA } });
  assert.equal(r.status, 200);
  assert.equal(r.body.organization.id, orgA);
  assert.equal(r.body.onboarding.derived.steps.organization.status, 'complete');
  assert.equal(r.body.onboarding.derived.steps.whatsapp.status, 'pending');
  assert.equal(r.body.onboarding.completed, false);
});

wire('CRM init-default is idempotent and org-scoped', async () => {
  const first = await owner.fetch('/api/pipelines/init-default', { method: 'POST', headers: { 'X-Org-Id': orgA } });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  const again = await owner.fetch('/api/pipelines/init-default', { method: 'POST', headers: { 'X-Org-Id': orgA } });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.pipelineId, first.body.pipeline.id);
  const list = await owner.fetch('/api/pipelines', { headers: { 'X-Org-Id': orgA } });
  assert.equal(list.status, 200);
  const mine = list.body.filter(p => p.id === first.body.pipeline.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].stages.length, 6);
  // Stranger's org is untouched.
  const other = await stranger.fetch('/api/pipelines', { headers: { 'X-Org-Id': orgStranger } });
  assert.equal(other.status, 200);
  assert.equal(other.body.length, 0);
});

wire('onboarding completes only when required setup is real (409 before init, 200 after)', async () => {
  // Fresh org without CRM defaults cannot complete.
  const fresh = await owner.fetch('/api/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `${TAG} fresh-org` }) });
  assert.equal(fresh.status, 201);
  const early = await owner.fetch('/api/v1/settings/onboarding/complete', {
    method: 'POST', headers: { 'X-Org-Id': fresh.body.id },
  });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'onboarding-incomplete');
  // After CRM init, completion succeeds and persists.
  const init = await owner.fetch('/api/pipelines/init-default', { method: 'POST', headers: { 'X-Org-Id': fresh.body.id } });
  assert.ok([200, 201].includes(init.status));
  const done = await owner.fetch('/api/v1/settings/onboarding/complete', {
    method: 'POST', headers: { 'X-Org-Id': fresh.body.id },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.completed, true);
  // Org A (already initialized) completes too.
  const doneA = await owner.fetch('/api/v1/settings/onboarding/complete', {
    method: 'POST', headers: { 'X-Org-Id': orgA },
  });
  assert.equal(doneA.status, 200);
});

wire('member reads org settings but cannot edit (403); profile is user-owned', async () => {
  const memberEmail = `${TAG}-member@ob12.test`;
  const add = await owner.fetch(`/api/v1/orgs/${orgA}/members`, {
    method: 'POST', headers: { 'X-Org-Id': orgA },
    body: JSON.stringify({ email: memberEmail, role: 'member' }),
  });
  assert.equal(add.status, 201);

  const read = await member.fetch('/api/v1/settings/organization', { headers: { 'X-Org-Id': orgA } });
  assert.equal(read.status, 200);

  const edit = await member.fetch('/api/v1/settings/organization', {
    method: 'PUT', headers: { 'X-Org-Id': orgA },
    body: JSON.stringify({ timezone: 'Asia/Kolkata' }),
  });
  assert.equal(edit.status, 403);

  const bad = await owner.fetch('/api/v1/settings/organization', {
    method: 'PUT', headers: { 'X-Org-Id': orgA },
    body: JSON.stringify({ timezone: 'not-a-timezone' }),
  });
  assert.equal(bad.status, 422);

  const good = await owner.fetch('/api/v1/settings/organization', {
    method: 'PUT', headers: { 'X-Org-Id': orgA },
    body: JSON.stringify({ timezone: 'Asia/Kolkata', locale: 'en-IN', businessName: 'Acme' }),
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.timezone, 'Asia/Kolkata');

  const me = await member.fetch('/api/v1/settings/profile');
  assert.equal(me.status, 200);
  assert.equal(me.body.email, memberEmail);
  const rename = await member.fetch('/api/v1/settings/profile', {
    method: 'PUT', body: JSON.stringify({ displayName: 'Member Renamed' }),
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.displayName, 'Member Renamed');
});

wire('password change verifies current password', async () => {
  const wrong = await member.fetch('/api/v1/settings/password', {
    method: 'POST', body: JSON.stringify({ currentPassword: 'nope', newPassword: 'newsecret99' }),
  });
  assert.equal(wrong.status, 401);
  const ok = await member.fetch('/api/v1/settings/password', {
    method: 'POST', body: JSON.stringify({ currentPassword: `${TAG}-pw`, newPassword: 'newsecret99' }),
  });
  assert.equal(ok.status, 200);
  // New password works for a fresh login.
  const fresh = jar();
  const r = await fresh.fetch('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: `${TAG}-member@ob12.test`, password: 'newsecret99' }),
  });
  assert.equal(r.status, 200);
});

wire('invitation: create → lookup → accept → single-use; token binds the org', async () => {
  const inviteeEmail = `${TAG}-invitee@ob12.test`;
  const created = await owner.fetch(`/api/v1/orgs/${orgA}/invitations`, {
    method: 'POST', headers: { 'X-Org-Id': orgA },
    body: JSON.stringify({ email: inviteeEmail, role: 'member' }),
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.token, 'raw token returned once');
  const token = created.body.token;

  // Invitee registers with the matching email, then looks up + accepts.
  const reg = await invitee.fetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: inviteeEmail, password: 'invitee-secret1', displayName: 'Invitee' }),
  });
  assert.equal(reg.status, 201);

  const preview = await invitee.fetch(`/api/v1/invitations/${token}`);
  assert.equal(preview.status, 200);

  const accept = await invitee.fetch(`/api/v1/invitations/${token}/accept`, { method: 'POST' });
  assert.equal(accept.status, 200);
  assert.equal(accept.body.organizationId, orgA);

  // Single-use: replay is rejected.
  const replay = await invitee.fetch(`/api/v1/invitations/${token}/accept`, { method: 'POST' });
  assert.equal(replay.status, 410);

  // Membership is real and scoped.
  const members = await owner.fetch(`/api/v1/orgs/${orgA}/members`, { headers: { 'X-Org-Id': orgA } });
  assert.equal(members.status, 200);
  assert.ok(members.body.some(m => m.email === inviteeEmail));
});

wire('invitation: email mismatch and revoke are enforced', async () => {
  const other = `${TAG}-nomatch@ob12.test`;
  const created = await owner.fetch(`/api/v1/orgs/${orgA}/invitations`, {
    method: 'POST', headers: { 'X-Org-Id': orgA },
    body: JSON.stringify({ email: other, role: 'member' }),
  });
  assert.equal(created.status, 201);
  // Wrong signed-in email cannot steal the invite.
  const stolen = await stranger.fetch(`/api/v1/invitations/${created.body.token}/accept`, { method: 'POST' });
  assert.equal(stolen.status, 403);
  // Revoke kills it.
  const revoked = await owner.fetch(`/api/v1/orgs/${orgA}/invitations/${created.body.id}/revoke`, {
    method: 'POST', headers: { 'X-Org-Id': orgA },
  });
  assert.equal(revoked.status, 200);
  const gone = await stranger.fetch(`/api/v1/invitations/${created.body.token}`);
  assert.equal(gone.status, 410);
});

wire('cross-tenant forgery is rejected on settings, invites, whatsapp-status', async () => {
  const s1 = await stranger.fetch('/api/v1/settings/organization', { headers: { 'X-Org-Id': orgA } });
  assert.equal(s1.status, 403);
  const s2 = await stranger.fetch(`/api/v1/orgs/${orgA}/invitations`, {
    method: 'POST', headers: { 'X-Org-Id': orgA },
    body: JSON.stringify({ email: 'x@y.zz', role: 'member' }),
  });
  assert.equal(s2.status, 403);
  const s3 = await stranger.fetch('/api/v1/settings/whatsapp-status', { headers: { 'X-Org-Id': orgA } });
  assert.equal(s3.status, 403);
});

wire('whatsapp-status reflects real backend state per org', async () => {
  const empty = await owner.fetch('/api/v1/settings/whatsapp-status', { headers: { 'X-Org-Id': orgA } });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.status, 'not-configured');

  await pool.query(
    `INSERT INTO coexistence.whatsapp_accounts
       (display_name, display_phone_number, phone_number_id, waba_id,
        access_token_encrypted, verify_token_encrypted, is_default, is_active,
        organization_id, health_status)
     VALUES ('ob12', '15550001111', $1, $2, 'enc', 'enc', TRUE, TRUE, $3, 'healthy')`,
    [`${TAG}-pn`, `${TAG}-waba`, orgA]
  );
  const up = await owner.fetch('/api/v1/settings/whatsapp-status', { headers: { 'X-Org-Id': orgA } });
  assert.equal(up.body.status, 'connected');
  assert.ok(!JSON.stringify(up.body).includes('enc'), 'no secrets leak');

  // Stranger org still reports its own real state.
  const other = await stranger.fetch('/api/v1/settings/whatsapp-status', { headers: { 'X-Org-Id': orgStranger } });
  assert.equal(other.body.status, 'not-configured');
});

wire('multi-org caller without selection fails closed (no silent tenant pick)', async () => {
  // owner now belongs to several orgs → overview without X-Org-Id must 403.
  const r = await owner.fetch('/api/v1/settings/overview');
  assert.equal(r.status, 403);
});
