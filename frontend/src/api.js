// Green Pilot organization context. The active org id is suggested to the API
// via X-Org-Id on every request; the backend honors it ONLY with a membership
// row, so a forged value fails closed (403) rather than leaking tenants.
const ORG_STORAGE_KEY = 'greenpilot.activeOrg';
export function getActiveOrgId() {
  try { return localStorage.getItem(ORG_STORAGE_KEY) || null; } catch { return null; }
}
export function setActiveOrgId(id) {
  try {
    if (id) localStorage.setItem(ORG_STORAGE_KEY, id);
    else localStorage.removeItem(ORG_STORAGE_KEY);
  } catch { /* storage unavailable — requests simply omit the header */ }
}

async function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const activeOrg = getActiveOrgId();
  if (activeOrg) headers['X-Org-Id'] = activeOrg;
  // Forward idempotency keys for safe-retriable mutations (org creation).
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers,
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code = null;
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || text;
      code = parsed.code || null;
    } catch { /* keep raw text */ }
    const err = new Error(message || `${res.status}`);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return res.json();
}

export const api = {
  auth: {
    me: () => req('/auth/me'),
    status: () => req('/auth/status'),
    setup: (email, password, displayName) =>
      req('/auth/setup', { method: 'POST', body: JSON.stringify({ email, password, displayName }) }),
    // Self-signup: creates user + personal organization, signs in.
    register: (data) =>
      req('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    google: (credential, organizationName) =>
      req('/auth/google', { method: 'POST', body: JSON.stringify({ credential, organizationName }) }),
    login: (email, password) =>
      req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => req('/auth/logout', { method: 'POST' }),
  },
  dashboard: (range = '7d') => req(`/dashboard?range=${encodeURIComponent(range)}`),
  dashboardDetails: (metric, range = '7d') =>
    req(`/dashboard/details?metric=${encodeURIComponent(metric)}&range=${encodeURIComponent(range)}`),
  numbers: () => req('/numbers'),
  contacts: (waNumber, timeRange) =>
    req(`/contacts?waNumber=${encodeURIComponent(waNumber)}&timeRange=${timeRange}`),
  messages: (params) => {
    const qs = new URLSearchParams(params);
    return req(`/messages?${qs}`);
  },
  contactNames: (waNumber) =>
    req(`/contact-names?waNumber=${encodeURIComponent(waNumber)}`),
  contact: (waNumber, contactNumber) =>
    req(`/contact?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
  saveContact: (waNumber, contactNumber, name, tags = [], customFields, assignedUserId) =>
    req('/contacts/save', {
      method: 'POST',
      body: JSON.stringify({
        waNumber, contactNumber, name, tags,
        ...(customFields !== undefined ? { customFields } : {}),
        ...(assignedUserId !== undefined ? { assignedUserId } : {}),
      }),
    }),
  savedContacts: (waNumber) =>
    req(`/saved-contacts?waNumber=${encodeURIComponent(waNumber)}`),
  deleteContact: (waNumber, contactNumber) =>
    req(`/contact?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`, { method: 'DELETE' }),
  // Change a contact's phone number — migrates the conversation + history across
  // every table keyed on (wa_number, contact_number), transactionally.
  changeContactNumber: (waNumber, oldNumber, newNumber) =>
    req('/contacts/change-number', { method: 'POST', body: JSON.stringify({ waNumber, oldNumber, newNumber }) }),
  // Same-origin download URL for the sample import sheet — the auth cookie rides
  // along on a plain anchor navigation.
  importContactsTemplateUrl: () => '/api/contacts/import/template',
  // Bulk-import contacts from a .csv/.xlsx file. Uses raw fetch + FormData so the
  // browser sets the multipart boundary (the shared req() helper forces JSON).
  importContacts: (waNumber, file) => {
    const form = new FormData();
    form.append('waNumber', waNumber);
    form.append('file', file);
    return fetch('/api/contacts/import', { method: 'POST', credentials: 'include', body: form })
      .then(async res => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          let msg = text;
          try { msg = JSON.parse(text).error || text; } catch { /* keep raw */ }
          throw new Error(msg || `${res.status}`);
        }
        return res.json();
      });
  },
  categories: {
    list: () => req('/categories'),
    create: (data) => req('/categories', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/categories/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/categories/${id}`, { method: 'DELETE' }),
  },
  tags: {
    list: () => req('/tags'),
    create: (data) => req('/tags', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/tags/${id}`, { method: 'DELETE' }),
  },
  // Custom contact field definitions (Settings → Fields). Values per contact
  // are saved via saveContact(..., customFields) and read back on api.contact.
  contactFields: {
    list: () => req('/contact-fields'),
    create: (data) => req('/contact-fields', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/contact-fields/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/contact-fields/${id}`, { method: 'DELETE' }),
  },
  // Admin-only user management (multi-user RBAC: admin + sales).
  users: {
    list: () => req('/users'),
    get: (id) => req(`/users/${id}`),
    create: (data) => req('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => req(`/users/${id}`, { method: 'DELETE' }),
    resetPassword: (id, password) => req(`/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
    }),
  },
  templates: {
    list: ({ accountId, status, q } = {}) => {
      const qs = new URLSearchParams();
      if (accountId) qs.set('accountId', accountId);
      if (status) qs.set('status', status);
      if (q) qs.set('q', q);
      const s = qs.toString();
      return req(`/templates${s ? `?${s}` : ''}`);
    },
    get: (id) => req(`/templates/${id}`),
    create: (data) => req('/templates', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/templates/${id}`, { method: 'DELETE' }),
    submit: (id) => req(`/templates/${id}/submit`, { method: 'POST' }),
    sync: (id) => req(`/templates/${id}/sync`, { method: 'POST' }),
    duplicate: (id) => req(`/templates/${id}/duplicate`, { method: 'POST' }),
    payload: (id) => req(`/templates/${id}/payload`),
  },
  broadcasts: {
    list: (status) => req(`/broadcasts${status && status !== 'all' ? `?status=${status}` : ''}`),
    get: (id) => req(`/broadcasts/${id}`),
    create: (data) => req('/broadcasts', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/broadcasts/${id}`, { method: 'DELETE' }),
    send: (id) => req(`/broadcasts/${id}/send`, { method: 'POST' }),
    test: (id, testNumber) => req(`/broadcasts/${id}/test`, { method: 'POST', body: JSON.stringify({ test_number: testNumber }) }),
  },
  chatbots: {
    list: () => req('/chatbots'),
    get: (id) => req(`/chatbots/${id}`),
    create: (data) => req('/chatbots', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/chatbots/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    duplicate: (id) => req(`/chatbots/${id}/duplicate`, { method: 'POST' }),
    delete: (id) => req(`/chatbots/${id}`, { method: 'DELETE' }),
    exportOne: (id) => req(`/chatbots/${id}/export`),
    import: (payload) => req('/chatbots/import', { method: 'POST', body: JSON.stringify(payload) }),
    executions: (id, { page = 1, limit = 20, status = 'all', startDate = '', endDate = '', messageStatus = 'all' } = {}) => {
      const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status && status !== 'all') qs.set('status', status);
      if (startDate) qs.set('startDate', startDate);
      if (endDate) qs.set('endDate', endDate);
      if (messageStatus && messageStatus !== 'all') qs.set('messageStatus', messageStatus);
      return req(`/chatbots/${id}/executions?${qs}`);
    },
  },
  executions: {
    get: (id) => req(`/executions/${id}`),
    cancel: (id) => req(`/executions/${id}/cancel`, { method: 'POST' }),
  },
  // Green Pilot canonical automations (Phase 10, /api/v1/automations/*).
  // Same org-scoped automations as api.chatbots; automation terminology.
  automations: {
    list: () => req('/v1/automations'),
    get: (id) => req(`/v1/automations/${id}`),
    create: (data) => req('/v1/automations', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/v1/automations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    enable: (id) => req(`/v1/automations/${id}/enable`, { method: 'POST' }),
    disable: (id) => req(`/v1/automations/${id}/disable`, { method: 'POST' }),
    duplicate: (id) => req(`/v1/automations/${id}/duplicate`, { method: 'POST' }),
    remove: (id) => req(`/v1/automations/${id}`, { method: 'DELETE' }),
    executions: (id, params = {}) => {
      const qs = new URLSearchParams({ page: String(params.page || 1), limit: String(params.limit || 20) });
      if (params.status) qs.set('status', params.status);
      return req(`/v1/automations/${id}/executions?${qs}`);
    },
    // Manual test run: simulated side effects (no customer messages, no quota).
    testRun: (id, data = {}) => req(`/v1/automations/${id}/test-run`, { method: 'POST', body: JSON.stringify(data) }),
  },
  whatsappAccounts: {
    list: (activeOnly = false) => req(`/whatsapp-accounts${activeOnly ? '?activeOnly=true' : ''}`),
    get: (id) => req(`/whatsapp-accounts/${id}`),
    create: (data) => req('/whatsapp-accounts', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/whatsapp-accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/whatsapp-accounts/${id}`, { method: 'DELETE' }),
    getEmbeddedSignupConfig: () => req('/whatsapp-accounts/embedded-signup/config'),
    completeEmbeddedSignup: (data) => req('/whatsapp-accounts/embedded-signup/complete', { method: 'POST', body: JSON.stringify(data) }),
    disconnect: (id) => req(`/whatsapp-accounts/${encodeURIComponent(id)}/disconnect`, { method: 'POST' }),
    verify: (id) => req(`/whatsapp-accounts/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  },
  // Green Pilot organizations (canonical /api/v1/orgs). Membership-gated
  // server-side; the client only suggests context via X-Org-Id (see req()).
  orgs: {
    list: () => req('/v1/orgs'),
    // Pass { idempotencyKey } to make retries safe (no duplicate orgs).
    create: (data, { idempotencyKey } = {}) =>
      req('/v1/orgs', { method: 'POST', body: JSON.stringify(data), ...(idempotencyKey ? { idempotencyKey } : {}) }),
    members: (id) => req(`/v1/orgs/${encodeURIComponent(id)}/members`),
    addMember: (id, data) =>
      req(`/v1/orgs/${encodeURIComponent(id)}/members`, { method: 'POST', body: JSON.stringify(data) }),
    removeMember: (id, userId) =>
      req(`/v1/orgs/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  },
  // Secure team invitations (Phase 12). The token — never a client org id —
  // establishes the organization context on accept.
  invitations: {
    list: (orgId) => req(`/v1/orgs/${encodeURIComponent(orgId)}/invitations`),
    create: (orgId, data) =>
      req(`/v1/orgs/${encodeURIComponent(orgId)}/invitations`, { method: 'POST', body: JSON.stringify(data) }),
    revoke: (orgId, inviteId) =>
      req(`/v1/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(inviteId)}/revoke`, { method: 'POST' }),
    lookup: (token) => req(`/v1/invitations/${encodeURIComponent(token)}`),
    accept: (token) => req(`/v1/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
  },
  // Organization + profile settings (Phase 12, canonical /api/v1/settings/*).
  // Organization settings are org-scoped server-side; profile settings are
  // user-owned. localStorage is never the source of truth here.
  settings: {
    overview: () => req('/v1/settings/overview'),
    getOrganization: () => req('/v1/settings/organization'),
    updateOrganization: (data) =>
      req('/v1/settings/organization', { method: 'PUT', body: JSON.stringify(data) }),
    getOnboarding: () => req('/v1/settings/onboarding'),
    patchOnboarding: (data) =>
      req('/v1/settings/onboarding', { method: 'PATCH', body: JSON.stringify(data) }),
    completeOnboarding: () => req('/v1/settings/onboarding/complete', { method: 'POST' }),
    whatsappStatus: () => req('/v1/settings/whatsapp-status'),
    getProfile: () => req('/v1/settings/profile'),
    updateProfile: (data) =>
      req('/v1/settings/profile', { method: 'PUT', body: JSON.stringify(data) }),
    changePassword: (data) =>
      req('/v1/settings/password', { method: 'POST', body: JSON.stringify(data) }),
  },
  // Green Pilot billing (Phase 8, canonical /api/v1/billing/*). The org comes
  // from the membership-derived X-Org-Id context; prices/plans are
  // server-controlled. Responses never contain provider secrets.
  billing: {
    plans: () => req('/v1/billing/plans'),
    status: () => req('/v1/billing/status'),
    createOrder: (plan) =>
      req('/v1/billing/create-order', { method: 'POST', body: JSON.stringify({ plan }) }),
    verifyPayment: ({ providerOrderId, providerPaymentId, signature }) =>
      req('/v1/billing/verify-payment', {
        method: 'POST',
        body: JSON.stringify({ providerOrderId, providerPaymentId, signature }),
      }),
    cancel: () => req('/v1/billing/cancel', { method: 'POST' }),
  },
  // Google integrations (v1: Google Sheets only; Gmail + Calendar in a later
  // release reuse the same /google-integrations table and OAuth flow).
  googleIntegrations: {
    status: () => req('/google-integrations/status'),
    // Admin-only: the workspace Google OAuth app credentials (Client ID /
    // Secret / Redirect URI). getCredentials never returns the secret.
    getCredentials: (reveal = false) => req(`/google-integrations/credentials${reveal ? '?reveal=1' : ''}`),
    saveCredentials: (data) =>
      req('/google-integrations/credentials', { method: 'PUT', body: JSON.stringify(data) }),
    deleteCredentials: () =>
      req('/google-integrations/credentials', { method: 'DELETE' }),
    list: () => req('/google-integrations'),
    authorize: () => req('/google-integrations/authorize', { method: 'POST' }),
    disconnect: (id) => req(`/google-integrations/${id}`, { method: 'DELETE' }),
    listSpreadsheets: (id, q = '') =>
      req(`/google-integrations/${id}/spreadsheets${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    listTabs: (id, spreadsheetId) =>
      req(`/google-integrations/${id}/spreadsheets/${encodeURIComponent(spreadsheetId)}/tabs`),
  },
  // AI Models registry — workspace-wide LLM provider credentials (Admin
  // Settings → Integrations → AI Models). Agents reference a row by id; the key
  // is encrypted server-side and only revealed to admins via ?reveal=1.
  aiModels: {
    list: () => req('/ai-models'),
    get: (id, reveal = false) => req(`/ai-models/${id}${reveal ? '?reveal=1' : ''}`),
    create: (data) => req('/ai-models', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/ai-models/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/ai-models/${id}`, { method: 'DELETE' }),
  },
  // AI Agents — standalone LLM-driven chat handlers bound to a WhatsApp account.
  agents: {
    list: () => req('/agents'),
    get: (id, reveal = false) => req(`/agents/${id}${reveal ? '?reveal=1' : ''}`),
    create: (data) => req('/agents', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/agents/${id}`, { method: 'DELETE' }),
    exportOne: (id) => req(`/agents/${id}/export`),
    import: (payload) => req('/agents/import', { method: 'POST', body: JSON.stringify(payload) }),
    runs: (id, limit = 50) => req(`/agents/${id}/runs?limit=${limit}`),
    run: (id, runId) => req(`/agents/${id}/runs/${runId}`),
    addTool: (id, data) => req(`/agents/${id}/tools`, { method: 'POST', body: JSON.stringify(data) }),
    updateTool: (id, toolId, data) =>
      req(`/agents/${id}/tools/${toolId}`, { method: 'PUT', body: JSON.stringify(data) }),
    removeTool: (id, toolId) => req(`/agents/${id}/tools/${toolId}`, { method: 'DELETE' }),
    // Dry-run an agent without sending the reply to WhatsApp — used by the
    // "Test chat" panel inside the agent editor.
    test: (id, messages) => req(`/agents/${id}/test`, {
      method: 'POST', body: JSON.stringify({ messages }),
    }),
    // Transcribe a voice note recorded in the test chat (mic button).
    testTranscribe: (id, audioBlob, filename = 'voice.webm') => {
      const form = new FormData();
      form.append('audio', audioBlob, filename);
      return fetch(`/api/agents/${id}/test/transcribe`, {
        method: 'POST', credentials: 'include', body: form,
      }).then(async res => {
        if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`${res.status} ${t}`); }
        return res.json();
      });
    },
  },
  // Per-conversation bot control (Chats header 🤖 toggle).
  agentConversation: {
    status: (waNumber, contactNumber) =>
      req(`/agent-conversation?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
    pause: (waNumber, contactNumber) =>
      req('/agent-conversation/pause', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
    resume: (waNumber, contactNumber) =>
      req('/agent-conversation/resume', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
  },
  // Green Pilot AI (Phase 9, canonical /api/v1/ai/*). Qualification results,
  // usage, and per-conversation AI mode. Responses never contain provider
  // secrets, prompts, or chain-of-thought.
  ai: {
    status: () => req('/v1/ai/status'),
    qualifications: (waNumber, contactNumber, limit = 20) => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (waNumber) qs.set('waNumber', waNumber);
      if (contactNumber) qs.set('contactNumber', contactNumber);
      return req(`/v1/ai/qualifications?${qs}`);
    },
    qualification: (id) => req(`/v1/ai/qualifications/${encodeURIComponent(id)}`),
    usage: () => req('/v1/ai/usage'),
    setConversationMode: (waNumber, contactNumber, enabled) =>
      req('/v1/ai/conversation-mode', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber, enabled }) }),
  },
  // External MCP access — admin management of keys + capability toggles.
  mcp: {
    getSettings: () => req('/mcp/settings'),
    updateSettings: (data) => req('/mcp/settings', { method: 'PUT', body: JSON.stringify(data) }),
    listKeys: () => req('/mcp/keys'),
    createKey: (label) => req('/mcp/keys', { method: 'POST', body: JSON.stringify({ label }) }),
    updateKey: (id, data) => req(`/mcp/keys/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteKey: (id) => req(`/mcp/keys/${id}`, { method: 'DELETE' }),
    install: () => req('/mcp/install'),
  },
  pipelines: {
    list: () => req('/pipelines'),
    // Idempotent CRM bootstrap — safe to call on every onboarding load.
    initDefault: () => req('/pipelines/init-default', { method: 'POST' }),
    create: (name) => req('/pipelines', { method: 'POST', body: JSON.stringify({ name }) }),
    update: (id, name) => req(`/pipelines/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
    delete: (id) => req(`/pipelines/${id}`, { method: 'DELETE' }),
    addStage: (pipelineId, data) => req(`/pipelines/${pipelineId}/stages`, { method: 'POST', body: JSON.stringify(data) }),
    updateStage: (stageId, data) => req(`/stages/${stageId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteStage: (stageId) => req(`/stages/${stageId}`, { method: 'DELETE' }),
  },
  deals: {
    list: (pipelineId) => req(`/deals?pipelineId=${encodeURIComponent(pipelineId)}`),
    metrics: (pipelineId) => req(`/deals/metrics?pipelineId=${encodeURIComponent(pipelineId)}`),
    create: (data) => req('/deals', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => req(`/deals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    move: (id, stageId) => req(`/deals/${id}/move`, { method: 'POST', body: JSON.stringify({ stageId }) }),
    delete: (id) => req(`/deals/${id}`, { method: 'DELETE' }),
    contactSearch: (q) => req(`/deals/contact-search?q=${encodeURIComponent(q)}`),
  },
  // Green Pilot canonical CRM (Phase 11, /api/v1/leads/* + /api/v1/crm/*).
  // Lead ≡ org-owned contact; responses never contain other orgs' data.
  leads: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      for (const k of ['search', 'status', 'stageId', 'assignedUserId', 'qualification', 'page', 'limit']) {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') qs.set(k, String(params[k]));
      }
      const s = qs.toString();
      return req(`/v1/leads${s ? `?${s}` : ''}`);
    },
    get: (id) => req(`/v1/leads/${encodeURIComponent(id)}`),
    byContact: (waNumber, contactNumber) =>
      req(`/v1/leads/by-contact?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
    create: (data) => req('/v1/leads', { method: 'POST', body: JSON.stringify(data) }),
    remove: (id) => req(`/v1/leads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    setStatus: (id, status) => req(`/v1/leads/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    setStage: (id, stageId) => req(`/v1/leads/${encodeURIComponent(id)}/stage`, { method: 'PATCH', body: JSON.stringify({ stageId }) }),
    assign: (id, userId) => req(`/v1/leads/${encodeURIComponent(id)}/assign`, { method: 'PATCH', body: JSON.stringify({ userId }) }),
    messages: (id, params = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      return req(`/v1/leads/${encodeURIComponent(id)}/messages${s ? `?${s}` : ''}`);
    },
    sendMessage: (id, data) => req(`/v1/leads/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(typeof data === 'string' ? { text: data } : data),
    }),
  },
  chats: {
    list: (params = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      return req(`/v1/chats${s ? `?${s}` : ''}`);
    },
    get: (id) => req(`/v1/chats/${encodeURIComponent(id)}`),
    messages: (id, params = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      return req(`/v1/chats/${encodeURIComponent(id)}/messages${s ? `?${s}` : ''}`);
    },
    sendMessage: (id, data) => req(`/v1/chats/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(typeof data === 'string' ? { text: data } : data),
    }),
  },
  crm: {
    notes: (waNumber, contactNumber) =>
      req(`/v1/crm/notes?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
    addNote: (waNumber, contactNumber, body) =>
      req('/v1/crm/notes', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber, body }) }),
    updateNote: (id, body) => req(`/v1/crm/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ body }) }),
    deleteNote: (id) => req(`/v1/crm/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    calls: (waNumber, contactNumber) =>
      req(`/v1/crm/calls?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
    logCall: (waNumber, contactNumber, data) =>
      req('/v1/crm/calls', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber, ...data }) }),
    deleteCall: (id) => req(`/v1/crm/calls/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    followups: (waNumber, contactNumber, params = {}) => {
      const qs = new URLSearchParams({ waNumber, contactNumber });
      if (params.status) qs.set('status', params.status);
      if (params.page) qs.set('page', String(params.page));
      return req(`/v1/crm/followups?${qs}`);
    },
    createFollowup: (waNumber, contactNumber, data) =>
      req('/v1/crm/followups', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber, ...data }) }),
    completeFollowup: (id) => req(`/v1/crm/followups/${encodeURIComponent(id)}/complete`, { method: 'POST' }),
    cancelFollowup: (id) => req(`/v1/crm/followups/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    activity: (waNumber, contactNumber, limit = 30) =>
      req(`/v1/crm/activity?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}&limit=${limit}`),
  },
  retryMedia: (messageId) => req(`/media/${encodeURIComponent(messageId)}/retry`, { method: 'POST' }),
  mediaUrl: (messageId) => `/api/media/${encodeURIComponent(messageId)}`,
  windowStatus: (waNumber, contactNumber) =>
    req(`/messages/window-status?waNumber=${encodeURIComponent(waNumber)}&contactNumber=${encodeURIComponent(contactNumber)}`),
  markRead: (waNumber, contactNumber) =>
    req('/messages/mark-read', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber }) }),
  // Emoji reaction to a message (empty emoji removes it).
  react: (fromNumber, toNumber, messageId, emoji) =>
    req('/messages/react', { method: 'POST', body: JSON.stringify({ fromNumber, toNumber, messageId, emoji }) }),
  // Local-only "star" bookmark on a message.
  star: (waNumber, contactNumber, messageId, starred) =>
    req('/messages/star', { method: 'POST', body: JSON.stringify({ waNumber, contactNumber, messageId, starred }) }),
  sendMessage: ({ fromNumber, toNumber, text, contextMessageId }) =>
    req('/messages/send', { method: 'POST', body: JSON.stringify({ fromNumber, toNumber, text, contextMessageId }) }),
  testTemplate: (id, to, sampleValues = {}) =>
    req(`/templates/${id}/test-send`, { method: 'POST', body: JSON.stringify({ to, sampleValues }) }),
  sendMedia: async ({ fromNumber, toNumber, caption, file, contextMessageId }) => {
    const form = new FormData();
    form.append('fromNumber', fromNumber);
    form.append('toNumber', toNumber);
    if (caption) form.append('caption', caption);
    if (contextMessageId) form.append('contextMessageId', contextMessageId);
    form.append('file', file);
    const res = await fetch('/api/messages/send-media', { method: 'POST', credentials: 'include', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `${res.status}`);
    return json;
  },
  sendLibraryMedia: ({ fromNumber, toNumber, mediaLibraryId, caption, contextMessageId }) =>
    req('/messages/send-library-media', {
      method: 'POST',
      body: JSON.stringify({ fromNumber, toNumber, mediaLibraryId, caption, contextMessageId }),
    }),
  resolveAccountByPhone: (phone) =>
    req(`/whatsapp-accounts/by-phone/${encodeURIComponent(phone)}`),
  sendAudio: async ({ fromNumber, toNumber, file, contextMessageId }) => {
    const form = new FormData();
    form.append('fromNumber', fromNumber);
    form.append('toNumber', toNumber);
    if (contextMessageId) form.append('contextMessageId', contextMessageId);
    form.append('file', file);
    const res = await fetch('/api/messages/send-audio', { method: 'POST', credentials: 'include', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `${res.status}`);
    return json;
  },
  uploadTemplateMediaHandleFromLibrary: ({ accountId, mediaLibraryId }) =>
    req('/templates/upload-media-handle-from-library', {
      method: 'POST',
      body: JSON.stringify({ accountId, mediaLibraryId }),
    }),
  uploadTemplateMediaHandle: async ({ accountId, file }) => {
    const form = new FormData();
    form.append('accountId', accountId);
    form.append('file', file);
    const res = await fetch('/api/templates/upload-media-handle', { method: 'POST', credentials: 'include', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `${res.status}`);
    return json;
  },
  syncTemplate: (id) => req(`/templates/${id}/sync`, { method: 'POST' }),
  syncAllTemplates: () => req('/templates/sync-all', { method: 'POST' }),
  duplicateTemplate: (id) => req(`/templates/${id}/duplicate`, { method: 'POST' }),
  bulkSubmitTemplates: (ids) => req('/templates/bulk-submit', { method: 'POST', body: JSON.stringify({ ids }) }),
  mediaLibrary: {
    // accountId scopes media to its owning (connected) WhatsApp account.
    list: (accountId) => req(`/media-library${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`),
    upload: (file, name, notes, accountId) => {
      const form = new FormData();
      form.append('file', file);
      if (name) form.append('name', name);
      if (notes) form.append('notes', notes);
      if (accountId) form.append('accountId', accountId);
      return fetch('/api/media-library', {
        method: 'POST',
        credentials: 'include',
        body: form,
      }).then(async res => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`${res.status} ${text}`);
        }
        return res.json();
      });
    },
    update: (id, data) =>
      req(`/media-library/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => req(`/media-library/${id}`, { method: 'DELETE' }),
    sync: (id, accountId) =>
      req(`/media-library/${id}/sync/${accountId}`, { method: 'POST' }),
    downloadUrl: (id) => `/api/media-library/${id}/download`,
  },
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch('/api/upload', {
      method: 'POST',
      credentials: 'include',
      body: form,
    }).then(async res => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${text}`);
      }
      return res.json();
    });
  },
};
