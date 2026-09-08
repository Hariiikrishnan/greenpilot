# PHASE 9 — AI Forensic Report (ForgeChat engine → Green Pilot)

Method: full reads of the 14 backend AI files, the agent frontend, AI
migrations, and env surface (two delegated inventories, verified by spot
reads). `QualificationService` does **not** exist anywhere in `backend/src`
(0 hits); `qualif` hits are only the Phase 7 `lead-qualified` emitter stub
plus a pipeline stage named "Qualified".

## Subsystem inventory + classification

| # | Subsystem | Location | Verdict | Rationale |
|---|---|---|---|---|
| 1 | Tool-loop adapters (Anthropic/OpenAI) | `llm/anthropic.js`, `llm/openai.js`, `llm/index.js` | **KEEP** | Clean provider boundary, no env reads, no tenant concept (correct — tenancy lives above). Needs only a test seam. Non-streaming; no AI retry logic (good). |
| 2 | Agent runtime (`runAgent`) | `engine/agentEngine.js:720-886` | **ADAPT** | Solid loop/history/reply-via-queue design, but ZERO org scoping (agent, history, media, templates, contacts all unfiltered), no quota/ledger, prompt has no server-side security preamble. |
| 3 | Agent queue + tenant guard | `queue/agentQueue.js` | **ADAPT** | Has `organizationId` + `tenantJobAllowed` re-validation (good bones), but no quota gate, no usage ledger, no qualification step, legacy-null bypass. |
| 4 | Webhook → agent routing | `services/agentRouter.js` | **ADAPT** | Forwards `organizationId`; trust in `record.organizationId` is unchecked at this layer (worker re-validates — keep that shape). Session/prior checks lack org. |
| 5 | CRM tools (name/tag/field) | `services/agentCrmTools.js` | **ADAPT** | Contact-scoped but not org-scoped; taxonomy reads are global (documented shared-taxonomy exception — keep). Writes need `organization_id` guards. |
| 6 | Human handoff + pause | `services/agentHandoff.js`, `routes/agentConversation.js` | **ADAPT** | Pause/resume is the backend AI-mode primitive (keep); contact writes need org guards; assignment needs membership check. |
| 7 | Agent CRUD routes | `routes/agents.js` | **ADAPT** | No `req.org` anywhere; export deliberately includes secrets (admin-only — keep, documented); test endpoint hits real sheets (keep, documented); needs org scoping + `qualify_leads`/`qualification_rules` fields + URL safety. |
| 8 | Agent MCP service | `services/agentService.js` | **DEFER** | MCP-only caller surface; deployment-level connector (documented exception like MCP keys). No tenant change in Phase 9; note as follow-up. |
| 9 | AI model registry | `routes/aiModels.js`, migration `027` | **KEEP** (+ dual-read) | Documented global exception (`062` comments: global provider fallbacks). Keys encrypted, masked, admin-reveal. Add nullable org for ownership without breaking global fallback. |
| 10 | Transcription (Whisper) | `services/transcription.js`, engine `:583-627` | **KEEP** | Narrow, key-injected, no org data beyond the message it transcribes (engine scopes the lookup). |
| 11 | Close-summary sweeper | `services/agentCloseSummary.js` | **ADAPT** | Batch query has no org; add org scoping (light touch). |
| 12 | Qualification engine | — does not exist | **REBUILD** (new) | `src/ai/qualification.js`: eligibility → structured-output qualification → validation → CRM timeline → ledger → `lead-qualified`. |
| 13 | AI quota/billing hooks | `billing/quotas.js` (`recordAiUsage`, uncalled) | **ADAPT** (wire up) | Phase 8 semantics reused verbatim: debit-on-success, refund-on-replay. Add read-only `hasAiUsage` pre-check. |
| 14 | Agent builder UI | `pages/AiAgentBuilderPage.jsx`, `components/agents/*` | **ADAPT** | Add qualification toggle + rules field; no redesign. Keys masked, no `reveal=true` call-site (verified). |
| 15 | Inbox bot toggle | `ChatWindow.jsx:592-612,1023-1037` | **KEEP** (+ extend) | One-shot status fetch + pause/resume works; add qualification banner on `lead-qualified`. |
| 16 | SSE `message-status`-only stream | `routes/events.js`, `hooks/useServerEvents.js` | **KEEP** | Untouched; `lead-qualified` travels via Socket.IO (Phase 7 contract). |
| 17 | Generic sheets/HTTP/media agent tools | engine + `AgentToolsList.jsx` | **ADAPT** (narrow) | Keep for the agent runtime; add URL safety + org guards on media/template lookups. Sheets/HTTP creds stay deployment-level (documented). No new tool kinds. |
| 18 | Autonomous-agent expansion, new providers, streaming | — | **REMOVE** (from scope) | Explicitly out: product is AI Lead Qualification, not a generic agent platform. No Gemini/Kimi, no token streaming, no new automation features. |

## Key evidence (tenant gaps being closed)

- `runAgent` loads `agents … WHERE a.id=$1` with no org (`agentEngine.js:721-727`); history `WHERE wa_number/contact` (`:522-532`); media `WHERE id` (`:372-375`); templates only account-matched (`:469-476`); global OpenAI fallback key pick (`:568-572`).
- No quota/ledger/billing call anywhere in the AI path (only `agent_runs` token counters).
- `ai_models` intentionally global (`062_org_columns.sql:9`); tags/fields shared taxonomy (`062:12`); `agents`/`agent_runs` backfilled to account org (`064:37-46,220`).
- `conversations.ai_enabled` exists (`063`) but **nothing reads it** — Phase 9 wires it as the persistent AI mode.
- `recordAiUsage`/`consumeQuota`/`checkQuota` defined, zero call-sites (Phase 8 staging confirmed).
- Frontend exposes prompts (by design) but no keys; runs viewer shows step traces (kept — operator visibility, no CoT exposure beyond tool I/O already shown today).

## Secret/env posture (verified, unchanged)

`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` optional fallbacks (commented in
`.env.example`); adapters receive keys as args; no key in prompts, logs,
sockets, or frontend (masked only). Historical scrub remains separate.
