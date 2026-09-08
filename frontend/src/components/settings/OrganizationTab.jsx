// Organization settings tab (Phase 12).
// Real API integration: GET/PUT /v1/settings/organization + WhatsApp status.
// Owner/admin may edit; members get a read-only view (backend enforces 403).

import { useState, useEffect } from 'react';
import { Loader2, Building2 } from 'lucide-react';
import { api } from '../../api.js';
import { friendlyApiError } from '../../utils/apiError.js';
import { C, FONT } from '../../constants.js';

const TIMEZONES = [
  'UTC',
  'Asia/Kolkata', 'Asia/Calcutta', 'Asia/Dubai', 'Asia/Singapore',
  'Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'Europe/Berlin',
  'Europe/Paris', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Australia/Sydney', 'Pacific/Auckland',
];

export default function OrganizationTab() {
  const [org, setOrg] = useState(null);
  const [wa, setWa] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({ name: '', timezone: 'UTC', locale: 'en', businessName: '' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.settings.getOrganization(), api.settings.whatsappStatus().catch(() => null)])
      .then(([o, w]) => {
        if (cancelled) return;
        setOrg(o);
        setWa(w);
        setForm({
          name: o?.name || '',
          timezone: o?.timezone || 'UTC',
          locale: o?.locale || 'en',
          businessName: o?.businessName || '',
        });
      })
      .catch(err => { if (!cancelled) setError(friendlyApiError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const canEdit = org?.role === 'owner' || org?.role === 'admin';

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const updated = await api.settings.updateOrganization({
        name: form.name.trim(),
        timezone: form.timezone,
        locale: form.locale.trim(),
        businessName: form.businessName.trim() || null,
      });
      setOrg(updated);
      setSaved(true);
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <TabLoading label="Loading organization settings…" />;
  }

  return (
    <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', fontFamily: FONT }}>
      <div style={{ maxWidth: 640 }}>
        <h1 style={h1}>Organization</h1>
        <p style={sub}>Workspace profile and regional defaults. Changes apply to the whole team.</p>

        {error && <Alert>{error}</Alert>}
        {saved && <div style={{ ...alertOk }}>Saved.</div>}

        <Field label="Workspace name">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} disabled={!canEdit} style={inp(!canEdit)} />
        </Field>
        <Field label="Business name (optional)">
          <input value={form.businessName} onChange={e => setForm(f => ({ ...f, businessName: e.target.value }))} disabled={!canEdit} placeholder="Legal or trading name" style={inp(!canEdit)} />
        </Field>
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Timezone">
            <select value={form.timezone} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))} disabled={!canEdit} style={inp(!canEdit)}>
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
          <Field label="Locale">
            <input value={form.locale} onChange={e => setForm(f => ({ ...f, locale: e.target.value }))} disabled={!canEdit} placeholder="en" style={inp(!canEdit)} />
          </Field>
        </div>

        {!canEdit && (
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>
            You have a {org?.role || 'member'} role — only owners and admins can edit organization settings.
          </div>
        )}
        {canEdit && (
          <button onClick={handleSave} disabled={saving} style={primaryBtn(saving)}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        )}

        {/* Real WhatsApp configuration status (same source as onboarding) */}
        <div style={{ marginTop: 32 }}>
          <div style={sectionTitle}>WhatsApp status</div>
          <div style={{ fontSize: 13, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Building2 size={14} color={C.textMuted} />
            <strong>{waStatusLabel(wa?.status)}</strong>
            <span style={{ color: C.textMuted }}>— {wa?.detail || 'Status unavailable.'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function waStatusLabel(s) {
  switch (s) {
    case 'connected': return 'Connected';
    case 'verification-pending': return 'Verification pending';
    case 'incomplete': return 'Configuration incomplete';
    case 'error': return 'Error';
    case 'not-configured': return 'Not configured';
    default: return 'Unknown';
  }
}

export function TabLoading({ label }) {
  return (
    <div style={{ flex: 1, padding: 40, textAlign: 'center', color: C.textMuted, fontFamily: FONT, fontSize: 13 }}>
      <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} /> {label}
    </div>
  );
}

export function Alert({ children }) {
  return (
    <div role="alert" style={{ marginBottom: 14, fontSize: 13, color: '#A32D2D', background: '#FDECEC', border: '1px solid #F5C2C2', borderRadius: 8, padding: '10px 12px' }}>
      {children}
    </div>
  );
}

export const alertOk = { marginBottom: 14, fontSize: 13, color: '#166534', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '10px 12px' };

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16, flex: 1 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{label}</div>
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

const primaryBtn = (busy) => ({
  marginTop: 8, height: 38, borderRadius: 8, padding: '0 18px', background: C.primary,
  color: '#fff', border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
  fontSize: 13, fontWeight: 700, fontFamily: FONT, opacity: busy ? 0.7 : 1,
});
