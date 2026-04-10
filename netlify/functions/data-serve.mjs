// Shared data-serving utility for /api/data/* endpoints
// Each data function imports this and calls serveDataFile(event, filename, options)
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { requireRole } from './roles.mjs';
import { logRequest } from './audit-log.mjs';

// Netlify esbuild bundles may resolve cwd differently — try multiple paths
const BASE_PATHS = [
  process.cwd(),
  join(process.cwd(), '..', '..'),
  '/var/task',
];

// Endpoints that require manager+ access (sensitive leadership data)
const RESTRICTED_FILES = {
  'trajectory.json': ['manager', 'elt', 'admin'],
  'coaching-intelligence.json': ['manager', 'elt', 'admin'],
  'calibration.json': ['manager', 'elt', 'admin'],
  'coaching-effectiveness.json': ['manager', 'elt', 'admin'],
  'selling-gm.json': ['manager', 'elt', 'admin'],
  'prospecting-effectiveness.json': ['manager', 'elt', 'admin'],
  'rep-hygiene-deals.json': ['manager', 'elt', 'admin'],
  'rep-forecast-data.json': ['manager', 'elt', 'admin'],
  'forecast-deals.json': ['manager', 'elt', 'admin'],
  'coaching-action-tracker.json': ['manager', 'elt', 'admin'],
};

/**
 * Serve a JSON data file from the data/ directory.
 * Handles CORS, auth (API key + JWT), role enforcement, caching headers, and ETag.
 */
export async function serveDataFile(event, filename) {
  // CORS preflight
  const corsCheck = handleCors(event);
  if (corsCheck) return corsCheck;

  // Combined auth: API key + JWT user extraction
  const authCheck = await authenticateRequest(event);
  if (authCheck) { logRequest(event, authCheck); return authCheck; }

  const origin = (event.headers || {}).origin || '';
  const _cors = corsHeaders(origin);

  // Role enforcement for restricted data files
  const requiredRoles = RESTRICTED_FILES[filename];
  if (requiredRoles) {
    const roleCheck = requireRole(event, _cors, ...requiredRoles);
    if (roleCheck) return roleCheck;
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ..._cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed. Use GET.' }),
    };
  }

  try {
    // Find data file across possible base paths (Netlify esbuild path resolution)
    let raw = null;
    for (const base of BASE_PATHS) {
      const dataPath = join(base, 'data', filename);
      if (existsSync(dataPath)) {
        raw = readFileSync(dataPath, 'utf-8');
        break;
      }
    }
    if (!raw) throw new Error(`File not found in any base path: data/${filename}`);

    // Simple ETag from content length + first 100 chars hash
    const etag = `"${Buffer.byteLength(raw)}-${simpleHash(raw.slice(0, 200))}"`;

    // Check If-None-Match
    const clientEtag = (event.headers || {})['if-none-match'];
    if (clientEtag === etag) {
      const r304 = { statusCode: 304, headers: { ..._cors, ETag: etag }, body: '' };
      logRequest(event, r304);
      return r304;
    }

    const r200 = {
      statusCode: 200,
      headers: {
        ..._cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
        ETag: etag,
      },
      body: raw,
    };
    logRequest(event, r200);
    return r200;
  } catch (err) {
    console.error(`[data-serve] Error reading ${filename}:`, err.message);
    const r500 = {
      statusCode: 500,
      headers: { ..._cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Data file not available', file: filename }),
    };
    logRequest(event, r500);
    return r500;
  }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
