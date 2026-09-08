// Team management tab (Phase 12) — organization-scoped, membership-gated.
// Real APIs: members list/add/remove + secure invitations (create/list/revoke).
// An admin here can never touch another organization's membership: every call
// carries only the active org (X-Org-Id) and the server re-checks membership.

import { useState, useEffect, useCallback } from 'react';
import { api, getActiveOrgId } from '../../api.js';
import { friendlyApiError } from '../../utils/apiError.js';
import { C, FONT } from '../../constants.js';
import { TabLoading, Alert, alertOk } from './OrganizationTab.jsx';

export default function TeamTab({ user }) {
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);

  const orgId = getActiveOrgId();
  const myEntry = members.find(m => String(m.user_id) === String(user?.id));
  const canManage = myEntry ? ['owner', 'admin'].includes(myEntry.role) : user?.role === 'admin';
  const isOwner = myEntry ? myEntry.role === 'owner' : user?.role === 'admin';

  const refresh = useCallback(async () => {
    if (!orgId) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const [m, inv] = await Promise.all([
        api.orgs.members(orgId),
        api.invitations.list(orgId).catch(() => []),
      ]);
      setMembers(Array.isArray(m) ? m : []);
      setInvites(Array.isArray(inv) ? inv : []);
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleInvite = async () => {
    if (!email.trim()) { setError('Enter an email address.'); return; }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const inv = await api.invitations.create(orgId, { email: email.trim(), role });
      setEmail('');
      setNotice(`Invitation created for ${inv.email} — valid for 7 days, single use.`);
      await refresh();
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id) => {
    setError('');
    setNotice('');
    try {
      await api.invitations.revoke(orgId, id);
      setNotice('Invitation revoked.');
      await refresh();
    } catch (err) {
      setError(friendlyApiError(err));
    }
  };

  const handleRemove = async (userId) => {
    if (!window.confirm('Remove this member from the workspace?')) return;
    setError('');
    setNotice('');
    try {
      await api.orgs.removeMember(orgId, userId);
      setNotice('Member removed.');
      await refresh();
    } catch (err) {
      setError(friendlyApiError(err));
    }
  };

  if (loading) return <TabLoading label="Loading team…" />;
  if (!orgId) {
    return (
      <div style={{ flex: 1, padding: '32px 40px', fontFamily: FONT, fontSize: 13, color: C.textMuted }}>
        Join or create a workspace to manage your team.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', fontFamily: FONT }}>
      <div style={{ maxWidth: 680 }}>
        <h1 style={h1}>Team</h1>
        <p style={sub}>{members.length} member(s) in this workspace.</p>
        {error && <Alert>{error}</Alert>}
        {notice && <div style={alertOk}>{notice}</div>}

        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 28 }}>
          {members.map(m => (
            <div key={m.user_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: C.text }}>{m.display_name || m.email}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{m.email}</div>
              </div>
              <span style={rolePill}>{m.role}</span>
              {isOwner && String(m.user_id) !== String(user?.id) && (
                <button onClick={() => handleRemove(m.user_id)} style={dangerGhost}>Remove</button>
              )}
            </div>
          ))}
          {members.length === 0 && (
            <div style={{ padding: 20, fontSize: 13, color: C.textMuted }}>No members found.</div>
          )}
        </div>

        {canManage ? (
          <div>
            <div style={sectionTitle}>Invite a teammate</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="teammate@company.com"
                style={{ ...inp, flex: 1, minWidth: 200 }}
              />
              <select value={role} onChange={e => setRole(e.target.value)} style={inp}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button onClick={handleInvite} disabled={busy} style={btn}>
                {busy ? 'Inviting…' : 'Send invite'}
              </button>
            </div>
            {invites.filter(i => !i.acceptedAt && !i.revokedAt).length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={sectionTitle}>Pending invitations</div>
                {invites.filter(i => !i.acceptedAt && !i.revokedAt).map(i => (
                  <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', fontSize: 13, borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ flex: 1 }}>{i.email} <span style={{ color: C.textMuted }}>· {i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}</span></span>
                    <button onClick={() => handleRevoke(i.id)} style={dangerGhost}>Revoke</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: C.textMuted }}>
            Only owners and admins can invite or remove team members.
          </div>
        )}
      </div>
    </div>
  );
}

const h1 = { fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT };
const sub = { fontSize: 12, color: C.textMuted, margin: '4px 0 20px', fontFamily: FONT };
const sectionTitle = { fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 };
const inp = {
  height: 38, borderRadius: 8, border: `1.5px solid ${C.border}`,
  padding: '0 12px', fontSize: 13, fontFamily: FONT, background: '#fff', color: C.text,
};
const btn = {
  height: 38, borderRadius: 8, padding: '0 18px', background: C.primary,
  color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT,
};
const dangerGhost = {
  height: 30, borderRadius: 7, padding: '0 12px', background: 'transparent',
  color: '#A32D2D', border: '1px solid #F5C2C2', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: FONT,
};
const rolePill = {
  fontSize: 11, fontWeight: 700, color: C.textSecondary, background: C.headerSurface,
  border: `1px solid ${C.border}`, borderRadius: 20, padding: '3px 10px', textTransform: 'capitalize',
};
