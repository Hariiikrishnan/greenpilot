// Green Pilot — Centralized Meta Graph API Client
//
// Centralizes:
// - Meta Graph API version and endpoint construction
// - Request timeouts with AbortController
// - Typed error classification: rate limits, invalid tokens, missing permissions, asset not found
// - Credential redaction: tokens are stripped from logs and error messages
// - Test mock hook for deterministic testing without hitting Meta endpoints

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.META_HTTP_TIMEOUT_MS || '10000', 10);

/**
 * Strips sensitive tokens (Bearer tokens, secret query params) from error messages or logs.
 */
function redactSecrets(input) {
  if (!input) return '';
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return str
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|client_secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
    .replace(/("client_secret"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

/**
 * Typed error for Meta Graph API failures.
 */
class MetaGraphApiError extends Error {
  constructor(message, { status = 400, code = 'meta_error', subcode = null, metaType = null, originalError = null } = {}) {
    super(redactSecrets(message));
    this.name = 'MetaGraphApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.metaType = metaType;
    this.originalError = originalError;
  }
}

// Test / Mock handler hook
let testGraphClientHandler = null;
function setTestGraphClient(fn) {
  testGraphClientHandler = fn;
}

/**
 * Classifies Meta error responses based on HTTP status and error codes.
 */
function classifyMetaError(data, status) {
  const err = data?.error || {};
  const metaCode = err.code;
  const metaSubcode = err.error_subcode;
  const message = err.message || data?.message || `Meta API request failed with status ${status}`;

  // 1. Invalid or Expired Token (Code 190)
  if (metaCode === 190 || metaSubcode === 463 || metaSubcode === 467) {
    return new MetaGraphApiError(`Meta access token is invalid or expired: ${message}`, {
      status: 401,
      code: 'invalid_token',
      subcode: metaSubcode,
      metaType: err.type,
    });
  }

  // 2. Rate Limits (HTTP 429 or Codes 4, 17, 80004, 613)
  if (status === 429 || [4, 17, 80004, 613].includes(metaCode)) {
    return new MetaGraphApiError(`Meta API rate limit reached: ${message}`, {
      status: 429,
      code: 'rate_limited',
      subcode: metaSubcode,
      metaType: err.type,
    });
  }

  // 3. Missing Permissions (Codes 10, 200-299)
  if (metaCode === 10 || (metaCode >= 200 && metaCode <= 299)) {
    return new MetaGraphApiError(`Meta permissions missing or insufficient: ${message}`, {
      status: 403,
      code: 'missing_permissions',
      subcode: metaSubcode,
      metaType: err.type,
    });
  }

  // 4. Asset Deleted / Not Found (Codes 33, 100, 131031)
  if ([33, 100, 131031].includes(metaCode) || status === 404) {
    return new MetaGraphApiError(`Meta resource not found or disconnected: ${message}`, {
      status: 404,
      code: 'asset_not_found',
      subcode: metaSubcode,
      metaType: err.type,
    });
  }

  return new MetaGraphApiError(message, {
    status: status >= 400 && status < 600 ? status : 400,
    code: 'meta_api_error',
    subcode: metaSubcode,
    metaType: err.type,
  });
}

/**
 * Executes an HTTP request against the Meta Graph API.
 */
async function graphRequest({
  method = 'GET',
  path,
  accessToken,
  body = null,
  params = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (testGraphClientHandler) {
    const mockRes = await testGraphClientHandler({ method, path, accessToken, body, params });
    if (mockRes !== undefined && mockRes !== null) {
      if (mockRes instanceof Error) throw mockRes;
      return mockRes;
    }
  }

  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const urlObj = new URL(`${GRAPH_BASE_URL}/${cleanPath}`);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      urlObj.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'Accept': 'application/json',
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(urlObj.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    let data = {};
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawText: text };
    }

    if (!res.ok) {
      throw classifyMetaError(data, res.status);
    }

    return data;
  } catch (err) {
    if (err instanceof MetaGraphApiError) throw err;
    if (err.name === 'AbortError') {
      throw new MetaGraphApiError(`Meta Graph API request timed out after ${timeoutMs}ms`, {
        status: 504,
        code: 'timeout',
      });
    }
    throw new MetaGraphApiError(`Meta Graph API network error: ${err.message}`, {
      status: 502,
      code: 'network_error',
      originalError: err,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  META_API_VERSION,
  GRAPH_BASE_URL,
  MetaGraphApiError,
  redactSecrets,
  graphRequest,
  setTestGraphClient,
};
