# PHASE 5 — Green Pilot Target Architecture (Canonical)

> Option A: this tree evolves into Green Pilot. ForgeChat is the technical
> foundation; Green Pilot is the product, architecture, identity, and SaaS
> experience. Commercial SaaS permission: **cleared** (recorded here per Phase 5;
> all copyright/license notices in `LICENSE.md`, `TRADEMARK.md`, `AUTHORS.md`
> preserved verbatim — do not remove).

## 1. Product identity (Green Pilot owns)
- Name/brand: **Green Pilot** (already applied: `<title>`, LoginGate, SetupWizard,
  Topbar, About (`greenpilot.io`), repo `greenpilot-io/greenpilot`).
- Remaining ForgeChat residue to eliminate: `forgecrm.*` localStorage keys,
  `forgecrm_token` cookie name (rotation plan required — flag day), `forgecrm-*`
  queue names (drain-and-rename plan), code comments, `FMOS` footer (verify legal
  status first), backend `[Green Pilot]` log prefix already correct.
- Terminology: Contacts → Leads (converged model), Chatbots → Automations,
  Agents → AI Agents (qualification-capable), Broadcasts stay.
- No user-facing ForgeChat branding unless legally required (none identified;
  legal notices stay in-repo, not in-UI).

## 2. Authentication (canonical)
- Keep: HttpOnly `sameSite=strict` cookie JWT (24h), bcrypt(10), per-request
  role/is_active check, one-time setup with advisory lock.
- Add: refresh-token rotation (staged; current 24h sliding re-login acceptable
  for Phase 5), password-reset via signed email token (staged — no mailer exists).
- Cookie rename `forgecrm_token` → `greenpilot_token` requires dual-read flag day
  (accept both, issue new) — staged, documented, not executed in Phase 5.

## 3. Organization tenancy (canonical, enforced)
```
Request → authMiddleware (user) → resolveTenant (membership) → req.org
→ tenant-scoped service → WHERE organization_id = $1
```
- New tables: `organizations(id UUID PK, name, slug UNIQUE, plan DEFAULT 'trial',
  ai_credits_granted/balance, created_at/updated_at)`,
  `organization_members(id UUID PK, organization_id FK CASCADE, user_id FK CASCADE,
  role owner|admin|member, created_at, UNIQUE(organization_id, user_id))`.
- Rules: never trust client-supplied org id — `X-Org-Id` honored only with
  membership; single-org users get implicit context; zero-org users get `403
  no-organization` (fail closed); every tenant query carries `organization_id`.
- Legacy NULL-org rows = single-owner scope, readable only through the owner's
  personal org after staged backfill (approval-gated; never cross-tenant).

## 4. Tenancy tree (target)
```
Organization
├── Users/Memberships (role owner|admin|member)
├── WhatsApp configuration/accounts (≥1 per org; §6)
├── Leads (merged contacts model; UNIQUE(org, phone))
├── Conversations (UNIQUE(org, account, contact); ai_enabled flag)
├── Messages (dedupe message_id; org index)
├── Notes / Calls / Follow-ups (staged models)
├── Pipelines / Deals (assigned_user_id validated in-org)
├── Automations + executions/steps (org-scoped jobs)
├── AI agents + runs + ai_usage_ledger (org quota)
├── Templates / Broadcasts / Media library (per-org)
├── Billing (subscription, invoices — greenfield)
└── Analytics (org-filtered dashboard)
```

## 5. API (canonical direction)
- Target: `/api/v1/*` (`/auth`, `/leads`, `/crm`, `/chats`, `/leads/:id/messages`,
  `/webhooks/whatsapp/:orgId`, `/billing`, `/analytics`, `/settings`).
- Phase 5: v1 **aliases** mounted alongside legacy `/api/*` (same handlers +
  `Deprecation`/`Sunset` headers); legacy removal plan in the API evolution map.
- Webhook: canonical v1 org-aware route added; legacy Meta callback kept until
  re-pointed.

## 6. Frontend (canonical direction)
- Now: Vite + React 18 SPA, hash router, local state, `api.js`, polling + SSE —
  works and stays. Phase 5 adds: org context (switcher + `X-Org-Id`), storage-key
  migration (`forgecrm.*` → `greenpilot.*`), removal of fake controls.
- Staged (own plans, not this phase): Zustand `useChatStore`, Socket.IO client,
  Next.js evaluation.

## 7. Realtime (canonical: Socket.IO, staged)
- Target: Socket.IO server with rooms `org-{organizationId}`, events
  `inbound-message`, `message-status-update`, `conversation-updated`,
  `lead-qualified`; explicit CORS origins; JWT-cookie handshake + per-room
  membership check. SSE + polling remain canonical for Phase 5.

## 8. AI + automation (canonical ownership)
- AI runs are `(organization_id, agent, contact)`-scoped, quota-checked against
  the org ledger with `(org, inbound_message_id)` idempotency, audited via
  `agent_runs`. Tools call org-scoped service functions only.
- Automations: org-owned graphs; jobs carry `organizationId`; workers resolve
  config within that org only. Trigger/action catalogue per evolution map §8.

## 9. Billing/quotas (canonical, greenfield)
- Org-owned subscription state + AI/WhatsApp quotas; payment verification
  server-side; secrets never reach the frontend. Phase 5 ships the ledger-ready
  org fields (`plan`, `ai_credits_granted/balance`); provider integration staged.

## 10. Advertising exclusion (standing)
No ads modules exist; none permitted. Webhook `conversation/pricing` passthrough
stays internal (delivery reconciliation only). Revenue Pilot remains separate.
