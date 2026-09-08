// Green Pilot tenant-isolation tests (Step 12) — DB-backed, skipped when no
// database is reachable (e.g. CI jobs without Postgres).
//
// Fixture: Org A (user A) vs Org B (user B), each with account/contact/message/
// conversation/automation/AI-usage rows. Verifies A cannot read/update/delete
// or operate through B's records at the SQL + service + worker-guard layers.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config();

let pool = null;
let dbAvailable = false;
try {
  pool = require('../src/db');
} catch {
  pool = null;
}

const {
  assertMembership,
  createOrganization,
} = require('../src/tenancy/organizations');
const { assertOrgRow, tenantJobAllowed } = require('../src/tenancy/scope');

const TAG = `iso-${Date.now()}`;
let A = {};
let B = {};

before(async () => {
  if (!pool) return;
  try {
    await pool.query('SELECT 1');
    // Self-provision: apply the migration chain (idempotent, ledgered) so the
    // suite runs on a fresh database exactly as production boots.
    const { runMigrations } = require('../src/db/migrate');
    await runMigrations(pool);
    dbAvailable = true;
  } catch {
    return; // no DB → every test below skips
  }

  async function mkUser(username) {
    const email = `${TAG}-${username}@iso.test`;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.forgecrm_users (username, email, password, display_name, role)
       VALUES ($1, $2, 'x', $3, 'admin') RETURNING id`,
      [`${TAG}-${username}`, email, username]
    );
    return rows[0].id;
  }

  for (const [key, label] of [['A', 'alpha'], ['B', 'beta']]) {
    const userId = await mkUser(label);
    const org = await createOrganization(pool, userId, { name: `${TAG} ${label}` });
    const acc = await pool.query(
      `INSERT INTO coexistence.whatsapp_accounts
         (display_name, display_phone_number, phone_number_id, waba_id,
          access_token_encrypted, verify_token_encrypted, is_default, is_active, organization_id)
       VALUES ($1, $2, $3, $4, 'enc', 'enc', TRUE, TRUE, $5) RETURNING id`,
      [`${label} acct`, key === 'A' ? '15550001111' : '15550002222', `${TAG}-pn-${label}`, `${TAG}-waba-${label}`, org.id]
    );
    const accountId = acc.rows[0].id;
    await pool.query(
      `INSERT INTO coexistence.contacts (wa_number, contact_number, organization_id)
       VALUES ($1, $2, $3)`,
      [key === 'A' ? '15550001111' : '15550002222', key === 'A' ? '19998887777' : '19998886666', org.id]
    );
    const msg = await pool.query(
      `INSERT INTO coexistence.chat_history
         (message_id, phone_number_id, wa_number, contact_number, direction,
          message_type, message_body, status, timestamp, organization_id)
       VALUES ($1, $2, $3, $4, 'incoming', 'text', 'hello', 'received', NOW(), $5)
       RETURNING id`,
      [`${TAG}-wamid-${label}`, `${TAG}-pn-${label}`,
        key === 'A' ? '15550001111' : '15550002222',
        key === 'A' ? '19998887777' : '19998886666', org.id]
    );
    const conv = await pool.query(
      `INSERT INTO coexistence.conversations
         (organization_id, whatsapp_account_id, wa_number, contact_number)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [org.id, accountId,
        key === 'A' ? '15550001111' : '15550002222',
        key === 'A' ? '19998887777' : '19998886666']
    );
    const agent = await pool.query(
      `INSERT INTO coexistence.agents (name, system_prompt, wa_account_id, is_active, organization_id)
       VALUES ($1, 'test prompt', $2, FALSE, $3) RETURNING id`,
      [`${TAG} agent ${label}`, accountId, org.id]
    );
    const bot = await pool.query(
      `INSERT INTO coexistence.chatbots (name, organization_id) VALUES ($1, $2) RETURNING id`,
      [`${TAG} bot ${label}`, org.id]
    );
    const ledger = await pool.query(
      `INSERT INTO coexistence.ai_usage_ledger (organization_id, agent_id, inbound_message_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [org.id, agent.rows[0].id, `${TAG}-in-${label}`]
    );
    if (key === 'A') {
      A = { userId, orgId: org.id, accountId, msgId: msg.rows[0].id, convId: conv.rows[0].id, agentId: agent.rows[0].id, botId: bot.rows[0].id, ledgerId: ledger.rows[0].id };
    } else {
      B = { userId, orgId: org.id, accountId, msgId: msg.rows[0].id, convId: conv.rows[0].id, agentId: agent.rows[0].id, botId: bot.rows[0].id, ledgerId: ledger.rows[0].id };
    }
  }
});

after(async () => {
  if (!dbAvailable) return;
  // Teardown in FK-safe order, keyed by TAG (never by the A/B handles, so a
  // mid-fixture failure still cleans up). Orgs last — RESTRICT refuses
  // deletion while customer rows reference them.
  await pool.query(`DELETE FROM coexistence.ai_usage_ledger WHERE inbound_message_id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.chat_history WHERE message_id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.conversations WHERE wa_number IN ('15550001111','15550002222') AND contact_number IN ('19998887777','19998886666')`);
  await pool.query(`DELETE FROM coexistence.contacts WHERE contact_number IN ('19998887777','19998886666')`);
  await pool.query(`DELETE FROM coexistence.agents WHERE name LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.chatbots WHERE name LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.whatsapp_accounts WHERE phone_number_id LIKE '${TAG}-%'`);
  await pool.query(`DELETE FROM coexistence.organization_members WHERE organization_id IN (SELECT id FROM coexistence.organizations WHERE slug LIKE '${TAG}%')`);
  await pool.query(`DELETE FROM coexistence.organizations WHERE slug LIKE '${TAG}%'`);
  await pool.query(`DELETE FROM coexistence.forgecrm_users WHERE username LIKE '${TAG}-%'`);
  await pool.end();
});

function gate(name, fn) {
  test(name, async (t) => {
    if (!dbAvailable) {
      t.skip('no database reachable');
      return;
    }
    await fn();
  });
}

// Membership layer: A is not a member of B's org.
gate('A cannot assert membership in B org (and vice versa)', async () => {
  assert.equal(await assertMembership(pool, A.userId, B.orgId), null);
  assert.equal(await assertMembership(pool, B.userId, A.orgId), null);
  assert.ok(await assertMembership(pool, A.userId, A.orgId));
});

// Service layer (assertOrgRow): cross-org reads resolve to null → 404 semantics.
for (const [table, idCol, key] of [
  ['contacts', 'contact_number', 'contactNumber'],
  ['chat_history', 'id', 'msgId'],
  ['conversations', 'id', 'convId'],
  ['agents', 'id', 'agentId'],
  ['chatbots', 'id', 'botId'],
  ['ai_usage_ledger', 'id', 'ledgerId'],
  ['whatsapp_accounts', 'id', 'accountId'],
]) {
  gate(`assertOrgRow: A cannot read B ${table}; A reads own`, async () => {
    const ownId = table === 'contacts' ? (key === 'contactNumber' ? '19998887777' : null) : A[key];
    void ownId;
    const crossId = table === 'contacts' ? '19998886666' : B[key];
    const mineId = table === 'contacts' ? '19998887777' : A[key];
    assert.equal(await assertOrgRow(pool, table, idCol, crossId, A.orgId), null);
    assert.ok(await assertOrgRow(pool, table, idCol, mineId, A.orgId));
  });
}

// SQL layer: org-scoped list queries never return the other tenant's rows.
gate('org-scoped lists isolate messages/conversations/agents/ledger', async () => {
  for (const [table, col] of [['chat_history', 'message_id'], ['conversations', 'id'], ['agents', 'name'], ['ai_usage_ledger', 'inbound_message_id']]) {
    const { rows } = await pool.query(
      `SELECT ${col} FROM coexistence.${table} WHERE organization_id = $1`, [A.orgId]
    );
    const vals = rows.map((r) => String(Object.values(r)[0]));
    assert.ok(vals.length >= 1, `${table} has A rows`);
    assert.ok(vals.every((v) => !v.includes('beta') && v !== String(B.msgId) && v !== String(B.convId)), `${table} leaks B rows`);
  }
});

// Update/delete layer: cross-org writes affect zero rows.
gate('A cannot update or delete B message / conversation', async () => {
  const u = await pool.query(
    `UPDATE coexistence.chat_history SET message_body = 'pwned'
      WHERE id = $1 AND organization_id = $2`, [B.msgId, A.orgId]
  );
  assert.equal(u.rowCount, 0);
  const d = await pool.query(
    `DELETE FROM coexistence.conversations WHERE id = $1 AND organization_id = $2`, [B.convId, A.orgId]
  );
  assert.equal(d.rowCount, 0);
  const still = await pool.query(`SELECT message_body FROM coexistence.chat_history WHERE id = $1`, [B.msgId]);
  assert.equal(still.rows[0].message_body, 'hello');
});

// Worker-path guards (pure, no Redis): job org A vs account org B refused.
gate('tenantJobAllowed: same-org + legacy pass; cross-org denied', async () => {
  assert.equal(tenantJobAllowed(A.orgId, A.orgId), true);
  assert.equal(tenantJobAllowed(null, B.orgId), true);
  assert.equal(tenantJobAllowed(A.orgId, null), true);
  assert.equal(tenantJobAllowed(A.orgId, B.orgId), false);
  assert.equal(tenantJobAllowed(B.orgId, A.orgId), false);
});

// Quota/billing ownership: ledger rows are org-bound; B usage never debits A.
gate('AI usage ledger is org-bound per row', async () => {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.ai_usage_ledger
      WHERE organization_id = $1 AND inbound_message_id LIKE '${TAG}-%'`, [A.orgId]
  );
  assert.equal(rows[0].n, 1);
  const { rows: b } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coexistence.ai_usage_ledger
      WHERE organization_id = $1 AND inbound_message_id LIKE '${TAG}-%'`, [B.orgId]
  );
  assert.equal(b[0].n, 1);
});
