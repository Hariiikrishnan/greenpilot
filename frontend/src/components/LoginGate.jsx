import { useState, useEffect } from 'react';
import { Lock, LogIn, Eye, EyeOff, UserPlus } from 'lucide-react';
import { api, setActiveOrgId } from '../api.js';
import { friendlyApiError } from '../utils/apiError.js';
import { C, FONT } from '../constants.js';

export default function LoginGate({ onLogin }) {
  const [mode, setMode] = useState('login'); // login | register
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGoogleCredentialResponse = async (response) => {
    if (!response || !response.credential) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.auth.google(response.credential);
      if (res?.organization?.id) setActiveOrgId(res.organization.id);
      const isFresh = res.onboarding ? !res.onboarding.completed : false;
      onLogin(res.user, { freshSignup: isFresh });
    } catch (err) {
      setError(friendlyApiError(err) || 'Google authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const scriptId = 'google-gsi-client';
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

    const initGsi = () => {
      if (window.google?.accounts?.id && clientId) {
        try {
          window.google.accounts.id.initialize({
            client_id: clientId,
            callback: handleGoogleCredentialResponse,
            auto_select: false,
            cancel_on_tap_outside: true,
          });
          const btnContainer = document.getElementById('google-signin-btn');
          if (btnContainer) {
            btnContainer.innerHTML = '';
            window.google.accounts.id.renderButton(btnContainer, {
              theme: 'outline',
              size: 'large',
              type: 'standard',
              text: 'continue_with',
              shape: 'rectangular',
              logo_alignment: 'left',
              width: 400,
            });
          }
        } catch (err) {
          console.warn('[google-auth] GSI init warning:', err);
        }
      }
    };

    if (!document.getElementById(scriptId)) {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = initGsi;
      document.head.appendChild(script);
    } else {
      initGsi();
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) { setError('Email and password required.'); return; }
    if (mode === 'register' && String(password).length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      if (mode === 'register') {
        const res = await api.auth.register({
          email, password,
          displayName: displayName.trim() || undefined,
          organizationName: orgName.trim() || undefined,
        });
        if (res?.organization?.id) setActiveOrgId(res.organization.id);
        onLogin(res.user, { freshSignup: true });
      } else {
        const { user } = await api.auth.login(email, password);
        onLogin(user);
      }
    } catch (err) {
      setError(friendlyApiError(err) || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      width: '100%',
      height: '100%',
      fontFamily: FONT,
    }}>
      {/* Left brand panel — fills full height */}
      <div className="login-brand-panel" style={{
        flex: 1,
        minWidth: 0,
        background: C.headerBg,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '48px 64px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Subtle radial accent */}
        <div style={{
          position: 'absolute',
          top: '-20%',
          right: '-10%',
          width: '60%',
          height: '60%',
          background: 'radial-gradient(circle, rgba(220,38,38,0.15) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute',
          bottom: '-20%',
          left: '-10%',
          width: '50%',
          height: '50%',
          background: 'radial-gradient(circle, rgba(83,74,183,0.12) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 480 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 40 }}>
            <img
              src="/logo.svg"
              alt="Green Pilot Logo"
              style={{ height: 56, width: 56, objectFit: 'contain', flexShrink: 0 }}
              onError={e => { e.currentTarget.style.display = 'none'; }}
            />
            <div style={{ lineHeight: 1.15 }}>
              <div style={{
                fontSize: 28,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                color: C.headerText,
              }}>
                Green<span style={{ color: C.primary }}>Pilot</span>
              </div>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.headerMuted,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                marginTop: 4,
              }}>
                WhatsApp CRM & Automation
              </div>
            </div>
          </div>

          <h1 style={{
            fontSize: 42,
            fontWeight: 800,
            color: C.headerText,
            letterSpacing: '-0.03em',
            lineHeight: 1.15,
            marginBottom: 20,
          }}>
            Manage conversations at scale
          </h1>
          <p style={{
            fontSize: 16,
            color: C.headerMuted,
            lineHeight: 1.6,
            marginBottom: 40,
          }}>
            Reply to WhatsApp chats, qualify leads with AI, build templates, send broadcasts, and automate responses — all from one place for your team.
          </p>

        </div>

        <div
          style={{
            position: 'absolute',
            bottom: 32,
            left: 64,
            fontSize: 10,
            fontWeight: 600,
            color: '#52525b',
            letterSpacing: '.06em',
            textTransform: 'uppercase',
          }}
        >
          GREEN PILOT <span style={{ color: C.primary }}>CRM</span>
        </div>
      </div>

      {/* Right form panel */}
      <div className="login-form-panel" style={{
        width: '100%',
        maxWidth: 540,
        minWidth: 360,
        background: C.pageBg,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '40px 48px',
        overflowY: 'auto',
      }}>
        <div style={{
          width: '100%',
          maxWidth: 400,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{
              fontSize: 12,
              fontWeight: 800,
              color: C.primary,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}>
              GREEN PILOT
            </span>
          </div>
          <h2 style={{
            fontSize: 24,
            fontWeight: 700,
            color: C.text,
            marginBottom: 6,
            letterSpacing: '-0.02em',
          }}>
            AI-powered lead conversion
          </h2>
          <p style={{
            fontSize: 13,
            color: C.textSecondary,
            marginBottom: 22,
            lineHeight: 1.4,
          }}>
            Sign in with Google to continue to your workspace
          </p>

          {/* Primary Authentication Action: Continue with Google */}
          <div style={{ marginBottom: 18 }}>
            <div id="google-signin-btn" style={{ minHeight: 44, display: 'flex', justifyContent: 'center' }} />
            {(!import.meta.env.VITE_GOOGLE_CLIENT_ID || !window.google?.accounts?.id) && (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  if (!import.meta.env.VITE_GOOGLE_CLIENT_ID) {
                    setError('Google OAuth Client ID is not configured. Set VITE_GOOGLE_CLIENT_ID in your frontend .env file.');
                  } else if (window.google?.accounts?.id) {
                    window.google.accounts.id.prompt();
                  } else {
                    setError('Google Sign-In service is loading. Please check your internet connection or adblocker.');
                  }
                }}
                style={{
                  width: '100%',
                  height: 44,
                  borderRadius: 10,
                  border: `1.5px solid ${C.border}`,
                  background: '#ffffff',
                  color: '#374151',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  fontFamily: FONT,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                  transition: 'border-color .15s, box-shadow .15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#9ca3af'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.616z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" />
                  <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.173 0 7.548 0 9s.347 2.827.957 4.039l3.007-2.332z" />
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" />
                </svg>
                Continue with Google
              </button>
            )}
          </div>

          {/* Secondary / Fallback: Divider */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            margin: '22px 0',
          }}>
            <div style={{ flex: 1, height: 1, background: C.border }} />
            <span style={{ fontSize: 12, color: C.textSecondary, fontWeight: 500 }}>
              or continue with email
            </span>
            <div style={{ flex: 1, height: 1, background: C.border }} />
          </div>

          <form onSubmit={handleSubmit}>
            {mode === 'register' && (
              <>
                <label style={{ display: 'block', marginBottom: 18 }}>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: C.textSecondary,
                    letterSpacing: '0.07em',
                    textTransform: 'uppercase',
                    marginBottom: 6,
                  }}>
                    Your name
                  </div>
                  <input
                    type="text"
                    placeholder="Adaeze Okafor"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    autoFocus
                    style={{
                      width: '100%',
                      padding: '11px 14px',
                      borderRadius: 10,
                      border: `1.5px solid ${C.border}`,
                      fontSize: 14,
                      fontFamily: FONT,
                      outline: 'none',
                      background: C.cardBg,
                      color: C.text,
                      transition: 'border .15s',
                    }}
                    onFocus={e => (e.target.style.borderColor = C.primary)}
                    onBlur={e => (e.target.style.borderColor = C.border)}
                  />
                </label>
                <label style={{ display: 'block', marginBottom: 18 }}>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: C.textSecondary,
                    letterSpacing: '0.07em',
                    textTransform: 'uppercase',
                    marginBottom: 6,
                  }}>
                    Workspace name
                  </div>
                  <input
                    type="text"
                    placeholder="Acme Gardens"
                    value={orgName}
                    onChange={e => setOrgName(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '11px 14px',
                      borderRadius: 10,
                      border: `1.5px solid ${C.border}`,
                      fontSize: 14,
                      fontFamily: FONT,
                      outline: 'none',
                      background: C.cardBg,
                      color: C.text,
                      transition: 'border .15s',
                    }}
                    onFocus={e => (e.target.style.borderColor = C.primary)}
                    onBlur={e => (e.target.style.borderColor = C.border)}
                  />
                </label>
              </>
            )}
            <label style={{ display: 'block', marginBottom: 18 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textSecondary,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}>
                Email
              </div>
              <input
                type="email"
                placeholder="admin@greenpilot.io"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
                style={{
                  width: '100%',
                  padding: '11px 14px',
                  borderRadius: 10,
                  border: `1.5px solid ${C.border}`,
                  fontSize: 14,
                  fontFamily: FONT,
                  outline: 'none',
                  background: C.cardBg,
                  color: C.text,
                  transition: 'border .15s',
                }}
                onFocus={e => (e.target.style.borderColor = C.primary)}
                onBlur={e => (e.target.style.borderColor = C.border)}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 24 }}>
              <div style={{
                fontSize: 11,
                fontWeight: 700,
                color: C.textSecondary,
                letterSpacing: '0.07em',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}>
                Password
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '11px 38px 11px 14px',
                    borderRadius: 10,
                    border: `1.5px solid ${C.border}`,
                    fontSize: 14,
                    fontFamily: FONT,
                    outline: 'none',
                    background: C.cardBg,
                    color: C.text,
                    transition: 'border .15s',
                  }}
                  onFocus={e => (e.target.style.borderColor = C.purple)}
                  onBlur={e => (e.target.style.borderColor = C.border)}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  style={{
                    position: 'absolute',
                    right: 12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: C.textSecondary,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            {error && (
              <div style={{
                background: C.primaryLight,
                color: '#A32D2D',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 13,
                marginBottom: 16,
                fontWeight: 500,
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: 10,
                border: 'none',
                background: C.primary,
                color: '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                fontFamily: FONT,
                transition: 'opacity .15s, background .15s',
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.background = C.primaryHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = C.primary; }}
            >
              <LogIn size={16} />
              {loading ? (mode === 'register' ? 'Creating…' : 'Signing in…') : (mode === 'register' ? 'Create account' : 'Sign in')}
            </button>
            <button
              type="button"
              onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(''); }}
              style={{
                width: '100%', marginTop: 12, background: 'none', border: 'none',
                color: C.primary, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
              }}
            >
              {mode === 'register' ? 'Already have an account? Sign in' : 'New to Green Pilot? Create an account'}
            </button>
          </form>
        </div>
      </div>

      {/* Responsive: hide brand panel on small screens */}
      <style>{`
        @media (max-width: 900px) {
          .login-brand-panel { display: none !important; }
        }
        @media (max-width: 900px) {
          .login-form-panel { max-width: 100% !important; padding: 24px !important; }
        }
      `}</style>
    </div>
  );
}
