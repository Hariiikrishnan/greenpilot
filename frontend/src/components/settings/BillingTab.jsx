// Green Pilot Billing tab (Phase 8) — real APIs only, no fake success.
//
// Data source of truth is always the backend (GET /billing/status, /plans).
// No payment state is kept in localStorage: a dismissed modal or a stale tab
// simply re-reads server state on next load. Every state change (upgrade,
// verify, cancel) round-trips through the server; the Razorpay handler
// callback proves NOTHING until POST /verify-payment succeeds.

import { useState, useEffect, useCallback } from 'react';
import { CreditCard, Check, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT } from '../../constants.js';

const CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';

let checkoutPromise = null;
export function loadRazorpayCheckout() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.Razorpay) return Promise.resolve();
  if (checkoutPromise) return checkoutPromise;
  checkoutPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_JS;
    script.async = true;
    script.onload = () => {
      if (window.Razorpay) resolve();
      else {
        checkoutPromise = null;
        reject(new Error('Payment SDK failed to load'));
      }
    };
    script.onerror = () => {
      checkoutPromise = null;
      reject(new Error('Payment SDK failed to load'));
    };
    document.body.appendChild(script);
  });
  return checkoutPromise;
}

function formatPaise(paise, currency = 'INR') {
  const n = (Number(paise) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

function StateBadge({ state }) {
  const ok = state === 'active' || state === 'trialing';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 999,
      fontSize: 12, fontWeight: 700, fontFamily: FONT,
      background: ok ? '#ECFDF5' : '#FEF2F2',
      color: ok ? '#047857' : '#B91C1C',
    }}>
      {state}
    </span>
  );
}

export default function BillingTab() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [plans, setPlans] = useState([]);
  const [pricingFinalized, setPricingFinalized] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [payingPlan, setPayingPlan] = useState(null);

  const refresh = useCallback(async () => {
    // NOTE: does not clear error/notice — callers own their messages, so a
    // post-verify refresh never wipes the success/failure banner it follows.
    try {
      const [s, p] = await Promise.all([api.billing.status(), api.billing.plans()]);
      setStatus(s);
      setPlans(Array.isArray(p?.plans) ? p.plans : []);
      setPricingFinalized(p?.pricingFinalized !== false ? !!p?.pricingFinalized : false);
    } catch (err) {
      setError(`Could not load billing: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const upgrade = async (plan) => {
    setError('');
    setNotice('');
    setPayingPlan(plan.id);
    try {
      const order = await api.billing.createOrder(plan.id);
      await loadRazorpayCheckout();
      const rzp = new window.Razorpay({
        key: order.publicKey,
        order_id: order.providerOrderId,
        amount: order.amountPaise,
        currency: order.currency,
        name: 'Green Pilot',
        description: `${plan.name} plan`,
        modal: {
          // Dismissed without paying: nothing changed server-side (the order
          // stays `created`); re-read state so the UI never goes stale.
          ondismiss: async () => {
            setNotice('Payment window closed — no charge was confirmed. Safe to retry.');
            await refresh();
          },
        },
        handler: async (resp) => {
          try {
            const result = await api.billing.verifyPayment({
              providerOrderId: order.providerOrderId,
              providerPaymentId: resp.razorpay_payment_id,
              signature: resp.razorpay_signature,
            });
            setNotice(result.alreadyProcessed
              ? 'Payment was already processed — subscription is current.'
              : 'Payment verified — subscription is active.');
          } catch (vErr) {
            setError(`Payment could not be verified yet (${vErr.message}). If charged, the webhook will converge it — refresh shortly.`);
          } finally {
            await refresh();
          }
        },
      });
      rzp.on('payment.failed', async () => {
        setError('The payment failed — no subscription change was made.');
        await refresh();
      });
      rzp.open();
    } catch (err) {
      setError(`Could not start payment: ${err.message}`);
    } finally {
      setPayingPlan(null);
    }
  };

  const cancel = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Cancel the subscription? Access ends immediately.')) return;
    setError('');
    setNotice('');
    try {
      await api.billing.cancel();
      setNotice('Subscription cancelled.');
      await refresh();
    } catch (err) {
      setError(`Cancel failed: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textMuted, fontSize: 14, fontFamily: FONT }}>
        <Loader2 size={16} style={{ marginRight: 8 }} /> Loading billing…
      </div>
    );
  }

  const usage = status?.usage || { granted: 0, used: 0, remaining: 0 };
  const usagePct = usage.granted > 0 ? Math.min(100, Math.round((usage.used / usage.granted) * 100)) : 0;
  const canManage = !!status?.canManageBilling;

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 24, fontFamily: FONT }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, margin: '0 0 4px' }}>Billing</h2>
      <p style={{ fontSize: 13, color: C.textMuted, margin: '0 0 16px' }}>
        Organization subscription, plans, and AI credit usage.
      </p>

      {error && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: '#FEF2F2', color: '#B91C1C', padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
          <AlertTriangle size={15} /> {error}
          <button onClick={() => { setError(''); refresh(); }} title="Retry" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', color: '#B91C1C' }}>
            <RefreshCw size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div style={{ background: '#ECFDF5', color: '#047857', padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
          {notice}
        </div>
      )}
      {!pricingFinalized && (
        <div style={{ background: '#FFFBEB', color: '#92400E', padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
          Plan prices are not yet finalized — amounts shown are placeholders.
        </div>
      )}

      {/* Current subscription */}
      <div style={{ background: 'var(--c-cardBg)', border: `1px solid ${C.borderDark}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <CreditCard size={18} color={C.text} />
          <strong style={{ fontSize: 15, color: C.text }}>{status?.planName || status?.plan || '—'}</strong>
          <StateBadge state={status?.state || 'unknown'} />
          {!status?.entitled && (
            <span style={{ fontSize: 12, color: '#B91C1C' }}>AI usage is paused until the subscription is current.</span>
          )}
        </div>
        <div style={{ fontSize: 13, color: C.textSecondary, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {status?.trialEndsAt && <span>Trial ends: {new Date(status.trialEndsAt).toLocaleString()}</span>}
          {status?.currentPeriodEnd && <span>Current period ends: {new Date(status.currentPeriodEnd).toLocaleString()}</span>}
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
            AI credits: {usage.used} used of {usage.granted} ({usage.remaining} remaining)
          </div>
          <div style={{ height: 8, borderRadius: 999, background: '#EEF2F5', overflow: 'hidden' }}>
            <div style={{ width: `${usagePct}%`, height: '100%', background: usagePct > 90 ? '#DC2626' : C.primary }} />
          </div>
        </div>
        {canManage && status?.state !== 'trialing' && status?.plan !== 'trial' && (
          <button
            onClick={cancel}
            style={{ marginTop: 12, border: `1px solid ${C.borderDark}`, background: 'transparent', borderRadius: 8, padding: '7px 14px', fontSize: 13, cursor: 'pointer', color: C.textSecondary, fontFamily: FONT }}
          >
            Cancel subscription
          </button>
        )}
        {!status?.providerConfigured && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.textMuted }}>
            Online payments are not configured for this workspace — contact your administrator.
          </div>
        )}
      </div>

      {/* Plans (server identities) */}
      <h3 style={{ fontSize: 14, fontWeight: 700, color: C.text, margin: '0 0 10px' }}>Plans</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {plans.map(p => {
          const isCurrent = p.id === status?.plan;
          return (
            <div key={p.id} style={{ background: 'var(--c-cardBg)', border: `1px solid ${isCurrent ? C.primary : C.borderDark}`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{p.name}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: '6px 0' }}>
                {formatPaise(p.pricePaise, p.currency)}
                {p.interval && <span style={{ fontSize: 12, fontWeight: 500, color: C.textMuted }}> /{p.interval}</span>}
              </div>
              <ul style={{ fontSize: 12, color: C.textSecondary, paddingLeft: 16, margin: '0 0 12px' }}>
                {(p.features || []).map(f => <li key={f}>{f}</li>)}
                <li>{p.aiCreditsPerCycle} AI credits{p.interval ? ` /${p.interval}` : ''}</li>
              </ul>
              {isCurrent ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#047857' }}>
                  <Check size={14} /> Current plan
                </span>
              ) : p.orderable && canManage && status?.providerConfigured ? (
                <button
                  onClick={() => upgrade(p)}
                  disabled={payingPlan === p.id}
                  style={{ border: 'none', background: C.primary, color: '#fff', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: payingPlan ? 'wait' : 'pointer', fontFamily: FONT }}
                >
                  {payingPlan === p.id ? 'Starting…' : `Upgrade to ${p.name}`}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {!canManage && (
        <p style={{ fontSize: 12, color: C.textMuted, marginTop: 12 }}>
          Only organization owners and admins can manage billing.
        </p>
      )}
    </div>
  );
}
