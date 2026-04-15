// Shared rate limiting middleware for gateway POST endpoints
// In-memory sliding window per IP (survives warm Lambda reuse)

const _buckets = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute window
const DEFAULT_MAX = 30; // 30 requests per minute per IP

function _getIp(event) {
  return (event.headers || {})['x-forwarded-for']?.split(',')[0]?.trim()
    || (event.headers || {})['client-ip']
    || 'unknown';
}

function _cleanup() {
  const now = Date.now();
  if (_buckets.size > 1000) {
    for (const [key, bucket] of _buckets) {
      if (now - bucket.windowStart > WINDOW_MS * 2) _buckets.delete(key);
    }
  }
}

/**
 * Check rate limit for this request.
 * Returns null if allowed, or a 429 response object if exceeded.
 *
 * @param {object} event - Netlify function event
 * @param {object} corsHeaders - CORS headers to include
 * @param {number} [maxRequests=30] - Max requests per minute
 */
export function checkRateLimit(event, corsHeaders, maxRequests = DEFAULT_MAX) {
  if (event.httpMethod === 'OPTIONS' || event.httpMethod === 'GET') return null;

  const ip = _getIp(event);
  const key = ip + ':' + (event.path || '');
  const now = Date.now();

  let bucket = _buckets.get(key);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    _buckets.set(key, bucket);
  }

  bucket.count++;
  _cleanup();

  if (bucket.count > maxRequests) {
    const retryAfter = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
    return {
      statusCode: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        ...corsHeaders,
      },
      body: JSON.stringify({ error: 'Rate limit exceeded. Try again in ' + retryAfter + ' seconds.' }),
    };
  }

  return null;
}
