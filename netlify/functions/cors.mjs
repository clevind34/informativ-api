// Unified CORS middleware for Informativ API Gateway
// Returns v1-format responses ({ statusCode, headers, body })

const ALLOWED_ORIGINS = [
  'https://informativchuck.netlify.app',
  'https://customer-intelligence-dashboard.netlify.app',
  'https://prospecting-intelligence.netlify.app',
  'https://pie-mobile.netlify.app',
  'https://informativrepdash.netlify.app',
  'https://informativsalesdash.netlify.app',
  'https://informativ-elt-kpi.netlify.app',
  'https://informativ-api.netlify.app',
  'https://informativ-sales-api.netlify.app',
  'https://informativ-platform.netlify.app',
];

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

/**
 * Build CORS headers object for the given origin.
 */
export function corsHeaders(origin) {
  const allowed = origin && isAllowedOrigin(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/**
 * Handle CORS preflight + origin check + CSRF defense.
 * Returns a v1 response object for OPTIONS or blocked origins, or null to continue.
 *
 * CSRF protection: state-changing methods (POST, PUT, DELETE) from browser contexts
 * must include a valid Origin header. Server-to-server calls (api-proxy) always include
 * the X-API-Key header, which bypasses the origin requirement.
 */
export function handleCors(event) {
  const origin = (event.headers || {}).origin || '';
  const method = (event.httpMethod || '').toUpperCase();

  if (origin && !isAllowedOrigin(origin)) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Origin not allowed' }),
    };
  }

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(origin),
      body: '',
    };
  }

  // CSRF defense: state-changing requests without Origin header
  // are allowed only if they carry an API key (server-to-server)
  const STATE_CHANGING = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (STATE_CHANGING.includes(method) && !origin) {
    const apiKey = (event.headers || {})['x-api-key'] || '';
    if (!apiKey) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing Origin header on state-changing request' }),
      };
    }
  }

  return null;
}
