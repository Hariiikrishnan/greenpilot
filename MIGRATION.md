# Green Pilot Migration Document: Controlled Foundation Phase

**Project:** Green Pilot  
**Branch:** `migration/greenpilot`  
**Base Repository:** ForgeChat (`v1.2.1`)  
**Reference SaaS Repository:** `greenpilot-ag` (preserved untouched)  
**Date:** September 5, 2026  

---

## 1. Executive Summary

This document records the baseline setup of **Green Pilot** using **ForgeChat** as its core technical foundation. In accordance with strict product scope constraints, this migration establishes a fully functioning WhatsApp CRM, autonomous AI agent engine, visual automation runner, deal pipeline, and realtime team inbox, while strictly excluding advertising management, attribution, and growth tooling (reserved for *Revenue Pilot*).

The migration was conducted in a non-destructive, controlled manner on the dedicated `migration/greenpilot` branch.

---

## 2. Adoption & Boundary Matrix

### A. What Was Copied & Adopted
1. **Meta WhatsApp Cloud API Integration Engine:**
   - Inbound webhook parser (`backend/src/routes/webhook.js`) supporting text, media, voice notes, stickers, reactions, locations, interactive button replies, and delivery status progression (`sent` $\to$ `delivered` $\to$ `read`).
   - Cryptographic HMAC-SHA256 signature verification (`backend/src/util/webhookSignature.js`).
   - Outbound dispatch worker with rate limiting and exponential backoff (`backend/src/queue/sendQueue.js`).
   - Media download and caching worker (`backend/src/queue/mediaQueue.js`).
2. **Autonomous Conversational AI Agent Engine:**
   - Multi-turn LLM reasoning loop (`backend/src/engine/agentEngine.js`) supporting Anthropic Claude, OpenAI GPT-4o, and local Ollama models.
   - Built-in CRM write-back tools (`backend/src/services/agentCrmTools.js`): `set_contact_name`, `add_contact_tag`, `set_contact_field`.
   - Audio transcription via Whisper (`backend/src/services/transcription.js`).
   - Vision capabilities for processing WhatsApp images.
   - Human agent handoff and silence detection (`backend/src/services/agentHandoff.js`).
3. **Visual Automation & Chatbot DAG Runner:**
   - 1,417-line workflow runner (`backend/src/engine/automationEngine.js`) supporting triggers, conditions, delays, contact field updates, interactive quick-replies, and paused session waiting.
4. **WhatsApp Template Management & Broadcast Engine:**
   - Template lifecycle synchronization with Meta Graph API (`backend/src/routes/templates.js`).
   - Bulk broadcast sender with per-recipient variable mapping (`backend/src/routes/broadcasts.js`).
5. **Sales Pipelines & Deal Kanban:**
   - Pipeline and stage management with probability weighting and currency formatting (`backend/src/routes/pipelines.js`).
6. **Model Context Protocol (MCP) Server:**
   - Built-in MCP standard server (`backend/src/routes/mcp.js`, `mcp-server/`) exposing CRM data and messaging tools to external agentic clients.

### B. What Was Intentionally Excluded
Per product scope specifications, the following capabilities belong exclusively to *Revenue Pilot* and have **not** been introduced:
- **Meta Ads Management:** No ad account creation, token exchange, or ad set configuration.
- **Advertising Lead Gen Webhooks:** Excluded `WebhooksService.processMetaLead` and `processGoogleLead`.
- **Ad Attribution & ROI Analytics:** Excluded ad spend tracking, CAC calculations, and click-to-WhatsApp (CTWA) ad attribution parameters.
- **Marketing Campaign Growth Tools:** Excluded external marketing funnel generators.

### C. What Remains Unchanged
- **Core ForgeChat Business Logic:** Preserved all functional routes, schemas, and engines.
- **Single-Tenant Database Schema (`coexistence`):** The 58 database migrations were applied intact to maintain stability during this initial phase.
- **Design Tokens & UI Layout:** Maintained ForgeChat's responsive desktop layout while preparing the foundation for future Green Pilot emerald theme tokens.

---

## 3. Current Known Incompatibilities & Future Work

1. **Multi-Tenancy Gap:**
   - Current database tables live in the `coexistence` schema without an `organization_id` foreign key.
   - Migration `041_whatsapp_accounts_singleton.sql` enforces a single connected WhatsApp account globally via `UNIQUE INDEX ... ON ((TRUE))`. In a future SaaS phase, this must be scoped to `(organization_id)`.
2. **Billing & Quota Integration:**
   - ForgeChat operates as a self-hosted platform without payment limits. Green Pilot’s Razorpay quota checks (`SubscriptionQuota.messagesUsed`, `aiCreditsUsed`) must be integrated into `sendQueue` and `agentEngine` in the subsequent SaaS phase.
3. **Storage Abstraction:**
   - Inbound and outbound media files currently store on local disk (`backend/media` and `backend/uploads`). A multi-tenant cloud storage adapter (S3 / Cloudflare R2) will be required for horizontal scaling.
4. **Licensing Restriction:**
   - ForgeChat is licensed under the Sustainable Use License v1.0 (non-commercial / internal business use only). Commercial SaaS distribution requires licensing rights or an exemption from Forgemind Techhub LLP.

---

## 4. System Validation & Verification Log

### Validation Summary
| Check | Command | Result | Notes |
| :--- | :--- | :--- | :--- |
| **Backend Unit Tests** | `npm test` in `backend` | **20 / 20 PASS** | Tested access control, crypto, permissions, and webhook HMAC. |
| **Frontend Unit Tests** | `npm run test:unit` in `frontend` | **51 / 51 PASS** | Tested automation builder logic, contact import, and chat header. |
| **Frontend Production Build** | `npm run build` in `frontend` | **SUCCESS** | Vite built production bundle in 305ms without errors. |
| **Database Connectivity** | `node start-pg.js` | **RUNNING** | Embedded PostgreSQL running on port 5432 with UTF-8 encoding. |
| **Database Migrations** | `node -e "...runMigrations()..."` | **58 / 58 APPLIED** | All 58 migrations from `000_base_users` to `057_mcp` applied. |
| **Redis Connectivity** | `redis-cli ping` | **PONG** | Local Redis server running and responding on port 6379. |
| **Background Queues** | BullMQ workers on startup | **ACTIVE** | `mediaQueue` (c=2), `sendQueue` (c=5), `agentQueue` (c=4) running. |
| **Backend Server** | `node src/index.js` | **RUNNING** | Backend listening on `http://localhost:3001`. |
| **Backend Health Endpoint** | `curl http://localhost:3001/health` | **{"ok":true}** | Health check responding. |
| **Backend Auth Status** | `curl http://localhost:3001/api/auth/status` | **{"setupRequired":true}** | Session guard active; triggers setup wizard. |
| **Frontend Server** | `npm run dev` in `frontend` | **RUNNING** | Vite dev server listening on `http://localhost:5173`. |
| **Frontend HTTP Check** | `curl -I http://localhost:5173/` | **HTTP 200 OK** | HTML shell served properly. |
| **End-to-End Proxy** | `curl http://localhost:5173/api/auth/status` | **{"setupRequired":true}** | Vite proxy to backend port 3001 functioning cleanly. |
| **Secrets & Security Check**| `git status` | **CLEAN** | `.env` and `.pgdata/` ignored; zero keys committed. |

---

## 5. Local Development Startup Commands

To start the Green Pilot development environment locally:

```powershell
# 1. Start Local Redis Server (in background)
& "C:\Users\Sriram Avinas\AppData\Local\Microsoft\WinGet\Packages\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\Redis-8.10.0-Windows-x64-msys2\redis-server.exe" --daemonize no --save "" --appendonly no

# 2. Start Local PostgreSQL Database (in background)
cd "D:\dev project\GreenPilot\backend"
node start-pg.js

# 3. Start Green Pilot Backend API (Port 3001)
cd "D:\dev project\GreenPilot\backend"
npm start

# 4. Start Green Pilot Frontend Web App (Port 5173)
cd "D:\dev project\GreenPilot\frontend"
npm run dev
```

Open browser at `http://localhost:5173/` to access Green Pilot.
