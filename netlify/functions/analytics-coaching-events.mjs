/**
 * Coaching Event Tracker — Netlify Serverless Function (Phase 3)
 *
 * Logs coaching events for the effectiveness feedback loop:
 * 1. Chuck coaching sessions (rep engaged coaching-relevant mode)
 * 2. Manager 1:1 confirmations (manager confirmed coaching session delivered)
 * 3. 1:1 prep generation events
 *
 * Flow:
 * 1. Fetches current coaching-events-log.json from GitHub
 * 2. Appends the coaching event
 * 3. Updates manager coaching summary
 * 4. Commits back to GitHub
 *
 * Certification completions are handled separately via certification-complete.mjs
 * and detected by the rebuild pipeline's diff logic.
 *
 * The GitHub token is stored as a Netlify environment variable (GITHUB_TOKEN).
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { safeError } from './safe-error.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'chuck-sales-assistant';
const FILE_PATH = 'coaching-events-log.json';
const BRANCH = 'main';

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

    // GET — retrieve current coaching events
    if (event.httpMethod === 'GET') {
        const token = process.env.GITHUB_TOKEN;
        try {
            if (!token) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        events: [],
                        manager_summary: {},
                        warning: 'GITHUB_TOKEN not configured'
                    })
                };
            }
            const data = await fetchFileFromGitHub(token);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(data.content)
            };
        } catch (e) {
            return safeError(200, 'Failed to fetch coaching events', e, _cors);
        }
    }

    // POST — record a coaching event
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Invalid request body' })
        };
    }

    const { rep_name, event_type, manager_name } = body;

    if (!rep_name || !event_type) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: 'rep_name and event_type are required',
                valid_types: [
                    'chuck_coaching_session',
                    'manager_1on1_confirmed',
                    'one_on_one_prep_generated'
                ]
            })
        };
    }

    // Validate event type
    const validTypes = [
        'chuck_coaching_session',
        'manager_1on1_confirmed',
        'one_on_one_prep_generated'
    ];
    if (!validTypes.includes(event_type)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: `Invalid event_type: ${event_type}`,
                valid_types: validTypes
            })
        };
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'client-only',
                note: 'GITHUB_TOKEN not configured — event saved locally only.'
            })
        };
    }

    try {
        // 1. Fetch current coaching events from GitHub
        const fileData = await fetchFileFromGitHub(githubToken);
        const coachingLog = fileData.content;
        const currentSha = fileData.sha;

        // 2. Build event object
        const coachingEvent = {
            rep_name: body.rep_name,
            event_type: body.event_type,
            event_date: body.event_date || new Date().toISOString(),
            manager_name: body.manager_name || null,
            archetype: body.archetype || null,
            composite: body.composite || null,
            duration_minutes: body.duration_minutes || null,
            metadata: body.metadata || {},
        };

        // 3. Append event
        if (!coachingLog.events) coachingLog.events = [];
        coachingLog.events.push(coachingEvent);

        // 4. Update manager summary
        if (manager_name) {
            if (!coachingLog.manager_summary) coachingLog.manager_summary = {};
            if (!coachingLog.manager_summary[manager_name]) {
                coachingLog.manager_summary[manager_name] = {
                    total_1on1s_confirmed: 0,
                    total_preps_generated: 0,
                    last_coaching_date: null,
                    reps_coached: [],
                };
            }

            const mgrSummary = coachingLog.manager_summary[manager_name];

            if (event_type === 'manager_1on1_confirmed') {
                mgrSummary.total_1on1s_confirmed++;
            } else if (event_type === 'one_on_one_prep_generated') {
                mgrSummary.total_preps_generated++;
            }

            mgrSummary.last_coaching_date = coachingEvent.event_date.split('T')[0];

            if (!mgrSummary.reps_coached.includes(rep_name)) {
                mgrSummary.reps_coached.push(rep_name);
            }
        }

        // 5. Update rep summary
        if (!coachingLog.rep_summary) coachingLog.rep_summary = {};
        if (!coachingLog.rep_summary[rep_name]) {
            coachingLog.rep_summary[rep_name] = {
                total_coaching_events: 0,
                chuck_sessions: 0,
                manager_1on1s: 0,
                last_coached_date: null,
            };
        }

        const repSummary = coachingLog.rep_summary[rep_name];
        repSummary.total_coaching_events++;
        repSummary.last_coached_date = coachingEvent.event_date.split('T')[0];

        if (event_type === 'chuck_coaching_session') {
            repSummary.chuck_sessions++;
        } else if (event_type === 'manager_1on1_confirmed') {
            repSummary.manager_1on1s++;
        }

        // 6. Commit back to GitHub
        const commitMsg = `Coaching event: ${rep_name} — ${event_type}`;
        await commitFileToGitHub(githubToken, coachingLog, currentSha, commitMsg);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'github',
                event: coachingEvent,
                note: 'Coaching event saved to GitHub.'
            })
        };

    } catch (e) {
        console.error('GitHub sync error:', e);
        return safeError(200, 'GitHub sync failed — event saved locally only', e, _cors);
    }
}


// ============================================================
// GitHub API Helpers
// ============================================================

async function fetchFileFromGitHub(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Coaching-Tracker'
        }
    });

    if (response.status === 404) {
        // File doesn't exist yet — return empty structure
        return {
            content: {
                events: [],
                manager_summary: {},
                rep_summary: {},
                schema_version: '1.0',
                created_at: new Date().toISOString(),
            },
            sha: null
        };
    }

    if (!response.ok) {
        throw new Error(`GitHub fetch failed: ${response.status}`);
    }

    const data = await response.json();
    const contentStr = Buffer.from(data.content, 'base64').toString('utf-8');
    const content = JSON.parse(contentStr);

    return { content, sha: data.sha };
}

async function commitFileToGitHub(token, updatedContent, currentSha, commitMessage) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;

    const contentStr = JSON.stringify(updatedContent, null, 2);
    const contentBase64 = Buffer.from(contentStr).toString('base64');

    const payload = {
        message: commitMessage,
        content: contentBase64,
        branch: BRANCH
    };

    if (currentSha) {
        payload.sha = currentSha;
    }

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Coaching-Tracker',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`GitHub commit failed: ${response.status} — ${errorData.message || response.statusText}`);
    }

    return await response.json();
}

// Phase 2B-3: Audit log wrapper
export async function handler(event) {
  const response = await _handler(event);
  logRequest(event, response);
  return response;
}
