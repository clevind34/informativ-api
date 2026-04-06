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
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/**
 * Handle CORS preflight + origin check.
 * Returns a v1 response object for OPTIONS or blocked origins, or null to continue.
 */
export function handleCors(event) {
  const origin = (event.headers || {}).origin || '';

  if (origin && !isAllowedOrigin(origin)) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Origin not allowed' }),
    };
  }

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(origin),
      body: '',
    };
  }

  return null;
}
