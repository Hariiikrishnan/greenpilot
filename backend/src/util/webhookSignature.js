// Meta webhook signature + constant-time comparison helpers.
//
// Extracted so they can be unit-tested in isolation —
// requiring routes directly might pull in background queue side-effects.

const crypto = require('crypto');

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Computes standard Meta X-Hub-Signature-256 string (sha256=<hex>).
function computeMetaSignature(secret, rawBody) {
  if (!secret) return '';
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
  return 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

// Verify Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the App Secret).
// Returns true if valid, false if invalid, and null when META_APP_SECRET is unset.
function verifyMetaSignature(reqOrOpts) {
  let secret = process.env.META_APP_SECRET;
  let header = '';
  let raw = null;

  if (reqOrOpts && typeof reqOrOpts.get === 'function') {
    // Express request object
    header = reqOrOpts.get('x-hub-signature-256') || '';
    raw = reqOrOpts.rawBody;
  } else if (reqOrOpts && typeof reqOrOpts === 'object') {
    // Options object
    secret = reqOrOpts.appSecret || secret;
    header = reqOrOpts.signatureHeader || reqOrOpts.header || '';
    raw = reqOrOpts.rawBody;
  }

  if (!secret) return null; // not configured
  if (!header || !header.startsWith('sha256=') || !raw) return false;

  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length === 0) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { safeEqual, computeMetaSignature, verifyMetaSignature };

