/**
 * Assignment Manager — Netlify Serverless Function
 *
 * GitHub-persisted account assignments for Customer Intelligence Dashboard.
 * Syncs CS team account ownership across all browsers and users.
 *
 * Flow:
 * 1. GET — Returns all current assignments
 * 2. POST — Accepts single or bulk assignment updates
 * 3. Fetches/commits assignments.json from/to GitHub
 *
 * Data structure:
 * {
 *   assignments: { [customer_id]: { rep_id, rep_name, rep_role, assigned_by, assigned_at } },
 *   summary: { [rep_id]: { count, last_updated } },
 *   schema_version: "1.0",
 *   last_modified: ISO timestamp
 * }
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'chuck-sales-assistant';
const FILE_PATH = 'assignments.json';
const BRANCH = 'main';

async function _handler(event) {
    // --- Unified API Gateway middleware ---
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');


    const headers = {
        'Content-Type': 'application/json',
        ..._cors
    };

    // GET — retrieve all assignments
    if (event.httpMethod === 'GET') {
        const token = process.env.GITHUB_TOKEN;
        try {
            if (!token) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        assignments: {},
                        summary: {},
                        warning: 'GITHUB_TOKEN not configured'
                    })
                };
            }
            const data = await fetchFileFromGitHub(token);
            const assignments = data.content.assignments || {};
            const summary = data.content.summary || {};

            // Optional filter by rep_id
            const queryParams = event.queryStringParameters || {};
            let filtered = assignments;
            if (queryParams.rep_id) {
                filtered = {};
                for (const [custId, info] of Object.entries(assignments)) {
                    if (info.rep_id === queryParams.rep_id) {
                        filtered[custId] = info;
                    }
                }
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    assignments: filtered,
                    summary,
                    total_assigned: Object.keys(assignments).length,
                    last_modified: data.content.last_modified || null
                })
            };
        } catch (e) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    assignments: {},
                    summary: {},
                    error: e.message
                })
            };
        }
    }

    // POST — update assignments (single or bulk)
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

    // Accept either single assignment or bulk array
    // Single: { customer_id, rep_id, rep_name, rep_role, assigned_by }
    // Bulk: { assignments: [ { customer_id, rep_id, rep_name, rep_role } ], assigned_by }
    // Unassign: { customer_id, rep_id: null, assigned_by }
    const updates = [];

    if (body.assignments && Array.isArray(body.assignments)) {
        // Bulk mode
        for (const item of body.assignments) {
            if (!item.customer_id) continue;
            updates.push({
                customer_id: item.customer_id,
                rep_id: item.rep_id || null,
                rep_name: item.rep_name || null,
                rep_role: item.rep_role || null,
                assigned_by: item.assigned_by || body.assigned_by || 'system'
            });
        }
    } else if (body.customer_id) {
        // Single mode
        updates.push({
            customer_id: body.customer_id,
            rep_id: body.rep_id || null,
            rep_name: body.rep_name || null,
            rep_role: body.rep_role || null,
            assigned_by: body.assigned_by || 'system'
        });
    } else {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: 'Provide customer_id (single) or assignments array (bulk)',
                example_single: { customer_id: 'MCID001', rep_id: 'kf', rep_name: 'Kelly Felder', rep_role: 'CSM', assigned_by: 'ks' },
                example_bulk: { assignments: [{ customer_id: 'MCID001', rep_id: 'kf', rep_name: 'Kelly Felder', rep_role: 'CSM' }], assigned_by: 'ks' }
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
                updated: updates.length,
                note: 'GITHUB_TOKEN not configured — assignments saved locally only.'
            })
        };
    }

    try {
        // 1. Fetch current assignments from GitHub
        const fileData = await fetchFileFromGitHub(githubToken);
        const assignmentData = fileData.content;
        const currentSha = fileData.sha;

        if (!assignmentData.assignments) assignmentData.assignments = {};
        if (!assignmentData.summary) assignmentData.summary = {};

        const now = new Date().toISOString();
        let assigned = 0;
        let unassigned = 0;

        // 2. Apply updates
        for (const update of updates) {
            if (update.rep_id) {
                // Assign
                assignmentData.assignments[update.customer_id] = {
                    rep_id: update.rep_id,
                    rep_name: update.rep_name,
                    rep_role: update.rep_role,
                    assigned_by: update.assigned_by,
                    assigned_at: now
                };
                assigned++;
            } else {
                // Unassign
                delete assignmentData.assignments[update.customer_id];
                unassigned++;
            }
        }

        // 3. Rebuild summary (rep_id → count + last_updated)
        const summary = {};
        for (const [custId, info] of Object.entries(assignmentData.assignments)) {
            if (!info.rep_id) continue;
            if (!summary[info.rep_id]) {
                summary[info.rep_id] = {
                    rep_name: info.rep_name,
                    rep_role: info.rep_role,
                    count: 0,
                    last_updated: info.assigned_at
                };
            }
            summary[info.rep_id].count++;
            if (info.assigned_at > summary[info.rep_id].last_updated) {
                summary[info.rep_id].last_updated = info.assigned_at;
            }
        }
        assignmentData.summary = summary;
        assignmentData.last_modified = now;

        // 4. Commit to GitHub
        const commitMsg = updates.length === 1
            ? `Assignment: ${updates[0].customer_id} → ${updates[0].rep_name || 'unassigned'}`
            : `Assignments: bulk update (${updates.length} changes)`;

        await commitFileToGitHub(githubToken, assignmentData, currentSha, commitMsg);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'github',
                assigned,
                unassigned,
                total_assigned: Object.keys(assignmentData.assignments).length,
                note: `${updates.length} assignment(s) saved to GitHub.`
            })
        };

    } catch (e) {
        console.error('GitHub sync error:', e);
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'client-only',
                error: e.message,
                note: 'GitHub sync failed — assignments saved locally only.'
            })
        };
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
            'User-Agent': 'Chuck-Assignment-Manager'
        }
    });

    if (response.status === 404) {
        return {
            content: {
                assignments: {},
                summary: {},
                schema_version: '1.0',
                created_at: new Date().toISOString(),
                last_modified: new Date().toISOString()
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
            'User-Agent': 'Chuck-Assignment-Manager',
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
