// Unified auth middleware for Informativ API Gateway
// Supports dual-mode authentication:
//   1. X-API-Key header (server-to-server, proxy, scheduled tasks)
//   2. Authorization: Bearer <JWT> (Netlify Identity user sessions)
// Returns v1-format response on failure, or null to continue.

const IDENTITY_URL = process.env.IDENTITY_URL || 'https://informativ-sales-api.netlify.app/.identity';

// In-memory token cache (survives warm Lambda reuse, cleared on cold start)
const _tokenCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

    // Cache valid user
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
    // JWT was provided but invalid
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid or expired session. Please log in again.' }),
    };
  }

  // Attach user to event for downstream functions
  event._user = user || null;
  return null;
}

/**
 * Get the authenticated user from the event (set by authenticateRequest).
 * Returns null if no user identity (anonymous/server-to-server call).
 */
export function getUser(event) {
  return event._user || null;
}
