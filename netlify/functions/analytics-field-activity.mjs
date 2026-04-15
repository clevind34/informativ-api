/**
 * PIE Mobile Activity Logger — Netlify Serverless Function
 *
 * Logs field sales activities from PIE Mobile.
 * GitHub-persisted to pie-activity-log.json in the pie-mobile repo.
 *
 * Activity types: call_inbound, call_outbound, email, visit, meeting, demo, text, disposition
 *
 * POST body: { rep, prospect_id, prospect_name, prospect_type, activity_type, outcome, notes, dealer_intel, timestamp }
 * GET: Returns full activity log
 * GET ?rep=Name: Filter by rep
 * GET ?prospect_id=123: Filter by prospect
 * GET ?days=30: Filter by recency
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { safeError } from './safe-error.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'pie-mobile';
const FILE_PATH = 'pie-activity-log.json';
const BRANCH = 'main';
const MAX_EVENTS = 15000;

async function _handler(event) {
    // --- Unified API Gateway middleware ---
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');
    const rlCheck = checkRateLimit(event, _cors);
    if (rlCheck) return rlCheck;


    const headers = {
        'Content-Type': 'application/json',
        ..._cors
    };

    const token = process.env.GITHUB_TOKEN;

    if (event.httpMethod === 'GET') {
        try {
            if (!token) {
                return { statusCode: 200, headers, body: JSON.stringify({ activities: [], warning: 'GITHUB_TOKEN not configured' }) };
            }
            const data = await fetchFileFromGitHub(token);
            const log = data.content;
            let activities = log.activities || [];
            const q = event.queryStringParameters || {};

            if (q.rep) {
                activities = activities.filter(a => a.rep === q.rep);
            }
            if (q.prospect_id) {
                activities = activities.filter(a => a.prospect_id === q.prospect_id);
            }
            if (q.days) {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - parseInt(q.days));
                const cutoffISO = cutoff.toISOString();
                activities = activities.filter(a => a.timestamp >= cutoffISO);
            }

            return {
                statusCode: 200, headers,
                body: JSON.stringify({ activities, total: activities.length, last_updated: log.last_updated })
            };
        } catch (err) {
            return safeError(200, 'Failed to fetch activities', err, _cors);
        }
    }

    if (event.httpMethod === 'POST') {
        try {
            const body = JSON.parse(event.body || '{}');
            const { rep, prospect_id, activity_type } = body;

            if (!rep || !activity_type) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'rep and activity_type required' }) };
            }

            if (!token) {
                return { statusCode: 200, headers, body: JSON.stringify({ warning: 'GITHUB_TOKEN not configured, activity not persisted' }) };
            }

            let log = { activities: [], schema_version: '1.0' };
            let sha = null;
            try {
                const data = await fetchFileFromGitHub(token);
                log = data.content;
                sha = data.sha;
            } catch (e) {
                // File doesn't exist — will create
            }

            if (!log.activities) log.activities = [];

            const activity = {
                id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                rep,
                prospect_id: prospect_id || null,
                prospect_name: body.prospect_name || null,
                prospect_type: body.prospect_type || null,
                activity_type,
                outcome: body.outcome || null,
                notes: body.notes || null,
                dealer_intel: body.dealer_intel || null,
                source: 'pie_mobile',
                timestamp: body.timestamp || new Date().toISOString()
            };

            log.activities.push(activity);

            if (log.activities.length > MAX_EVENTS) {
                log.activities = log.activities.slice(log.activities.length - MAX_EVENTS);
            }

            log.last_updated = new Date().toISOString();
            log.schema_version = '1.0';

            await commitFileToGitHub(token, log, sha);

            return {
                statusCode: 200, headers,
                body: JSON.stringify({ success: true, id: activity.id, total_activities: log.activities.length })
            };
        } catch (err) {
            return safeError(500, 'Activity logging failed', err, _cors);
        }
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
}

async function fetchFileFromGitHub(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
    const resp = await fetch(url, {
        headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!resp.ok) throw new Error(`GitHub fetch failed: ${resp.status}`);
    const data = await resp.json();
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return { content, sha: data.sha };
}

async function commitFileToGitHub(token, content, sha) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const body = {
        message: `Activity log update — ${new Date().toISOString().split('T')[0]}`,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
        branch: BRANCH
    };
    if (sha) body.sha = sha;
    const resp = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json' },
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`GitHub commit failed: ${resp.status} — ${errText}`);
    }
}

// Phase 2B-3: Audit log wrapper
export async function handler(event) {
  const response = await _handler(event);
  logRequest(event, response);
  return response;
}
