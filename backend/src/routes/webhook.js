// Green Pilot — Central WhatsApp Webhook Controller
//
// Mounts:
// GET  /v1/webhooks/whatsapp          (canonical verification)
// POST /v1/webhooks/whatsapp          (canonical event delivery)
// GET  /v1/webhooks/whatsapp/:orgId   (tenant-scoped verification)
// POST /v1/webhooks/whatsapp/:orgId   (tenant-scoped event delivery)
// GET  /webhook/whatsapp              (legacy verification alias)
// POST /webhook/whatsapp              (legacy event delivery alias)
//
// Security:
// - GET verification validates hub.mode, hub.verify_token (constant-time compare)
// - POST event delivery validates X-Hub-Signature-256 HMAC over raw body
// - Never fail-open on missing or invalid signatures
// - Strictly isolates organizations using authoritative WhatsApp assets

const { Router } = require('express');
const pool = require('../db');
const { verifyMetaSignature } = require('../util/webhookSignature');
const {
  verifyWebhookSubscription,
  processWebhookEvent,
} = require('../services/whatsappWebhookIngestion');

const router = Router();

/**
 * GET webhook verification handler
 */
async function handleWebhookVerify(req, res, expectedOrgId = null) {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const result = await verifyWebhookSubscription({
    mode,
    verifyToken,
    challenge,
    expectedOrgId,
    db: pool,
  });

  if (result.ok) {
    console.log(`[webhook:verify] Meta verification accepted for ${expectedOrgId || 'global'}`);
    return res.status(200).type('text/plain').send(result.challenge);
  }

  return res.status(result.status || 403).json({ error: result.error || 'Verification failed' });
}

/**
 * POST webhook event delivery handler
 */
async function handleWebhookPost(req, res, expectedOrgId = null) {
  // 1. Validate X-Hub-Signature-256 HMAC
  const sig = verifyMetaSignature(req);

  if (sig === false) {
    if (process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true') {
      console.warn('[webhook] ALLOW_UNVERIFIED_WEBHOOKS=true — bypassing signature check for dev/test.');
    } else {
      console.warn(`[webhook] Invalid HMAC signature from ${req.ip || 'unknown'}`);
      return res.status(403).json({ error: 'Invalid webhook signature' });
    }
  }

  if (sig === null) {
    if (process.env.ALLOW_UNVERIFIED_WEBHOOKS !== 'true') {
      console.error('[webhook] REJECTED unverified inbound webhook: META_APP_SECRET is not configured');
      return res.status(403).json({ error: 'Webhook verification not configured' });
    }
    console.warn('[webhook] ALLOW_UNVERIFIED_WEBHOOKS=true — signature check bypassed.');
  }

  // 2. Validate expected organization if tenant-scoped URL
  if (expectedOrgId) {
    const { rows } = await pool.query('SELECT id FROM coexistence.organizations WHERE id = $1', [expectedOrgId]);
    if (!rows[0]) {
      return res.status(404).json({ error: 'Unknown webhook endpoint' });
    }
  }

  // 3. Process event through dedicated ingestion service
  try {
    const result = await processWebhookEvent({
      rawBody: req.rawBody,
      headers: req.headers,
      payload: req.body,
      expectedOrgId,
      remoteIp: req.ip,
      db: pool,
    });

    return res.status(result.status || 200).json(result);
  } catch (err) {
    console.error('[webhook] Ingestion error:', err.message);
    return res.status(200).json({ ok: false, error: 'Processing error' });
  }
}

// Canonical v1 routes
router.get('/v1/webhooks/whatsapp', (req, res) => handleWebhookVerify(req, res, null));
router.post('/v1/webhooks/whatsapp', (req, res) => handleWebhookPost(req, res, null));
router.get('/v1/webhooks/whatsapp/:orgId', (req, res) => handleWebhookVerify(req, res, req.params.orgId));
router.post('/v1/webhooks/whatsapp/:orgId', (req, res) => handleWebhookPost(req, res, req.params.orgId));

// Direct /webhooks/whatsapp routes (when mounted on /api/v1)
router.get('/webhooks/whatsapp', (req, res) => handleWebhookVerify(req, res, null));
router.post('/webhooks/whatsapp', (req, res) => handleWebhookPost(req, res, null));
router.get('/webhooks/whatsapp/:orgId', (req, res) => handleWebhookVerify(req, res, req.params.orgId));
router.post('/webhooks/whatsapp/:orgId', (req, res) => handleWebhookPost(req, res, req.params.orgId));

// Legacy compat routes
router.get('/webhook/whatsapp', (req, res) => handleWebhookVerify(req, res, null));
router.post('/webhook/whatsapp', (req, res) => handleWebhookPost(req, res, null));

module.exports = {
  router,
  handleWebhookVerify,
  handleWebhookPost,
  // Backward compatibility alias for legacy tests
  processWhatsappWebhook: handleWebhookPost,
};
