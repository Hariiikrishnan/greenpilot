// Profile settings tab (Phase 12) — USER-owned, distinct from organization.
// Real API: GET/PUT /v1/settings/profile + POST /v1/settings/password.
// Email and app role are admin-managed (see Users tab); this tab never mixes
// organization ownership in.

import { useState, useEffect } from 'react';
import { api } from '../../api.js';
import { friendlyApiError } from '../../utils/apiError.js';
import { C, FONT } from '../../constants.js';
import { TabLoading, Alert, alertOk } from './OrganizationTab.jsx';

export default function ProfileTab() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.settings.getProfile()
      .then(p => { if (!cancelled) { setProfile(p); setDisplayName(p?.displayName || ''); } })
      .catch(err => { if (!cancelled) setError(friendlyApiError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setError('');
    setSaved(false);
    try {
      const updated = await api.settings.updateProfile({ displayName: displayName.trim() });
      setProfile(updated);
      setSaved(true);
    } catch (err) {
      setError(friendlyApiError(err));
    }
  };

  const handlePassword = async () => {
    setPwMsg('');
    if (!pw.current || !pw.next) { setPwMsg('Enter your current and a new password.'); return; }
    if (pw.next !== pw.confirm) { setPwMsg('New passwords do not match.'); return; }
    if (pw.next.length < 8) { setPwMsg('New password must be at least 8 characters.'); return; }
    setPwBusy(true);
    try {
      await api.settings.changePassword({ currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      setPwMsg('Password changed.');
    } catch (err) {
      setPwMsg(friendlyApiError(err));
    } finally {
      setPwBusy(false);
    }
  };

  if (loading) return <TabLoading label="Loading profile…" />;

  return (
    <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', fontFamily: FONT }}>
      <div style={{ maxWidth: 560 }}>
        <h1 style={h1}>Profile</h1>
        <p style={sub}>Your personal account — separate from workspace settings.</p>
        {error && <Alert>{error}</Alert>}
        {saved && <div style={alertOk}>Saved.</div>}

        <div style={{ marginBottom: 16 }}>
          <Label>Email (managed by your administrator)</Label>
          <input value={profile?.email || ''} disabled style={inp(true)} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <Label>Display name</Label>
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inp(false)} />
        </div>
        <button onClick={handleSave} style={btn}>Save profile</button>

        <div style={{ marginTop: 32 }}>
          <div style={sectionTitle}>Security</div>
          <div style={{ marginBottom: 12 }}>
            <Label>Current password</Label>
            <input type="password" value={pw.current} onChange={e => setPw(s => ({ ...s, current: e.target.value }))} style={inp(false)} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Label>New password</Label>
              <input type="password" value={pw.next} onChange={e => setPw(s => ({ ...s, next: e.target.value }))} style={inp(false)} />
            </div>
            <div style={{ flex: 1 }}>
              <Label>Confirm new password</Label>
              <input type="password" value={pw.confirm} onChange={e => setPw(s => ({ ...s, confirm: e.target.value }))} style={inp(false)} />
            </div>
          </div>
          {pwMsg && <div style={{ marginTop: 10, fontSize: 13, color: C.textMuted }}>{pwMsg}</div>}
          <button onClick={handlePassword} disabled={pwBusy} style={{ ...btn, marginTop: 12 }}>
            {pwBusy ? 'Changing…' : 'Change password'}
          </button>
          <div style={{ marginTop: 16, fontSize: 12, color: C.textMuted }}>
            Signed in as {profile?.username || '—'} · app role: {profile?.role || '—'} ·
            account status: {profile?.isActive === false ? 'disabled' : 'active'}
          </div>
        </div>
      </div>
    </div>
  );
}

function Label({ children }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
      {children}
    </div>
  );
}

const h1 = { fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT };
const sub = { fontSize: 12, color: C.textMuted, margin: '4px 0 20px', fontFamily: FONT };
const sectionTitle = { fontSize: 13, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 };
const inp = (disabled) => ({
  width: '100%', maxWidth: 420, height: 38, borderRadius: 8, border: `1.5px solid ${C.border}`,
  padding: '0 12px', fontSize: 13, fontFamily: FONT, background: disabled ? C.headerSurface : '#fff', color: C.text,
});
const btn = {
  marginTop: 4, height: 38, borderRadius: 8, padding: '0 18px', background: C.primary,
  color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT,
};
