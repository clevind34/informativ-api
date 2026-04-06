// Shared API key authentication for Informativ API Gateway
// Returns v1-format response ({ statusCode, headers, body }) on failure, or null to continue.

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
