/**
 * PIE Route Planner — Netlify Serverless Function
 *
 * GitHub-persisted day-of-week route plans for field sales reps.
 * Desktop plans routes (Mon-Fri), mobile executes "Today's Route."
 * Cross-device sync via unified API gateway.
 *
 * Flow:
 * 1. GET  — Returns full week or single day for a rep
 * 2. POST — Replace full day, or action-based (add_stop, remove_stop, reorder, move_stop, clear)
 * 3. DELETE — Clear a rep's day or entire week
 *
 * Data structure:
 * {
 *   routes: {
 *     "Rep Name": {
 *       monday:    [{ id, co, cn, ph, em, city, st, addr, oem, notes, added_at }],
 *       tuesday:   [...],
 *       wednesday: [...],
 *       thursday:  [...],
 *       friday:    [...]
 *     }
 *   },
 *   schema_version: "1.0",
 *   last_modified: ISO timestamp
 * }
 *
 * Query params:
 *   ?rep=Name        (required for all)
 *   ?day=monday      (optional — single day; omit for full week)
 *   ?action=add_stop|remove_stop|reorder|move_stop|clear  (POST only)
 *
 * Max 25 stops per day.
 *
 * Hosted on: informativ-sales-api.netlify.app
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { safeError } from './safe-error.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'informativ-api';
const FILE_PATH = 'pie-routes.json';
const BRANCH = 'main';
const MAX_STOPS_PER_DAY = 25;
const VALID_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

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
    if (!token) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: false, error: 'No GitHub token configured', routes: {} })
        };
    }

    const params = event.queryStringParameters || {};
    const rep = params.rep;

    if (!rep) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ success: false, error: 'Missing required param: rep' })
        };
    }

    const day = params.day ? params.day.toLowerCase() : null;
    if (day && !VALID_DAYS.includes(day)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ success: false, error: `Invalid day: ${day}. Must be one of: ${VALID_DAYS.join(', ')}` })
        };
    }

    try {
        if (event.httpMethod === 'GET') {
            return await handleGet(token, headers, rep, day);
        } else if (event.httpMethod === 'POST') {
            return await handlePost(event, token, headers, rep, day, params.action);
        } else if (event.httpMethod === 'DELETE') {
            return await handleDelete(token, headers, rep, day);
        }

        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    } catch (err) {
        console.error('cs-routes error:', err);
        return safeError(200, 'Route operation failed', err, _cors);
    }
}


// ============================================================
// GET — Return rep's routes (full week or single day)
// ============================================================

async function handleGet(token, headers, rep, day) {
    const { content } = await fetchFileFromGitHub(token);
    const repRoutes = content.routes?.[rep] || emptyWeek();

    if (day) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                rep,
                day,
                stops: repRoutes[day] || [],
                count: (repRoutes[day] || []).length,
                last_modified: content.last_modified || null
            })
        };
    }

    // Full week
    const summary = {};
    for (const d of VALID_DAYS) {
        summary[d] = (repRoutes[d] || []).length;
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            rep,
            routes: repRoutes,
            summary,
            last_modified: content.last_modified || null
        })
    };
}


// ============================================================
// POST — Modify rep's route (full replace or action-based)
// ============================================================

async function handlePost(event, token, headers, rep, day, action) {
    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ success: false, error: 'Invalid JSON body' })
        };
    }

    const { content, sha } = await fetchFileFromGitHub(token);

    // Ensure rep structure exists
    if (!content.routes) content.routes = {};
    if (!content.routes[rep]) content.routes[rep] = emptyWeek();

    let commitMsg = '';

    if (!action) {
        // Full day replace — requires day param and stops array
        if (!day) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ success: false, error: 'POST without action requires ?day= param' })
            };
        }
        const stops = body.stops;
        if (!Array.isArray(stops)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ success: false, error: 'Body must contain stops array' })
            };
        }
        if (stops.length > MAX_STOPS_PER_DAY) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ success: false, error: `Max ${MAX_STOPS_PER_DAY} stops per day` })
            };
        }
        content.routes[rep][day] = stops;
        commitMsg = `Route update: ${rep} ${day} (${stops.length} stops)`;

    } else {
        // Action-based mutations
        switch (action) {
            case 'add_stop': {
                if (!day) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'add_stop requires ?day= param' }) };
                }
                const stop = body.stop;
                if (!stop || !stop.id) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain stop object with id' }) };
                }
                const dayStops = content.routes[rep][day] || [];
                // Duplicate check
                if (dayStops.find(s => s.id === stop.id)) {
                    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'Stop already exists on this day' }) };
                }
                if (dayStops.length >= MAX_STOPS_PER_DAY) {
                    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: `Max ${MAX_STOPS_PER_DAY} stops per day` }) };
                }
                // Allow specifying position (for insert-at-index), default to end
                const pos = typeof body.position === 'number' ? Math.min(body.position, dayStops.length) : dayStops.length;
                stop.added_at = stop.added_at || new Date().toISOString();
                dayStops.splice(pos, 0, stop);
                content.routes[rep][day] = dayStops;
                commitMsg = `Route add: ${stop.co || stop.id} → ${rep} ${day}`;
                break;
            }

            case 'remove_stop': {
                if (!day) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'remove_stop requires ?day= param' }) };
                }
                const removeId = body.stop_id || body.id;
                if (!removeId) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain stop_id' }) };
                }
                const before = (content.routes[rep][day] || []).length;
                content.routes[rep][day] = (content.routes[rep][day] || []).filter(s => s.id !== removeId);
                const removed = before - content.routes[rep][day].length;
                commitMsg = `Route remove: ${removeId} from ${rep} ${day} (${removed} removed)`;
                break;
            }

            case 'reorder': {
                if (!day) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'reorder requires ?day= param' }) };
                }
                const orderedIds = body.order;
                if (!Array.isArray(orderedIds)) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain order array of stop IDs' }) };
                }
                const currentStops = content.routes[rep][day] || [];
                const stopMap = {};
                for (const s of currentStops) stopMap[s.id] = s;
                // Rebuild in requested order, append any not in order list at end
                const reordered = [];
                for (const id of orderedIds) {
                    if (stopMap[id]) {
                        reordered.push(stopMap[id]);
                        delete stopMap[id];
                    }
                }
                // Append any orphans
                for (const s of Object.values(stopMap)) reordered.push(s);
                content.routes[rep][day] = reordered;
                commitMsg = `Route reorder: ${rep} ${day} (${reordered.length} stops)`;
                break;
            }

            case 'move_stop': {
                // Move a stop up or down by one position (arrow tap)
                if (!day) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'move_stop requires ?day= param' }) };
                }
                const moveId = body.stop_id || body.id;
                const direction = body.direction; // 'up' or 'down'
                if (!moveId || !direction) {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain stop_id and direction (up/down)' }) };
                }
                if (direction !== 'up' && direction !== 'down') {
                    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'direction must be "up" or "down"' }) };
                }
                const dayArr = content.routes[rep][day] || [];
                const idx = dayArr.findIndex(s => s.id === moveId);
                if (idx === -1) {
                    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'Stop not found' }) };
                }
                const newIdx = direction === 'up' ? idx - 1 : idx + 1;
                if (newIdx < 0 || newIdx >= dayArr.length) {
                    // Already at boundary — return current state, no commit
                    return {
                        statusCode: 200,
                        headers,
                        body: JSON.stringify({ success: true, message: 'Already at boundary', stops: dayArr, count: dayArr.length })
                    };
                }
                // Swap adjacent
                [dayArr[idx], dayArr[newIdx]] = [dayArr[newIdx], dayArr[idx]];
                content.routes[rep][day] = dayArr;
                commitMsg = `Route move: ${moveId} ${direction} in ${rep} ${day}`;
                break;
            }

            case 'clear': {
                if (day) {
                    content.routes[rep][day] = [];
                    commitMsg = `Route clear: ${rep} ${day}`;
                } else {
                    content.routes[rep] = emptyWeek();
                    commitMsg = `Route clear: ${rep} full week`;
                }
                break;
            }

            default:
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, error: `Unknown action: ${action}. Valid: add_stop, remove_stop, reorder, move_stop, clear` })
                };
        }
    }

    content.last_modified = new Date().toISOString();

    // Commit to GitHub
    await commitFileToGitHub(token, content, sha, commitMsg);

    // Return updated day or full week
    const repRoutes = content.routes[rep];
    if (day) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                rep,
                day,
                stops: repRoutes[day],
                count: repRoutes[day].length,
                last_modified: content.last_modified
            })
        };
    }

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            rep,
            routes: repRoutes,
            last_modified: content.last_modified
        })
    };
}


// ============================================================
// DELETE — Clear a rep's day or full week
// ============================================================

async function handleDelete(token, headers, rep, day) {
    const { content, sha } = await fetchFileFromGitHub(token);

    if (!content.routes?.[rep]) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, message: 'No routes to clear' })
        };
    }

    if (day) {
        content.routes[rep][day] = [];
    } else {
        content.routes[rep] = emptyWeek();
    }

    content.last_modified = new Date().toISOString();
    const msg = day ? `Route delete: ${rep} ${day}` : `Route delete: ${rep} full week`;
    await commitFileToGitHub(token, content, sha, msg);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            rep,
            day: day || 'all',
            message: day ? `Cleared ${day}` : 'Cleared full week',
            last_modified: content.last_modified
        })
    };
}


// ============================================================
// Helpers
// ============================================================

function emptyWeek() {
    return { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [] };
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
            'User-Agent': 'PIE-Route-Planner'
        }
    });

    if (response.status === 404) {
        return {
            content: {
                routes: {},
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
            'User-Agent': 'PIE-Route-Planner',
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
