/**
 * MCID Action Log — Netlify Serverless Function
 *
 * Tracks user actions taken against MCID hygiene findings (status drift, missing
 * records, etc.) surfaced by the CI Dashboard "MCID Hygiene" tab.
 *
 * Each action records:
 *   - WHO took the action (taken_by from JWT identity)
 *   - WHAT (mcid, drift_type, action_type)
 *   - WHEN (taken_at ISO timestamp)
 *   - WHY (notes free text, optional assigned_to)
 *   - CONTEXT snapshot of the record at the time of action (so the audit log
 *     stays meaningful even after the underlying drift is resolved).
 *
 * Persistence:
 *   - data/mcid-action-log.json in clevind34/informativ-api (gateway repo itself)
 *   - All entries are append-only; status is encoded in the action_type
 *
 * Endpoints:
 *   GET  /api/cs/mcid-actions             — full log (newest first)
 *   GET  /api/cs/mcid-actions?mcid=X      — filter by MCID
 *   GET  /api/cs/mcid-actions?taken_by=X  — filter by user email
 *   GET  /api/cs/mcid-actions?action_type=X — filter by action type
 *   GET  /api/cs/mcid-actions?days=30     — filter by lookback window
 *   POST /api/cs/mcid-actions             — append a new action
 *
 * Identity:
 *   - taken_by is read from event._user (JWT). If no user (server-to-server),
 *     body.taken_by is honored as a fallback for pipeline-driven entries.
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { safeError } from './safe-error.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'informativ-api';
const FILE_PATH = 'data/mcid-action-log.json';
const BRANCH = 'main';

const VALID_ACTION_TYPES = [
    'marked_reviewed',
    'provisioned_in_sfdc',
    'status_corrected',
    'wont_fix',
    'test_data_filtered',
    'assigned',
    'note_added',
];

const VALID_DRIFT_TYPES = [
    'missing_from_sfdc',
    'in_flight_onboard',
    'terminated_but_active',
    'prospect_but_active',
    'sfdc_no_mcid',
    'test_data',
    'other',
];

async function _handler(event) {
    // Gateway middleware
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');
    const rlCheck = checkRateLimit(event, _cors);
    if (rlCheck) return rlCheck;

    const headers = {
        'Content-Type': 'application/json',
        ..._cors,
    };

    // ---------- GET ----------
    if (event.httpMethod === 'GET') {
        const token = process.env.GITHUB_TOKEN;
        try {
            if (!token) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        actions: [],
                        total_count: 0,
                        warning: 'GITHUB_TOKEN not configured',
                    }),
                };
            }
            const data = await fetchFileFromGitHub(token);
            let actions = data.content.actions || [];
            const q = event.queryStringParameters || {};

            if (q.mcid) {
                const target = String(q.mcid);
                actions = actions.filter((a) => String(a.mcid) === target);
            }
            if (q.taken_by) {
                const t = q.taken_by.toLowerCase();
                actions = actions.filter((a) => (a.taken_by || '').toLowerCase() === t);
            }
            if (q.action_type) {
                actions = actions.filter((a) => a.action_type === q.action_type);
            }
            if (q.drift_type) {
                actions = actions.filter((a) => a.drift_type === q.drift_type);
            }
            if (q.days) {
                const days = parseInt(q.days, 10);
                if (Number.isFinite(days) && days > 0) {
                    const cutoff = Date.now() - days * 86400000;
                    actions = actions.filter((a) => new Date(a.taken_at).getTime() >= cutoff);
                }
            }

            actions.sort((a, b) => new Date(b.taken_at) - new Date(a.taken_at));

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    actions,
                    total_count: actions.length,
                    schema_version: data.content.schema_version || '1.0',
                }),
            };
        } catch (e) {
            return safeError(200, 'Failed to fetch MCID actions', e, _cors);
        }
    }

    // ---------- POST ----------
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' }),
        };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Invalid request body' }),
        };
    }

    const { mcid, action_type, drift_type, notes, assigned_to, context } = body;

    if (mcid === undefined || mcid === null || mcid === '') {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'mcid is required' }),
        };
    }
    if (!action_type || !VALID_ACTION_TYPES.includes(action_type)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: `action_type must be one of: ${VALID_ACTION_TYPES.join(', ')}`,
            }),
        };
    }
    if (drift_type && !VALID_DRIFT_TYPES.includes(drift_type)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: `drift_type must be one of: ${VALID_DRIFT_TYPES.join(', ')}`,
            }),
        };
    }

    // Identity from JWT (with body fallback for pipeline-driven entries)
    const user = event._user || null;
    const takenBy = (user && user.email)
        || body.taken_by
        || 'unknown';
    const takenByName = (user && (user.user_metadata && user.user_metadata.full_name))
        || (user && user.email)
        || body.taken_by_name
        || takenBy;

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'client-only',
                note: 'GITHUB_TOKEN not configured — action saved locally only.',
            }),
        };
    }

    try {
        const fileData = await fetchFileFromGitHub(githubToken);
        const log = fileData.content;
        const sha = fileData.sha;

        const id = `act_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

        const action = {
            id,
            mcid: typeof mcid === 'string' ? parseInt(mcid, 10) || mcid : mcid,
            drift_type: drift_type || 'other',
            action_type,
            notes: notes || null,
            assigned_to: assigned_to || null,
            taken_by: takenBy,
            taken_by_name: takenByName,
            taken_at: body.taken_at || new Date().toISOString(),
            context: context || null,
        };

        if (!log.actions) log.actions = [];
        log.actions.push(action);
        log.last_updated = new Date().toISOString();

        const commitMsg = `MCID action: ${action.mcid} — ${action.action_type} by ${takenBy}`;
        await commitFileToGitHub(githubToken, log, sha, commitMsg);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'github',
                action_id: id,
                action,
            }),
        };
    } catch (e) {
        console.error('GitHub sync error:', e);
        return safeError(200, 'GitHub sync failed', e, _cors);
    }
}

// ============================================================
// GitHub helpers
// ============================================================
async function fetchFileFromGitHub(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
    const response = await fetch(url, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'MCID-Action-Log',
        },
    });
    if (response.status === 404) {
        return {
            content: {
                actions: [],
                schema_version: '1.0',
                created_at: new Date().toISOString(),
            },
            sha: null,
        };
    }
    if (!response.ok) throw new Error(`GitHub fetch failed: ${response.status}`);
    const data = await response.json();
    const contentStr = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content: JSON.parse(contentStr), sha: data.sha };
}

async function commitFileToGitHub(token, updated, currentSha, message) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const contentStr = JSON.stringify(updated, null, 2);
    const payload = {
        message,
        content: Buffer.from(contentStr).toString('base64'),
        branch: BRANCH,
    };
    if (currentSha) payload.sha = currentSha;

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'MCID-Action-Log',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`GitHub commit failed: ${response.status} — ${err.message || response.statusText}`);
    }
    return response.json();
}

// Audit log wrapper
export async function handler(event) {
    const response = await _handler(event);
    logRequest(event, response);
    return response;
}
