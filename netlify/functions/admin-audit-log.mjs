/**
 * Admin Audit Log Viewer — GET /api/admin/audit-log
 *
 * Admin-only endpoint to query the audit trail.
 *
 * Query params:
 *   ?days=7       — lookback window (default 7, max 90)
 *   ?user=email   — filter by user email
 *   ?endpoint=/api/cs  — filter by endpoint path substring
 *   ?role=rep     — filter by role
 *   ?limit=500    — max entries returned (default 500, max 2000)
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { requireRole } from './roles.mjs';
import { flushNow, readAuditLog } from './audit-log.mjs';

export async function handler(event) {
  const corsCheck = handleCors(event);
  if (corsCheck) return corsCheck;
  const authCheck = await authenticateRequest(event);
  if (authCheck) return authCheck;
  const _cors = corsHeaders((event.headers || {}).origin || '');

  // Admin-only
  const roleCheck = requireRole(event, _cors, 'admin');
  if (roleCheck) return roleCheck;

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ..._cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed. Use GET.' }),
    };
  }

  try {
    // Flush any buffered entries before reading
    await flushNow();

    const qs = event.queryStringParameters || {};
    const days = Math.min(parseInt(qs.days) || 7, 90);
    const limit = Math.min(parseInt(qs.limit) || 500, 2000);

    const result = await readAuditLog({
      days,
      user: qs.user || null,
      endpoint: qs.endpoint || null,
      role: qs.role || null,
      limit,
    });

    return {
      statusCode: 200,
      headers: { ..._cors, 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('[admin-audit-log] Error:', err.message);
    return {
      statusCode: 500,
      headers: { ..._cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to read audit log' }),
    };
  }
}
