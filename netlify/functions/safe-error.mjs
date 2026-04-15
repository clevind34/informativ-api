// Sanitized error responses — strips stack traces and internal paths
// Use instead of returning raw e.message or e.stack in catch blocks

/**
 * Create a safe error response that doesn't leak internals.
 * @param {number} statusCode
 * @param {string} publicMessage - Safe message for the client
 * @param {Error|string} [internalError] - Logged server-side only
 * @param {object} [corsHeaders] - CORS headers
 */
export function safeError(statusCode, publicMessage, internalError, corsHeaders = {}) {
  if (internalError) {
    const msg = internalError instanceof Error ? internalError.message : String(internalError);
    console.error('[API Error]', publicMessage, '|', msg);
  }

  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    body: JSON.stringify({ error: publicMessage }),
  };
}
