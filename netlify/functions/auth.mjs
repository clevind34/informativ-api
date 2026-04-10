// Unified auth middleware for Informativ API Gateway
// Supports dual-mode authentication:
//   1. X-API-Key header (server-to-server, proxy, scheduled tasks)
//   2. Authorization: Bearer <JWT> (Netlify Identity user sessions)
// Returns v1-format response on failure, or null to continue.
//
// Phase 2B-3: Session timeout enforcement
//   - JWT iat (issued-at) checked against MAX_SESSION_AGE (30 days)
//   - X-Session-Expires header returned on authenticated responses
//   - Stale JWTs rejected with 401 + session_expired flag

const IDENTITY_URL = process.env.IDENTITY_URL || 'https://informativ-sales-api.netlify.app/.identity';

// In-memory token cache (survives warm Lambda reuse, cleared on cold start)
const _tokenCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Session timeout: 30 days of inactivity
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Validate X-API-Key header against API_KEY env var.
 * Pass-through if API_KEY not configured (graceful setup mode).
 * OPTIONS requests are never checked.
 */
export function validateApiKey(event) {
  const serverKey = process.env.API_KEY;
  if (!serverKey) return null;
  if (event.httpMethod === 'OPTIONS') return null;

  const clientKey = (event.headers || {})['x-api-key'] || '';

  if (clientKey !== serverKey) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Unauthorized — invalid or missing API key' }),
    };
  }

  return null;
}

/**
 * Validate JWT from Authorization: Bearer header via Netlify Identity (GoTrue).
 * Returns user object on success, null if no JWT present, or false if JWT invalid.
 *
 * User object shape:
 *   { id, email, roles: string[], team: string|null, rep_name: string|null }
 */
export async function validateJwt(event) {
  if (event.httpMethod === 'OPTIONS') return null;

  const authHeader = (event.headers || {}).authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  // Check warm cache
  const cached = _tokenCache.get(token);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.user;
  }

  try {
    // Phase 2B-3: Check JWT issued-at (iat) from token payload before GoTrue call.
    // This avoids a network round-trip for clearly expired sessions.
    try {
      const payloadB64 = token.split('.')[1];
      if (payloadB64) {
        const payloadStr = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
        const payload = JSON.parse(payloadStr);
        if (payload.iat) {
          const issuedAt = payload.iat * 1000; // JWT iat is in seconds
          if (Date.now() - issuedAt > MAX_SESSION_AGE_MS) {
            _tokenCache.set(token, { user: false, ts: Date.now() - CACHE_TTL + 30000, expired: true });
            return false; // Will be caught by authenticateRequest with session_expired flag
          }
        }
      }
    } catch { /* Malformed token — let GoTrue handle it */ }

    // Verify token with GoTrue /user endpoint
    const resp = await fetch(IDENTITY_URL + '/user', {
      headers: { 'Authorization': 'Bearer ' + token },
    });

    if (!resp.ok) {
      // Token invalid or expired — cache the failure briefly (30s) to avoid hammering GoTrue
      _tokenCache.set(token, { user: false, ts: Date.now() - CACHE_TTL + 30000 });
      return false;
    }

    const gotrueUser = await resp.json();
    const appMeta = gotrueUser.app_metadata || {};

    const user = {
      id: gotrueUser.id,
      email: gotrueUser.email,
      roles: appMeta.roles || [],
      team: appMeta.team || null,
      rep_name: appMeta.rep_name || null,
    };

    // Cache valid user (include iat for session expiry header)
    try {
      const payloadB64 = token.split('.')[1];
      if (payloadB64) {
        const payloadStr = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
        const payload = JSON.parse(payloadStr);
        if (payload.iat) user._iat = payload.iat;
      }
    } catch { /* ignore */ }

    _tokenCache.set(token, { user, ts: Date.now() });

    // Prune cache if it grows too large (unlikely with 30 users, but defensive)
    if (_tokenCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of _tokenCache) {
        if (now - v.ts > CACHE_TTL) _tokenCache.delete(k);
      }
    }

    return user;
  } catch (err) {
    console.error('[auth] JWT verification error:', err.message);
    return false;
  }
}

/**
 * Combined auth check — validates API key AND extracts user identity if JWT present.
 * Attaches user to event._user for downstream role checks.
 *
 * Logic:
 *   - API key must be valid (unless not configured)
 *   - If JWT present and valid, event._user is populated
 *   - If JWT present but invalid, returns 401
 *   - If no JWT, event._user stays null (anonymous proxy request)
 */
export async function authenticateRequest(event) {
  if (event.httpMethod === 'OPTIONS') return null;

  // Step 1: Validate API key (proxy-level auth)
  const keyCheck = validateApiKey(event);
  if (keyCheck) return keyCheck;

  // Step 2: Extract user identity from JWT (if present)
  const user = await validateJwt(event);

  if (user === false) {
    // JWT was provided but invalid — only hard-fail if no API key was provided.
    // If API key is valid (proxy call), degrade gracefully to anonymous access
    // so that expired browser JWTs don't break data loading.
    const hasValidApiKey = process.env.API_KEY && ((event.headers || {})['x-api-key'] === process.env.API_KEY);
    if (!hasValidApiKey) {
      // Check if this was a session timeout (vs invalid token)
      const cached = _tokenCache.get(authHeader.slice(7).trim());
      const isExpired = cached && cached.expired;
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: isExpired
            ? 'Session expired. Please log in again.'
            : 'Invalid or expired session. Please log in again.',
          session_expired: !!isExpired,
        }),
      };
    }
    // API key present — treat as anonymous (no user identity, but authenticated proxy)
    event._user = null;
    return null;
  }

  // Attach user to event for downstream functions
  event._user = user || null;

  // Phase 2B-3: Compute session expiry for X-Session-Expires header
  if (user && user._iat) {
    const expiresAt = new Date((user._iat * 1000) + MAX_SESSION_AGE_MS);
    event._sessionExpires = expiresAt.toISOString();
  }

  return null;
}

/**
 * Get the authenticated user from the event (set by authenticateRequest).
 * Returns null if no user identity (anonymous/server-to-server call).
 */
export function getUser(event) {
  return event._user || null;
}

/**
 * Get session-related headers to merge into response.
 * Returns { 'X-Session-Expires': ISO } if session expiry is known, else {}.
 */
export function sessionHeaders(event) {
  if (event._sessionExpires) {
    return { 'X-Session-Expires': event._sessionExpires };
  }
  return {};
}
