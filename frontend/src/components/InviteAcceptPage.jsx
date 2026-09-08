// Invitation acceptance page (Phase 12).
// Route: #/invite/<token>. The TOKEN establishes the organization context —
// any client-supplied org id is ignored server-side. Requires sign-in; the
// signed-in email must match the invitation.

import { useState, useEffect } from 'react';
import { api, setActiveOrgId } from '../api.js';
import { friendlyApiError } from '../utils/apiError.js';
import { C, FONT } from '../constants.js';

export default function InviteAcceptPage({ token, onAccepted, onNavigate }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.invitations.lookup(token)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(err => { if (!cancelled) setError(friendlyApiError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const handleAccept = async () => {
    setAccepting(true);
    setError('');
    try {
      const res = await api.invitations.accept(token);
      if (res?.organizationId) setActiveOrgId(res.organizationId);
      onAccepted?.(res);
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.pageBg, padding: 20, fontFamily: FONT }}>
      <div style={{ width: '100%', maxWidth: 480, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>Team invitation</div>
        {loading && <div style={{ marginTop: 12, fontSize: 13, color: C.textMuted }}>Checking invitation…</div>}
        {error && (
          <div role="alert" style={{ marginTop: 12, fontSize: 13, color: '#A32D2D', background: '#FDECEC', border: '1px solid #F5C2C2', borderRadius: 8, padding: '10px 12px' }}>
            {error}
          </div>
        )}
        {!loading && !error && preview && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 14, color: C.text }}>
              You are invited to join <strong>{preview.organizationName}</strong> as <strong>{preview.role}</strong>.
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>
              Sent to {preview.email} · expires {new Date(preview.expiresAt).toLocaleDateString()}
            </div>
            <button
              onClick={handleAccept}
              disabled={accepting}
              style={{ marginTop: 16, height: 38, borderRadius: 8, padding: '0 16px', background: C.primary, color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT }}
            >
              {accepting ? 'Joining…' : 'Accept invitation'}
            </button>
          </div>
        )}
        <button
          onClick={() => onNavigate('home')}
          style={{ marginTop: 16, background: 'none', border: 'none', color: C.textMuted, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: FONT }}
        >
          ← Back to dashboard
        </button>
      </div>
    </div>
  );
}
