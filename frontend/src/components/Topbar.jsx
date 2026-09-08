import { useState, useRef, useEffect } from 'react';
import { Info, LogOut, Settings, AlertTriangle, Building2, Check } from 'lucide-react';
import { C, FONT } from '../constants.js';
import { api, getActiveOrgId, setActiveOrgId } from '../api.js';
import { disconnectRealtime } from '../realtime/socketClient.js';

export default function Topbar({ user, onLogout, onNavigate }) {
  const [userOpen, setUserOpen] = useState(false);
  const [unhealthyAccounts, setUnhealthyAccounts] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [orgOpen, setOrgOpen] = useState(false);
  const orgRef = useRef(null);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setUserOpen(false);
      if (orgRef.current && !orgRef.current.contains(e.target)) setOrgOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Green Pilot organization context. The backend derives authority from
  // membership — this switcher only suggests context (X-Org-Id). Users with no
  // orgs yet (legacy single-owner installs) see no switcher.
  useEffect(() => {
    let cancelled = false;
    api.orgs.list()
      .then(list => {
        if (cancelled || !Array.isArray(list)) return;
        setOrgs(list);
        const active = getActiveOrgId();
        if (list.length > 0 && (!active || !list.some(o => String(o.id) === String(active)))) {
          setActiveOrgId(list[0].id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const activeOrg = orgs.find(o => String(o.id) === String(getActiveOrgId())) || orgs[0] || null;
  // Organization switching (Phase 12, Step 20): disconnect the realtime
  // socket FIRST so org A's rooms are left before joining org B, then set
  // the hint and hard-reload so every cached view (CRM, inbox, automation,
  // AI, billing) revalidates under the new membership. The server re-checks
  // membership on every request/reconnect — a forged id fails closed (403).
  const switchOrg = (id) => {
    try { disconnectRealtime(); } catch { /* ignore */ }
    setActiveOrgId(id);
    setOrgOpen(false);
    window.location.reload();
  };

  // Poll account health every 60s so the banner appears within a minute
  // of Meta rejecting a token. Cleared instantly when token is updated.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api.whatsappAccounts.list()
        .then(accs => { if (!cancelled) setUnhealthyAccounts(accs.filter(a => a.healthStatus === 'invalid_token')); })
        .catch(() => {});
    };
    check();
    const t = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <>
    {unhealthyAccounts.length > 0 && (
      <div
        onClick={() => onNavigate('admin-settings')}
        style={{
          background: '#A32D2D', color: '#fff', padding: '8px 16px',
          fontSize: 12, fontFamily: FONT, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8, cursor: 'pointer', fontWeight: 500,
        }}
      >
        <AlertTriangle size={14} />
        <span>
          Access token expired for {unhealthyAccounts.map(a => a.displayName).join(', ')} — click to update in Settings → WhatsApp Accounts
        </span>
      </div>
    )}
    <div style={{
      height: 56,
      background: C.headerBg,
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 0,
      paddingRight: 20,
      borderBottom: `1px solid ${C.headerBorder}`,
      flexShrink: 0,
      zIndex: 100,
      position: 'relative',
    }}>
      {/* Logo area — aligns with sidebar */}
      <button
        onClick={() => onNavigate('chats')}
        style={{
          width: 224,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 15,
          gap: 8,
          borderRight: `1px solid ${C.headerBorder}`,
          height: '100%',
          background: 'transparent',
          border: 'none',
          borderRightWidth: 1,
          borderRightStyle: 'solid',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <img
          src="/logo.svg"
          alt="Green Pilot"
          style={{ height: 32, width: 32, objectFit: 'contain', flexShrink: 0 }}
          onError={e => { e.currentTarget.style.display = 'none'; }}
        />
        <div style={{ lineHeight: 1.1 }}>
          <div style={{
            fontSize: 16,
            fontWeight: 900,
            color: C.headerText,
            fontFamily: FONT,
            letterSpacing: '-0.01em',
            textTransform: 'uppercase',
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}>
            GREEN
            <span style={{
              background: C.primary,
              color: '#fff',
              padding: '2px 7px',
              borderRadius: 6,
              lineHeight: 1.2,
              display: 'inline-block',
            }}>PILOT</span>
          </div>
        </div>
      </button>

      <div style={{ flex: 1 }} />

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Organization switcher (only when the user belongs to ≥1 org) */}
        {orgs.length > 0 && (
          <div ref={orgRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setOrgOpen(p => !p)}
              title={activeOrg ? `Workspace: ${activeOrg.name}` : 'Workspace'}
              style={{
                height: 36, borderRadius: 9, padding: '0 12px',
                background: C.headerSurface, border: `1.5px solid ${C.headerBorder}`,
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7,
                color: C.headerText, fontFamily: FONT, fontSize: 13, fontWeight: 600,
                maxWidth: 220,
              }}
            >
              <Building2 size={15} color={C.headerText} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeOrg ? activeOrg.name : 'Workspace'}
              </span>
            </button>
            {orgOpen && orgs.length > 1 && (
              <div style={{
                position: 'absolute', top: 44, right: 0, background: C.cardBg,
                border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: C.shadowMd,
                padding: 6, minWidth: 200, zIndex: 200,
              }}>
                {orgs.map(o => {
                  const selected = activeOrg && String(o.id) === String(activeOrg.id);
                  return (
                    <button key={o.id} onClick={() => switchOrg(o.id)} style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 12px', borderRadius: 6, background: selected ? C.headerSurface : 'transparent',
                      border: 'none', cursor: 'pointer', color: C.text, fontSize: 13,
                      fontWeight: selected ? 700 : 500, fontFamily: FONT, textAlign: 'left',
                    }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.name}
                      </span>
                      {selected && <Check size={14} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* About Us */}
        <button
          onClick={() => onNavigate('about')}
          title="About Us"
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: C.headerSurface,
            border: `1.5px solid ${C.headerBorder}`,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
          <Info size={16} color={C.headerText} />
        </button>

        {/* User avatar */}
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setUserOpen(p => !p)}
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: 'linear-gradient(135deg, #534AB7, #7B72E0)',
              border: userOpen ? '2px solid #fff' : `1.5px solid ${C.headerBorder}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              fontFamily: FONT,
              transition: 'border .15s',
              padding: 0,
              overflow: 'hidden',
            }}
          >
            {(user.displayName || user.username).charAt(0).toUpperCase()}
          </button>

          {userOpen && (
            <div style={{
              position: 'absolute',
              top: 44,
              right: 0,
              background: C.cardBg,
              border: `1px solid ${C.border}`,
              borderRadius: 10,
              boxShadow: C.shadowMd,
              padding: 6,
              minWidth: 180,
              zIndex: 200,
            }}>
              <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
                  {user.displayName || user.username}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                  {user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : ''}
                  {activeOrg ? ` · ${activeOrg.name}` : ''}
                </div>
              </div>
              <button
                onClick={() => { setUserOpen(false); onNavigate('admin-settings'); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.text,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: FONT,
                  marginBottom: 4,
                }}
              >
                <Settings size={14} />
                Settings
              </button>
              <button
                onClick={() => { setUserOpen(false); onLogout(); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: C.primary,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: FONT,
                }}
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
