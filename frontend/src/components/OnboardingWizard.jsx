// Green Pilot onboarding wizard (Phase 12).
//
// Server-driven: every step's completion comes from GET /v1/settings/overview
// (real backend state), never from localStorage or a bare "Continue" click.
// Completion is persisted server-side via POST /v1/settings/onboarding/complete
// and only succeeds when required setup is actually done.
//
// Steps (only capabilities the product supports):
//   Organization → WhatsApp → Team → AI → Automation → Complete
// whatsapp/team/ai/automation are discoverable-but-optional; the wizard never
// forces workflow creation during onboarding.

import { useState, useEffect, useCallback } from 'react';
import { Check } from 'lucide-react';
import { api, getActiveOrgId, setActiveOrgId } from '../api.js';
import { friendlyApiError } from '../utils/apiError.js';
import { C, FONT } from '../constants.js';
import MetaWhatsAppConnect from './MetaWhatsAppConnect.jsx';

const STEP_ORDER = ['organization', 'whatsapp', 'team', 'ai', 'automation', 'complete'];

const STEP_META = {
  organization: { title: 'Organization', hint: 'Name your workspace and set timezone basics.' },
  whatsapp: { title: 'WhatsApp', hint: 'Connect a WhatsApp Business number to receive leads.' },
  team: { title: 'Team', hint: 'Invite teammates with secure email invitations.' },
  ai: { title: 'AI qualification', hint: 'Review AI entitlement and usage for your plan.' },
  automation: { title: 'Automation', hint: 'Discover workflows — creating one now is optional.' },
  complete: { title: 'Complete', hint: 'Finish onboarding once required setup is done.' },
};

function newIdemKey() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `org-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function OnboardingWizard({ onComplete, onNavigate }) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeStep, setActiveStep] = useState('organization');
  const [busy, setBusy] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteResult, setInviteResult] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const ov = await api.settings.overview();
      setOverview(ov);
      if (ov?.organization?.id && String(ov.organization.id) !== String(getActiveOrgId())) {
        setActiveOrgId(ov.organization.id);
      }
      if (ov?.onboarding?.completed) {
        onComplete?.();
        return;
      }
      // Advance to the first incomplete non-complete step.
      const derived = ov?.onboarding?.derived?.steps || {};
      const firstOpen = STEP_ORDER.find(s => s !== 'complete' && derived[s]?.status !== 'complete');
      if (firstOpen) setActiveStep(firstOpen);
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setLoading(false);
    }
  }, [onComplete]);

  useEffect(() => { refresh(); }, [refresh]);

  // Ensure usable CRM state exists (idempotent — safe on every load).
  useEffect(() => {
    api.pipelines.initDefault().catch(() => {});
  }, []);

  const handleCreateOrg = async () => {
    const name = orgName.trim();
    if (!name) { setError('Give your workspace a name first.'); return; }
    setBusy(true);
    setError('');
    try {
      const org = await api.orgs.create({ name }, { idempotencyKey: newIdemKey() });
      if (org?.id) setActiveOrgId(org.id);
      setOrgName('');
      await refresh();
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleInvite = async () => {
    const orgId = overview?.organization?.id || getActiveOrgId();
    if (!orgId) { setError('Create your organization first.'); return; }
    if (!inviteEmail.trim()) { setError('Enter a teammate email address.'); return; }
    setBusy(true);
    setError('');
    setInviteResult(null);
    try {
      const inv = await api.invitations.create(orgId, { email: inviteEmail.trim(), role: inviteRole });
      setInviteResult(inv);
      setInviteEmail('');
      await refresh();
    } catch (err) {
      setError(friendlyApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async () => {
    setBusy(true);
    setError('');
    try {
      await api.settings.completeOnboarding();
      onComplete?.();
    } catch (err) {
      setError(friendlyApiError(err));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <Centered>
        <div style={{ fontSize: 13, color: C.textMuted, fontFamily: FONT }}>Loading your workspace…</div>
      </Centered>
    );
  }

  const derived = overview?.onboarding?.derived?.steps || {};
  const org = overview?.organization || null;

  return (
    <Centered>
      <div style={{ width: '100%', maxWidth: 640, background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28, fontFamily: FONT }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>Set up Green Pilot</div>
        <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
          {org ? `Workspace: ${org.name}` : 'Create your workspace to begin.'}
        </div>

        {error && (
          <div role="alert" style={{ marginTop: 14, fontSize: 13, color: '#A32D2D', background: '#FDECEC', border: '1px solid #F5C2C2', borderRadius: 8, padding: '10px 12px' }}>
            {error}
          </div>
        )}

        {/* Step list with REAL backend status */}
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {STEP_ORDER.map(id => {
            const st = derived[id]?.status || 'pending';
            const selected = activeStep === id;
            return (
              <button
                key={id}
                onClick={() => setActiveStep(id)}
                style={{
                  textAlign: 'left', borderRadius: 10, padding: '10px 12px',
                  border: `1.5px solid ${selected ? C.primary : C.border}`,
                  background: selected ? C.headerSurface : 'transparent',
                  cursor: 'pointer', fontFamily: FONT,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StatusDot status={st} />
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{STEP_META[id].title}</span>
                  <span style={{ fontSize: 12, color: C.textMuted }}>{st === 'complete' ? 'Done' : st === 'in-progress' ? 'In progress' : 'To do'}</span>
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                  {derived[id]?.detail || STEP_META[id].hint}
                </div>
              </button>
            );
          })}
        </div>

        {/* Per-step actions */}
        <div style={{ marginTop: 18 }}>
          {activeStep === 'organization' && !org && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                placeholder="Workspace name (e.g. Acme Gardens)"
                style={inputStyle}
              />
              <button onClick={handleCreateOrg} disabled={busy} style={primaryBtn}>
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          )}
          {activeStep === 'whatsapp' && (
            <div>
              {derived.whatsapp?.status === 'complete' ? (
                <div>
                  <div style={{
                    background: 'rgba(34, 197, 94, 0.08)',
                    border: '1px solid rgba(34, 197, 94, 0.25)',
                    borderRadius: 10,
                    padding: '16px 20px',
                    marginBottom: 16,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#16a34a', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
                      <Check size={18} />
                      <span>WhatsApp connected</span>
                    </div>
                    <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>
                      <div><strong>Status:</strong> <span style={{ color: '#16a34a', fontWeight: 600 }}>Connected</span></div>
                      <div><strong>Detail:</strong> {derived.whatsapp?.detail || 'WhatsApp Business account connected'}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveStep('team')}
                    style={primaryBtn}
                  >
                    Continue
                  </button>
                </div>
              ) : (
                <div style={{ maxWidth: 460 }}>
                  <h4 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700, color: C.text }}>
                    Connect your WhatsApp Business
                  </h4>
                  <p style={{ margin: '0 0 16px', fontSize: 13, color: C.textSecondary, lineHeight: 1.4 }}>
                    Connect your business WhatsApp account directly through Meta.
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <MetaWhatsAppConnect
                      buttonText="Continue with Meta"
                      onConnected={async () => {
                        await refresh();
                        setActiveStep('team');
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setActiveStep('team')}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: C.textSecondary,
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                        padding: '8px 12px',
                        fontFamily: FONT,
                      }}
                    >
                      Skip for now
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {activeStep === 'team' && (
            <div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  style={inputStyle}
                />
                <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} style={inputStyle}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button onClick={handleInvite} disabled={busy} style={primaryBtn}>
                  {busy ? 'Inviting…' : 'Invite'}
                </button>
              </div>
              {inviteResult?.token && (
                <div style={{ marginTop: 8, fontSize: 12, color: C.textMuted }}>
                  Invitation created for {inviteResult.email}. Share this one-time link: <code>{`${window.location.origin}${window.location.pathname}#/invite/${inviteResult.token}`}</code>
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: 12, color: C.textMuted }}>
                Team size: {overview?.team?.size ?? 1}. Invitations expire in 7 days and are single-use.
              </div>
            </div>
          )}
          {activeStep === 'ai' && (
            <StepActions
              text={overview?.ai
                ? `AI entitlement: ${overview.ai.entitled ? 'enabled' : 'not enabled on your plan'} · ${overview.ai.used}/${overview.ai.granted} credits used.`
                : 'AI qualification status loads from your plan entitlement.'}
              label="Open AI settings"
              onGo={() => onNavigate?.('ai-agent-builder')}
            />
          )}
          {activeStep === 'automation' && (
            <StepActions
              text={`Automations configured: ${overview?.automation?.count ?? 0}. You can explore workflows now — creating one during onboarding is optional.`}
              label="Explore automations"
              onGo={() => onNavigate?.('chatbot-builder')}
            />
          )}
          {activeStep === 'complete' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={handleFinish} disabled={busy} style={primaryBtn}>
                {busy ? 'Checking…' : 'Finish setup'}
              </button>
              <span style={{ fontSize: 12, color: C.textMuted }}>
                Finishing requires the mandatory setup to be genuinely complete.
              </span>
            </div>
          )}
        </div>

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between' }}>
          <button onClick={refresh} disabled={loading} style={ghostBtn}>Refresh status</button>
          <button onClick={() => onComplete?.()} style={ghostBtn}>Skip for now</button>
        </div>
      </div>
    </Centered>
  );
}

function StepActions({ text, label, onGo }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: C.textMuted, flex: 1, minWidth: 220 }}>{text}</span>
      <button onClick={onGo} style={primaryBtn}>{label}</button>
    </div>
  );
}

function StatusDot({ status }) {
  const color = status === 'complete' ? '#16A34A' : status === 'in-progress' ? '#EAB308' : '#CBD5E1';
  return <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />;
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.pageBg, padding: 20 }}>
      {children}
    </div>
  );
}

const inputStyle = {
  flex: 1, height: 38, borderRadius: 8, border: `1.5px solid ${C.border}`,
  padding: '0 12px', fontSize: 13, fontFamily: FONT, background: '#fff', color: C.text,
};

const primaryBtn = {
  height: 38, borderRadius: 8, padding: '0 16px', background: C.primary,
  color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT,
  whiteSpace: 'nowrap',
};

const ghostBtn = {
  height: 34, borderRadius: 8, padding: '0 14px', background: 'transparent',
  color: C.textMuted, border: `1px solid ${C.border}`, cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: FONT,
};
