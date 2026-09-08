// Razorpay provider boundary (Phase 8).
//
// Architecture: Frontend → Green Pilot backend → Razorpay. The secret
// (KEY_SECRET / webhook secret) NEVER leaves this module: only the public
// KEY_ID is returned to the client (required by checkout.js), signatures are
// verified here with timing-safe comparison, and provider errors are mapped to
// generic messages (the raw provider body, which can echo credentials-adjacent
// data, is logged server-side truncated, never forwarded).
//
// Verification is pure HMAC-SHA256 and needs no network:
//   payment:  HMAC(key_secret, order_id + '|' + payment_id)
//   webhook:  HMAC(webhook_secret, raw_body)

const crypto = require('crypto');
const { BillingError } = require('./subscriptions');

const ORDERS_API = 'https://api.razorpay.com/v1/orders';

function keyId() {
  return process.env.RAZORPAY_KEY_ID || null;
}

function keySecret() {
  return process.env.RAZORPAY_KEY_SECRET || null;
}

function webhookSecret() {
  return process.env.RAZORPAY_WEBHOOK_SECRET || null;
}

function isConfigured() {
  return !!(keyId() && keySecret());
}

function publicKey() {
  return keyId();
}

function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// Server-side payment signature check (checkout handler callback proves
// NOTHING until this passes).
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const secret = keySecret();
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

// Webhook authenticity over the EXACT raw bytes (see index.js rawBody capture).
function verifyWebhookSignature(rawBody, signature) {
  const secret = webhookSecret();
  if (!secret || !rawBody || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return safeEqualHex(expected, signature);
}

// Create a Razorpay order server-side. Amount/currency/receipt are
// server-resolved (routes pass the catalog values, never client values).
// `fetchImpl` is injectable so tests never touch the network.
/**
 * @param {{amountPaise: number, currency?: string, receipt: string, notes?: Record<string,string>}} order
 * @param {{fetchImpl?: Function}} [deps]
 */
async function createProviderOrder({ amountPaise, currency, receipt, notes }, { fetchImpl } = {}) {
  if (!isConfigured()) {
    throw new BillingError('Billing provider is not configured', 503, 'billing-unavailable');
  }
  if (!Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new Error('Invalid order amount');
  }
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    const basic = Buffer.from(`${keyId()}:${keySecret()}`).toString('base64');
    res = await doFetch(ORDERS_API, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: currency || 'INR',
        receipt,
        notes: notes || {},
      }),
    });
  } catch {
    throw new BillingError('Payment provider unreachable, try again', 502, 'provider-unreachable');
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || !body.id) {
    console.error('[billing] provider order failed:', res.status, JSON.stringify(body).slice(0, 300));
    throw new BillingError('Payment order could not be created', 502, 'provider-order-failed');
  }
  return { providerOrderId: body.id, amountPaise: body.amount, currency: body.currency };
}

module.exports = {
  isConfigured,
  publicKey,
  verifyPaymentSignature,
  verifyWebhookSignature,
  createProviderOrder,
};
