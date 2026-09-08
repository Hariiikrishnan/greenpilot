require('dotenv').config();
// Resolve/auto-generate JWT_SECRET + FORGECRM_ENCRYPTION_KEY into process.env
// BEFORE any module that reads them at require-time (./auth, crypto consumers).
require('./util/instanceSecrets').bootstrapSecrets();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const pool = require('./db');
const { router: authRouter, authMiddleware, ensureTables } = require('./auth');
const { router: messagesRouter } = require('./routes/messages');
const { router: chatsRouter } = require('./routes/chats');
const { router: webhookRouter } = require('./routes/webhook');
const { router: billingRouter, publicRouter: billingPublicRouter } = require('./routes/billing');
const { router: aiRouter } = require('./routes/ai');
const { router: automationsRouter } = require('./routes/automations');
const { router: leadsRouter } = require('./routes/leads');
const { router: crmRouter } = require('./routes/crm');
const { router: categoriesRouter } = require('./routes/categories');
const { router: contactFieldsRouter } = require('./routes/contactFields');
const { router: usersRouter } = require('./routes/users');
const { router: uploadsRouter, UPLOAD_DIR } = require('./routes/uploads');
const { router: templatesRouter, syncAllAccountTemplates } = require('./routes/templates');
const { router: broadcastsRouter } = require('./routes/broadcasts');
const { router: chatbotsRouter } = require('./routes/chatbots');
const { router: mediaRouter } = require('./routes/media');
const { router: mediaLibraryRouter } = require('./routes/mediaLibrary');
const mediaStorage = require('./util/pgStorage');
const { router: whatsappAccountsRouter } = require('./routes/whatsappAccounts');
const {
  router: googleIntegrationsRouter,
  publicRouter: googleIntegrationsPublicRouter,
} = require('./routes/googleIntegrations');
const { router: agentsRouter } = require('./routes/agents');
const { router: agentConversationRouter } = require('./routes/agentConversation');
const { router: aiModelsRouter } = require('./routes/aiModels');
const { router: organizationsRouter } = require('./routes/organizations');
const { router: invitationsRouter } = require('./routes/invitations');
const { router: settingsRouter } = require('./routes/settings');
const { resolveTenant } = require('./middleware/tenant');
const { router: eventsRouter } = require('./routes/events');
const { router: dashboardRouter } = require('./routes/dashboard');
const { router: pipelinesRouter } = require('./routes/pipelines');
const { adminRouter: mcpAdminRouter, apiRouter: mcpApiRouter, ensureMcpTables } = require('./routes/mcp');
const { mcpHttpHandler } = require('./mcpHttp');
const { startWorker: startMediaWorker, shutdown: shutdownMediaQueue } = require('./queue/mediaQueue');
const { startSendWorker, shutdownSendQueue } = require('./queue/sendQueue');
const { startAgentWorker, shutdownAgentQueue } = require('./queue/agentQueue');
const { startAutomationWorker, shutdownAutomationQueue } = require('./queue/automationQueue');
const { reconcileMessageStatuses } = require('./services/statusReconciler');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Phase 13: the app always runs behind a reverse proxy in production
// (Caddy → nginx → backend) and behind nginx in local compose. Trust only
// private/loopback proxies so req.ip (rate limiting, webhook audit) is the
// real client IP without trusting public X-Forwarded-For spoofs.
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

const ALLOWED_ORIGINS = [
  process.env.CORS_ORIGIN,
  ...String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  'http://localhost:5173',
].filter(Boolean);

// A local `docker compose up -d` serves the app at http://localhost:8080 (or a
// custom HTTP_PORT) behind a same-origin nginx proxy, so requests carry an
// Origin like http://localhost:8080 that won't match CORS_ORIGIN. Allow any
// localhost / 127.0.0.1 origin (any port) so the documented local install works
// out of the box without needing CORS_ORIGIN; production still restricts to the
// explicit CORS_ORIGIN domain. Safe because auth cookies are sameSite=strict.
const isLocalOrigin = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const CORS_DOMAIN = (process.env.CORS_ORIGIN || '').replace(/^https?:\/\//, '');

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", ...(CORS_DOMAIN ? [`wss://${CORS_DOMAIN}`] : [])],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || isLocalOrigin(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));

app.use(cookieParser());
const { requestId } = require('./middleware/requestId');
app.use(requestId);
// Capture the raw request body so the webhook route can verify Meta's
// X-Hub-Signature-256 HMAC over the exact bytes Meta signed.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Serve uploaded files statically
app.use('/uploads', express.static(UPLOAD_DIR));

// Rate limiting
// Phase 6: Meta webhook paths are exempt — HMAC signature already authenticates
// the caller; throttling Meta would cause message loss and subscription drops.
const isWebhookPath = (req) => {
  const p = req.path || '';
  return p.includes('/webhooks/whatsapp') || p === '/webhook/whatsapp';
};
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/ready' || isWebhookPath(req),
  keyGenerator: (req) => {
    try {
      const token = req.cookies?.forgecrm_token;
      if (token) {
        const decoded = require('jsonwebtoken').decode(token);
        if (decoded?.username) return `user:${decoded.username}`;
      }
    } catch { /* token undecodable — fall through to IP-based limiting */ }
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});
app.use(apiLimiter);

// Phase 13: strict brute-force/abuse limiter for credential and invite
// endpoints (per IP — correct behind trust-proxy above). Normal SaaS usage
// never hits 30 attempts / 15 min on these paths; stuffing scripts do.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`[abuse] auth rate-limit hit for ${req.ip} on ${req.originalUrl || req.path} (rid=${req.id || '-'})`);
    res.status(429).json({ error: 'Too many attempts, please try again later', code: 'rate-limited' });
  },
});
app.use([
  '/api/auth/login', '/api/auth/register', '/api/auth/setup', '/api/auth/google',
  '/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/setup', '/api/v1/auth/google',
  '/api/v1/invitations',
], authLimiter);

// Health check (liveness only — "is the process alive?"). Readiness
// ("can it serve traffic?") is /ready below and verifies dependencies.
app.get('/health', (req, res) => res.json({ ok: true }));

// Readiness probe (Phase 13): verifies Postgres + migration watermark +
// Redis without leaking internals (booleans only, no versions/URLs/errors).
// Load balancers / compose `healthcheck` should gate traffic on this.
app.get('/ready', async (req, res) => {
  const checks = { db: false, migrations: false, redis: false };
  try {
    await pool.query('SELECT 1');
    checks.db = true;
  } catch { /* stays false */ }
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.schema_migrations`
    );
    const fs = require('fs');
    let files = 0;
    try {
      const dir = require('./db/migrate').migrationsDir
        ? require('./db/migrate').migrationsDir()
        : null;
      if (dir && fs.existsSync(dir)) files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).length;
    } catch { /* ignore */ }
    checks.migrations = rows[0]?.n > 0 && (files === 0 || rows[0].n >= files);
  } catch { /* stays false */ }
  try {
    const { getRedisStatus } = require('./queue/redisHealth');
    checks.redis = await getRedisStatus();
  } catch { /* stays false */ }
  const ok = checks.db && checks.migrations && checks.redis;
  res.status(ok ? 200 : 503).json({ ok, checks });
});

// Public routes (Meta webhook — no auth)
app.use('/api', webhookRouter);
app.use('/api/v1', webhookRouter);
// Razorpay billing webhook — public, HMAC-verified inside the route.
app.use('/api', billingPublicRouter);
// Google OAuth callback is public: Google redirects the user's browser back
// here, and we re-derive the user from the signed `state` param (see
// routes/googleIntegrations.js). Everything else under /google-integrations is
// auth-required and mounted further down.
app.use('/api', googleIntegrationsPublicRouter);
// MCP API — authenticates via its OWN bearer middleware (not the JWT cookie)
app.use('/api/mcp/v1', mcpApiRouter);
// Remote (Streamable HTTP) MCP connector — key in the URL path, public.
app.all('/api/mcp/http/:key', mcpHttpHandler);

// Green Pilot API evolution: canonical routes live under /api/v1; legacy /api
// routes are kept as compat and tagged so clients can migrate. Removal plan:
// PHASE5_API_EVOLUTION_MAP.md (provisional legacy sunset below).
const LEGACY_SUNSET = 'Sun, 01 Aug 2027 00:00:00 GMT';
function legacyCompat(req, res, next) {
  req.apiVersion = 'legacy';
  res.set('Deprecation', 'true');
  res.set('Sunset', LEGACY_SUNSET);
  next();
}
function v1Marker(req, res, next) {
  req.apiVersion = 'v1';
  next();
}

// Auth routes (public)
app.use('/api', authRouter);
app.use('/api/v1', authRouter);

// Authenticated zone: identity, then organization context, for both API generations.
app.use('/api', authMiddleware, resolveTenant, legacyCompat);
app.use('/api/v1', authMiddleware, resolveTenant, v1Marker);

// Protected routes — mounted once per API generation (same handlers).
const protectedRouters = [
  messagesRouter, chatsRouter, categoriesRouter, contactFieldsRouter, usersRouter,
  uploadsRouter, templatesRouter, broadcastsRouter, chatbotsRouter,
  mediaRouter, mediaLibraryRouter, whatsappAccountsRouter,
  googleIntegrationsRouter, agentsRouter, agentConversationRouter,
  mcpAdminRouter, aiModelsRouter, eventsRouter, dashboardRouter,
  pipelinesRouter, organizationsRouter, invitationsRouter, settingsRouter, billingRouter, aiRouter, automationsRouter,
  leadsRouter, crmRouter,
];
for (const r of protectedRouters) {
  app.use('/api', r);
  app.use('/api/v1', r);
}

// Error handler. Tenant/auth middleware raise HttpErrors with explicit status
// (403/400) — honor them; everything else masks to 500 in production.
// Never leaks stacks, SQL, paths, or secrets: 5xx collapses to a static
// message; details stay server-side tagged with the request id.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = (err && err.status >= 400 && err.status < 600) ? err.status : 500;
  const rid = req.id || '-';
  // Full error (with stack) in dev for debugging; message-only in production.
  if (process.env.NODE_ENV !== 'production') console.error(`[Error rid=${rid}]`, err);
  else console.error(`[Error rid=${rid}] ${req.method} ${req.path} → ${status}: ${err.message}`);
  if (status === 500) return res.status(500).json({ error: 'Internal server error', requestId: rid });
  res.status(status).json({ error: err.message || 'Request failed', code: err.code });
});

// Start server
async function start() {
  // Phase 13 production contract: fail fast when required production config
  // is missing instead of booting half-alive. Development/test warn only.
  // (Full contract: PHASE13_PRODUCTION_ENV_CONTRACT.md.)
  const isProd = process.env.NODE_ENV === 'production';
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.REDIS_URL) missing.push('REDIS_URL');
  if (!process.env.CORS_ORIGIN) missing.push('CORS_ORIGIN');
  if (missing.length > 0) {
    const msg = `[boot] missing required environment: ${missing.join(', ')}`;
    if (isProd) throw new Error(`${msg} (refusing to start in production)`);
    console.warn(`${msg} — continuing with development defaults (NOT for production)`);
  }
  if (!process.env.META_APP_SECRET) {
    console.warn('[boot] META_APP_SECRET is not set — inbound webhooks will be REJECTED (fail-closed). Set it, or ALLOW_UNVERIFIED_WEBHOOKS=true for local dev only.');
  }

  // Apply any pending SQL migrations before touching the schema or serving.
  await require('./db/migrate').runMigrations(pool);
  await ensureTables();
  await ensureMcpTables().catch(err =>
    console.error('[mcp] table ensure failed (apply migration 057):', err.message)
  );
  mediaStorage.ensureBucket().catch(err =>
    console.error('[media-storage] table ensure failed (will retry on first upload):', err.message)
  );
  startMediaWorker();
  startSendWorker();
  startAgentWorker();
  startAutomationWorker();

  // Self-healing delivery/read ticks: re-derive each outbound message's true
  // status from the stored webhook receipts and upgrade any chat_history row
  // that's behind (monotonic). On boot we sweep a wider 7-day window to backfill
  // anything missed while the process was down; then every 60s a cheap 2-day pass.
  reconcileMessageStatuses({ windowDays: 7 })
    .then(n => { if (n > 0) console.log(`[status-reconcile] boot: fixed ${n} tick(s)`); })
    .catch(err => console.error('[status-reconcile] boot error:', err.message));
  setInterval(async () => {
    try {
      const n = await reconcileMessageStatuses({ windowDays: 2 });
      if (n > 0) console.log(`[status-reconcile] fixed ${n} tick(s)`);
    } catch (err) {
      console.error('[status-reconcile] error:', err.message);
    }
  }, 60 * 1000).unref();

  // Stale-pause sweeper: mark paused automation executions that have outlived
  // their expires_at as error. Resume already inline-checks expires_at, so
  // this is purely hygiene against forever-paused rows accumulating.
  setInterval(async () => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Paused execution expired (no reply within timeout)',
                completed_at=NOW()
          WHERE status='paused' AND expires_at < NOW()`
      );
      if (rowCount > 0) console.log(`[sweeper] expired ${rowCount} paused execution(s)`);

      // Reap orphaned 'running' executions: the engine runs synchronously and
      // finishes in ms, so anything 'running' for >15m means the process died
      // mid-walk (e.g. a restart) and the status was never updated to error.
      const { rowCount: orphans } = await pool.query(
        `UPDATE coexistence.automation_executions
            SET status='error',
                error_message='Execution interrupted (no completion within 15 minutes)',
                completed_at=NOW()
          WHERE status='running' AND started_at < NOW() - INTERVAL '15 minutes'`
      );
      if (orphans > 0) console.log(`[sweeper] reaped ${orphans} orphaned running execution(s)`);
    } catch (err) {
      console.error('[sweeper] error:', err.message);
    }
  }, 30 * 60 * 1000).unref();

  // Agent close-summary sweeper: when an idle-summary agent's conversation goes
  // quiet (no new message for its idle window) and no human has taken over, ask
  // the agent to write its final summary to the sheet/CRM. Every 2 min.
  const { sweepClosedConversations } = require('./services/agentCloseSummary');
  setInterval(() => {
    sweepClosedConversations()
      .then(n => { if (n > 0) console.log(`[closeSummary] summarised ${n} closed conversation(s)`); })
      .catch(err => console.error('[closeSummary] sweep error:', err.message));
  }, 2 * 60 * 1000).unref();

  // Phase 10 follow-up due sweeper: claims pending follow-ups whose due_at
  // passed and emits followup.due automation events (idempotent per row).
  // Every 60s; cheap indexed query, silent when nothing is due.
  const { sweepDueFollowups } = require('./automation/service');
  setInterval(() => {
    sweepDueFollowups(pool)
      .then(r => { if (r.claimed > 0) console.log(`[followups] claimed ${r.claimed}, automation-matched ${r.emitted}`); })
      .catch(err => console.error('[followups] sweep error:', err.message));
  }, 60 * 1000).unref();

  // Template status auto-sync: Meta does NOT push template approval/rejection
  // status — we must poll. The tick fires every 10 min but only calls Meta while
  // at least one template is still awaiting review (status='SUBMITTED'). Once all
  // are resolved (approved/rejected/etc.) it idles with zero Meta calls, and
  // auto-resumes when a new template is submitted. Override interval with
  // TEMPLATE_SYNC_INTERVAL_MS.
  const TEMPLATE_SYNC_MS = parseInt(process.env.TEMPLATE_SYNC_INTERVAL_MS || '', 10) || 10 * 60 * 1000;
  const runTemplateSync = async () => {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS pending FROM coexistence.message_templates WHERE status = 'SUBMITTED'`
      );
      const pending = rows[0]?.pending || 0;
      if (pending === 0) return; // all resolved → skip Meta entirely (idle)
      const r = await syncAllAccountTemplates();
      if (r.totalUpdated > 0) {
        console.log(`[template-sync] ${pending} pending → updated ${r.totalUpdated} template(s)`);
      }
    } catch (err) {
      console.error('[template-sync] error:', err.message);
    }
  };
  setTimeout(runTemplateSync, 60 * 1000).unref();        // initial catch-up ~1 min after startup
  setInterval(runTemplateSync, TEMPLATE_SYNC_MS).unref(); // every 10 min (gated by pending count)

  const server = require('http').createServer(app);

  // Phase 7 canonical realtime: authenticated, organization-scoped Socket.IO.
  // Attached to the same HTTP server so cookies/CORS policy stay unified.
  // Best-effort at boot — HTTP serves even if the realtime layer fails.
  try {
    require('./realtime/socket').initRealtime(server);
    console.log('[Green Pilot] Socket.IO realtime attached (org-scoped rooms)');
  } catch (err) {
    console.error('[socket] realtime attach failed (HTTP continues):', err.message);
  }

  server.listen(PORT, () => {
    console.log(`[Green Pilot] Backend running on port ${PORT}`);
    // Phase 13 startup banner: environment + build + integrations (booleans
    // ONLY — never secrets, URLs, or keys).
    try {
      const pkg = require('../package.json');
      const { isConfigured: razorpayConfigured } = require('./billing/razorpay');
      console.log(`[boot] env=${process.env.NODE_ENV || 'development'} version=${pkg.version} port=${PORT}`);
      console.log(`[boot] integrations: razorpay=${razorpayConfigured() ? 'on' : 'off'} meta=${process.env.META_APP_SECRET ? 'on' : 'off'} ai=${(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) ? 'on' : 'off'} workers=media,send,agent,automation`);
    } catch (err) {
      console.error('[boot] banner failed:', err.message);
    }
  });

  // Graceful shutdown (Phase 13): stop accepting, drain realtime + queues,
  // then release Postgres + Redis handles. Force-exit after 25s so a stuck
  // drain can never wedge the container; crash guards route through shutdown.
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Green Pilot] ${sig} received, draining…`);
    const force = setTimeout(() => {
      console.error('[Green Pilot] shutdown timed out — forcing exit');
      process.exit(1);
    }, 25_000);
    try { await new Promise((resolve) => server.close(resolve)); }
    catch { /* already closed */ }
    try { await require('./realtime/socket').closeRealtime(); } catch { /* already closed */ }
    await shutdownMediaQueue();
    await shutdownSendQueue();
    await shutdownAgentQueue();
    await shutdownAutomationQueue();
    try { await require('./queue/redisHealth').closeRedisHealth(); } catch { /* ignore */ }
    try { await pool.end(); } catch (err) { console.error('[shutdown] pool drain failed:', err.message); }
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    console.error('[Fatal] unhandled rejection:', err && err.message ? err.message : err);
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    console.error('[Fatal] uncaught exception:', err && err.message ? err.message : err);
    shutdown('uncaughtException');
  });

  return server;
}

// Boot only when executed directly (`node src/index.js`). Requiring this
// module (e.g. HTTP-level tests) exposes { app, start } without side effects:
// no migrations, no workers, no listeners.
if (require.main === module) {
  start().catch(err => {
    console.error('[Fatal] Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { app, start };
