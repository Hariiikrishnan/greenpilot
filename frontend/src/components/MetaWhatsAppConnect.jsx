import { useState, useEffect } from 'react';
import { MessageSquare, Check, AlertCircle } from 'lucide-react';
import { api } from '../api.js';
import { friendlyApiError } from '../utils/apiError.js';
import { C, FONT } from '../constants.js';

export default function MetaWhatsAppConnect({ onConnected, buttonText = 'Continue with Meta' }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionData, setSessionData] = useState(null);

  useEffect(() => {
    // Listen for Meta Embedded Signup v4 session finish message events
    const messageListener = (event) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') {
        return;
      }
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data && data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH' && data.data) {
            setSessionData({
              wabaId: data.data.waba_id,
              phoneNumberId: data.data.phone_number_id,
            });
          } else if (data.event === 'CANCEL') {
            setLoading(false);
          }
        }
      } catch {
        // Non-JSON or unrelated messages
      }
    };

    window.addEventListener('message', messageListener);
    return () => window.removeEventListener('message', messageListener);
  }, []);

  const loadFbSdk = (appId, apiVersion) => {
    return new Promise((resolve) => {
      if (window.FB) {
        resolve(window.FB);
        return;
      }

      window.fbAsyncInit = function () {
        window.FB.init({
          appId,
          cookie: true,
          xfbml: true,
          version: apiVersion || 'v21.0',
        });
        resolve(window.FB);
      };

      if (!document.getElementById('facebook-jssdk')) {
        const script = document.createElement('script');
        script.id = 'facebook-jssdk';
        script.src = 'https://connect.facebook.net/en_US/sdk.js';
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    });
  };

  const handleConnectWithMeta = async () => {
    setLoading(true);
    setError('');

    try {
      // 1. Fetch tenant-bound signup configuration and state token
      const config = await api.whatsappAccounts.getEmbeddedSignupConfig();
      const appId = config.appId || import.meta.env.VITE_META_APP_ID;
      const configId = config.configId || import.meta.env.VITE_META_EMBEDDED_SIGNUP_CONFIG_ID;
      const apiVersion = config.apiVersion || 'v21.0';

      if (!appId) {
        setError('Meta App ID is not configured. Set META_APP_ID on backend or VITE_META_APP_ID on frontend.');
        setLoading(false);
        return;
      }

      // 2. Initialize Meta JavaScript SDK
      await loadFbSdk(appId, apiVersion);

      if (!window.FB) {
        setError('Unable to initialize Meta SDK. Please check your network or adblocker.');
        setLoading(false);
        return;
      }

      // 3. Launch Meta Embedded Signup v4 popup
      const loginOpts = {
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          feature: 'whatsapp_embedded_signup',
          version: 2,
          sessionInfoVersion: 3,
        },
      };

      if (configId) {
        loginOpts.config_id = configId;
      } else {
        loginOpts.scope = 'whatsapp_business_management,whatsapp_business_messaging';
      }

      window.FB.login((response) => {
        if (response.authResponse?.code) {
          const authCode = response.authResponse.code;
          (async () => {
            try {
              // 4. Send code, signed state, and session details to backend
              const res = await api.whatsappAccounts.completeEmbeddedSignup({
                code: authCode,
                wabaId: sessionData?.wabaId,
                phoneNumberId: sessionData?.phoneNumberId,
                state: config.state,
              });

              setLoading(false);
              if (onConnected) {
                onConnected(res.account);
              }
            } catch (err) {
              setError(friendlyApiError(err) || 'Failed to complete WhatsApp connection with Meta.');
              setLoading(false);
            }
          })();
        } else {
          setLoading(false);
          if (response.status !== 'unknown') {
            setError('Meta signup was not completed. Please try again.');
          }
        }
      }, loginOpts);
    } catch (err) {
      setError(friendlyApiError(err) || 'Failed to initialize WhatsApp Embedded Signup.');
      setLoading(false);
    }
  };

  return (
    <div>
      {error && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.08)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: 8,
          padding: '10px 14px',
          color: '#b91c1c',
          fontSize: 13,
          marginBottom: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: FONT,
        }}>
          <AlertCircle size={16} style={{ flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      <button
        type="button"
        onClick={handleConnectWithMeta}
        disabled={loading}
        style={{
          height: 44,
          padding: '0 24px',
          borderRadius: 10,
          border: 'none',
          background: '#1877F2',
          color: '#ffffff',
          fontSize: 14,
          fontWeight: 600,
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.7 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          fontFamily: FONT,
          boxShadow: '0 2px 4px rgba(24, 119, 242, 0.25)',
          transition: 'background .15s, opacity .15s',
        }}
        onMouseEnter={e => { if (!loading) e.currentTarget.style.background = '#166fe5'; }}
        onMouseLeave={e => { e.currentTarget.style.background = '#1877F2'; }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
        </svg>
        <span>{loading ? 'Opening Meta…' : buttonText}</span>
      </button>
    </div>
  );
}
