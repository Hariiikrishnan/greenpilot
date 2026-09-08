// Friendly API error mapping (Phase 12, Step 18).
//
// The backend returns { error, code? } with an HTTP status. This helper maps
// them to honest, non-technical messages for the UI. Raw stack traces are
// never shown: unknown/500 errors collapse to a generic message while the
// technical detail stays on console for debugging.

export function friendlyApiError(err) {
  const status = err?.status;
  const code = err?.code;
  const raw = String(err?.message || 'Something went wrong');

  // Machine-coded cases first (quota / subscription / onboarding / invites).
  switch (code) {
    case 'quota-exceeded':
    case 'quota_exceeded':
      return 'Usage limit reached for your plan. Check Billing or upgrade to continue.';
    case 'subscription-expired':
    case 'subscription_expired':
      return 'Your subscription has expired. Renew in Billing to resume.';
    case 'no-organization':
      return 'No workspace found. Create or join an organization to continue.';
    case 'not-member':
    case 'ambiguous-organization':
      return 'You do not have access to that workspace.';
    case 'onboarding-incomplete':
      return 'Finish the required setup steps first.';
    case 'already-member':
      return 'That user is already a member of this workspace.';
    case 'email-taken':
      return 'An account with this email already exists. Try signing in.';
    case 'migration-required':
      return 'This feature needs a pending server update. Contact your administrator.';
    default:
      break;
  }

  switch (status) {
    case 400:
      return stripStatus(raw) || 'That request was invalid. Check the highlighted fields.';
    case 401:
      return 'Your session expired. Please sign in again.';
    case 403:
      return 'You do not have permission to do that.';
    case 404:
      return 'Not found. It may have been moved or deleted.';
    case 409:
      return stripStatus(raw) || 'That already exists. Refresh and try again.';
    case 422:
      return stripStatus(raw) || 'Some values need attention. Check the highlighted fields.';
    case 429:
      return 'Too many requests. Wait a moment and try again.';
    case 500:
    case 502:
    case 503:
      return 'Something went wrong on our side. Try again in a moment.';
    default:
      break;
  }

  // WhatsApp-specific server messages are already user-safe — pass through.
  if (/whatsapp|meta|token expired/i.test(raw)) return stripStatus(raw);
  // Never surface raw stacks: collapse multi-line/technical blobs.
  if (raw.length > 220 || /at\s+\S+\s+\(|\.js:\d+|Error:/.test(raw)) {
    return 'Something went wrong. Try again in a moment.';
  }
  return stripStatus(raw);
}

function stripStatus(msg) {
  // api.js errors may carry a leading "409 " prefix when the body was raw.
  return String(msg || '').replace(/^\d{3}\s+/, '').trim();
}

// Returns true when the error means "route to login" (session dead).
export function isAuthError(err) {
  return err?.status === 401;
}
