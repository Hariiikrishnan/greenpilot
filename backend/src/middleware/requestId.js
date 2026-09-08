// Request correlation IDs (Phase 13 observability).
//
// Assigns every request a short id (`req.id`), honors an incoming
// `X-Request-Id` when well-formed, and echoes it back so clients and logs can
// correlate. The id is safe to log (random, no PII).

const crypto = require('crypto');

function requestId(req, res, next) {
  const incoming = String(req.get('x-request-id') || '');
  const id = /^[A-Za-z0-9-]{1,64}$/.test(incoming)
    ? incoming
    : crypto.randomBytes(8).toString('hex');
  req.id = id;
  try { res.set('X-Request-Id', id); } catch { /* headers already sent */ }
  next();
}

module.exports = { requestId };
