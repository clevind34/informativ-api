/**
 * Audit Log Middleware — Informativ API Gateway (Phase 2B-3)
 *
 * Non-blocking audit trail for all authenticated API requests.
 * Logs: user email, role, endpoint, method, status, IP, timestamp.
 *
 * Persistence: GitHub JSON (audit-log-YYYY-MM.json) with monthly rotation.
 * In-memory batch buffer flushes every 30 seconds or 50 entries (whichever first).
 *
 * Usage in endpoint functions:
 *   import { logRequest } from './audit-log.mjs';
 *   // ... at end of handler, after building response:
 *   logRequest(event, response);   // fire-and-forget, never awaited
 *   return response;
 */

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'informativ-api';
const BRANCH = 'main';

// In-memory batch buffer (survives warm Lambda reuse, lost on cold start — acceptable)
let _buffer = [];
let _flushTimer = null;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 30000; // 30 seconds

// Endpoints to skip logging (high-frequency, low-value)
const SKIP_ENDPOINTS = new Set([
  '/api/data/version',     // polled frequently by consumers
]);

// Sensitive fields to redact from request bodies
const REDACT_FIELDS = new Set([
  'password', 'token', 'api_key', 'secret', 'authorization',
]);

/**
 * Extract audit-relevant metadata from a request event.
 */
function extractAuditEntry(event, response) {
  const user = event._user || null;
  const path = event.path || event.rawUrl || 'unknown';
  const ip = (event.headers || {})['x-forwarded-for']
    || (event.headers || {})['client-ip']
    || 'unknown';

  return {
    ts: new Date().toISOString(),
    user: user ? user.email : '_anonymous',
    role: user ? (user.roles || []).join(',') : 'api-key',
    method: event.httpMethod || 'UNKNOWN',
    path: path.replace(/\?.*$/, ''),  // strip query params (may contain sensitive data)
    status: response.statusCode || 0,
    ip: ip.split(',')[0].trim(),       // first IP if forwarded chain
    ua: ((event.headers || {})['user-agent'] || '').slice(0, 120),
  };
}

/**
 * Non-blocking log call. Fire-and-forget from endpoint handlers.
 * Buffers entries and flushes to GitHub in batches.
 */
export function logRequest(event, response) {
  // Skip OPTIONS preflight and excluded endpoints
  if (event.httpMethod === 'OPTIONS') return;
  const path = (event.path || '').replace(/\?.*$/, '');
  if (SKIP_ENDPOINTS.has(path)) return;

  try {
    const entry = extractAuditEntry(event, response);
    _buffer.push(entry);

    // Flush immediately if batch is full
    if (_buffer.length >= BATCH_SIZE) {
      _flushToGitHub();
    } else if (!_flushTimer) {
      // Schedule a delayed flush
      _flushTimer = setTimeout(() => _flushToGitHub(), FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    // Audit logging must NEVER break request handling
    console.error('[audit-log] Error buffering entry:', err.message);
  }
}

/**
 * Immediate flush — used by the admin audit-viewer endpoint to ensure
 * all buffered entries are persisted before reading.
 */
export async function flushNow() {
  if (_buffer.length > 0) {
    await _flushToGitHub();
  }
}

/**
 * Get current month's audit log filename.
 */
function getLogFilename() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `audit-log-${yyyy}-${mm}.json`;
}

/**
 * Flush buffered entries to GitHub.
 * Reads existing log file → appends new entries → commits.
 * Non-blocking, catches all errors internally.
 */
async function _flushToGitHub() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }

  if (_buffer.length === 0) return;

  // Grab and clear the buffer atomically
  const entries = _buffer.splice(0);
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    console.warn('[audit-log] No GITHUB_TOKEN — dropping', entries.length, 'audit entries');
    return;
  }

  const filename = getLogFilename();
  const filePath = `data/${filename}`;

  try {
    // Read existing file (may not exist yet for new month)
    let existing = [];
    let sha = null;

    const getResp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}?ref=${BRANCH}`,
      { headers: { Authorization: `token ${token}`, 'User-Agent': 'informativ-audit' } }
    );

    if (getResp.ok) {
      const fileData = await getResp.json();
      sha = fileData.sha;
      const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8');
      try {
        const parsed = JSON.parse(decoded);
        existing = parsed.entries || [];
      } catch {
        existing = [];
      }
    }
    // 404 = new file, that's fine

    // Append new entries
    const allEntries = [...existing, ...entries];

    // Cap at 10,000 entries per month file (trim oldest if exceeded)
    const MAX_ENTRIES = 10000;
    const trimmed = allEntries.length > MAX_ENTRIES
      ? allEntries.slice(allEntries.length - MAX_ENTRIES)
      : allEntries;

    const logBody = JSON.stringify({
      _meta: {
        month: filename.replace('audit-log-', '').replace('.json', ''),
        last_flush: new Date().toISOString(),
        entry_count: trimmed.length,
      },
      entries: trimmed,
    });

    const encoded = Buffer.from(logBody).toString('base64');

    const putBody = {
      message: `[audit] ${entries.length} entries — ${new Date().toISOString().slice(0, 16)}`,
      content: encoded,
      branch: BRANCH,
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'informativ-audit',
        },
        body: JSON.stringify(putBody),
      }
    );

    if (!putResp.ok) {
      const errText = await putResp.text();
      console.error('[audit-log] GitHub commit failed:', putResp.status, errText.slice(0, 200));
      // Put entries back on buffer for retry on next flush
      _buffer.unshift(...entries);
    }
  } catch (err) {
    console.error('[audit-log] Flush error:', err.message);
    // Put entries back for retry
    _buffer.unshift(...entries);
  }
}

/**
 * Read audit log entries for admin viewer.
 * Returns entries from one or more monthly files, filtered by params.
 */
export async function readAuditLog(options = {}) {
  const { days = 7, user = null, endpoint = null, role = null, limit = 500 } = options;
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { entries: [], error: 'No GITHUB_TOKEN configured' };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Determine which monthly files to read
  const filesToRead = [];
  const now = new Date();
  for (let i = 0; i <= Math.ceil(days / 30); i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    filesToRead.push(`audit-log-${yyyy}-${mm}.json`);
  }

  let allEntries = [];

  for (const filename of filesToRead) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/data/${filename}?ref=${BRANCH}`,
        { headers: { Authorization: `token ${token}`, 'User-Agent': 'informativ-audit' } }
      );
      if (!resp.ok) continue;

      const fileData = await resp.json();
      const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      if (parsed.entries) allEntries.push(...parsed.entries);
    } catch {
      // Skip unreadable files
    }
  }

  // Filter
  let filtered = allEntries.filter(e => new Date(e.ts) >= cutoff);
  if (user) filtered = filtered.filter(e => e.user === user);
  if (endpoint) filtered = filtered.filter(e => e.path.includes(endpoint));
  if (role) filtered = filtered.filter(e => e.role.includes(role));

  // Sort descending (newest first), limit
  filtered.sort((a, b) => b.ts.localeCompare(a.ts));
  if (filtered.length > limit) filtered = filtered.slice(0, limit);

  // Build summary stats
  const userCounts = {};
  const endpointCounts = {};
  const statusCounts = {};
  for (const e of filtered) {
    userCounts[e.user] = (userCounts[e.user] || 0) + 1;
    endpointCounts[e.path] = (endpointCounts[e.path] || 0) + 1;
    const bucket = `${Math.floor(e.status / 100)}xx`;
    statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
  }

  return {
    entries: filtered,
    summary: {
      total: filtered.length,
      period_days: days,
      by_user: userCounts,
      by_endpoint: endpointCounts,
      by_status: statusCounts,
    },
  };
}
