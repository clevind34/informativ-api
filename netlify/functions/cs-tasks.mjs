/**
 * PIE Follow-Up Tasks — Netlify Serverless Function
 *
 * GitHub-persisted follow-up tasks for field sales reps.
 * Reps create tasks from detail panels (manual) or via disposition auto-creation.
 * Task list view shows Today / Upcoming / Completed sections.
 * Chuck AI outputs (call prep, email drafts, scripts) can be saved to a task.
 *
 * Flow:
 * 1. GET    — Returns tasks for a rep, filterable by date_range
 * 2. POST   — Action-based: create, complete, reschedule, save_chuck_output, update_note, reopen
 * 3. DELETE — Remove a task or clear all for a rep
 *
 * Data structure:
 * {
 *   tasks: {
 *     "Rep Name": [
 *       {
 *         id: "task_<timestamp>_<random>",
 *         rep: "Rep Name",
 *         prospect_id: "100042",
 *         prospect_type: "nn" | "cs" | "aff",
 *         prospect_name: "Toyota of Tampa",
 *         city: "Tampa",
 *         state: "FL",
 *         due_date: "2026-04-28",              // YYYY-MM-DD
 *         created_date: "2026-04-24T15:30:00Z",
 *         completed_date: null | "2026-04-28T10:15:00Z",
 *         note: "Follow up on Compliance pricing",
 *         status: "open" | "completed",
 *         source: "manual" | "disposition_auto" | "daily_focus",
 *         disposition_id: null | "disp_xyz",
 *         chuck_output: null | { mode, text, generated_at },
 *         completion_note: null | "Had great call, scheduled demo for 5/2"
 *       }
 *     ]
 *   },
 *   schema_version: "1.0",
 *   last_modified: ISO timestamp
 * }
 *
 * Query params:
 *   ?rep=Name                          (required for all)
 *   ?date_range=today|upcoming|completed|overdue|all  (GET; default: all-open)
 *   ?action=create|complete|reschedule|save_chuck_output|update_note|reopen  (POST)
 *   ?task_id=<id>                      (DELETE; optional — omit to clear all rep's tasks)
 *
 * Max 100 open tasks per rep. Hard cap prevents runaway.
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
const FILE_PATH = 'pie-tasks.json';
const BRANCH = 'main';
const MAX_OPEN_TASKS_PER_REP = 100;
const VALID_DATE_RANGES = ['today', 'upcoming', 'completed', 'overdue', 'all'];
const VALID_PROSPECT_TYPES = ['nn', 'cs', 'aff'];
const VALID_SOURCES = ['manual', 'disposition_auto', 'daily_focus', 'pipeline_triage'];
const VALID_CHUCK_MODES = ['call_prep', 'follow_up', 'discovery_script'];

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
            body: JSON.stringify({ success: false, error: 'No GitHub token configured', tasks: [] })
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

    try {
        if (event.httpMethod === 'GET') {
            return await handleGet(token, headers, rep, params.date_range);
        } else if (event.httpMethod === 'POST') {
            return await handlePost(event, token, headers, rep, params.action);
        } else if (event.httpMethod === 'DELETE') {
            return await handleDelete(token, headers, rep, params.task_id);
        }

        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    } catch (err) {
        console.error('cs-tasks error:', err);
        return safeError(200, 'Task operation failed', err, _cors);
    }
}


// ============================================================
// GET — Return rep's tasks, filtered by date_range
// ============================================================

async function handleGet(token, headers, rep, dateRange) {
    const range = (dateRange || 'all').toLowerCase();
    if (!VALID_DATE_RANGES.includes(range)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ success: false, error: `Invalid date_range. Valid: ${VALID_DATE_RANGES.join(', ')}` })
        };
    }

    const { content } = await fetchFileFromGitHub(token);
    const repTasks = content.tasks?.[rep] || [];

    const todayIso = todayDateStr();
    const upcomingLimit = addDays(todayIso, 7);
    const completedLookback = addDays(todayIso, -14);

    let filtered;
    if (range === 'today') {
        filtered = repTasks.filter(t => t.status === 'open' && t.due_date <= todayIso);
    } else if (range === 'overdue') {
        filtered = repTasks.filter(t => t.status === 'open' && t.due_date < todayIso);
    } else if (range === 'upcoming') {
        filtered = repTasks.filter(t => t.status === 'open' && t.due_date > todayIso && t.due_date <= upcomingLimit);
    } else if (range === 'completed') {
        filtered = repTasks.filter(t => t.status === 'completed' && (t.completed_date || '').slice(0, 10) >= completedLookback);
    } else {
        // 'all' → all open tasks + last 14 days of completed
        filtered = repTasks.filter(t => {
            if (t.status === 'open') return true;
            return (t.completed_date || '').slice(0, 10) >= completedLookback;
        });
    }

    // Compute summary counts (across all, not just filtered)
    const summary = {
        today: repTasks.filter(t => t.status === 'open' && t.due_date <= todayIso).length,
        upcoming: repTasks.filter(t => t.status === 'open' && t.due_date > todayIso && t.due_date <= upcomingLimit).length,
        overdue: repTasks.filter(t => t.status === 'open' && t.due_date < todayIso).length,
        total_open: repTasks.filter(t => t.status === 'open').length,
        completed_14d: repTasks.filter(t => t.status === 'completed' && (t.completed_date || '').slice(0, 10) >= completedLookback).length
    };

    // Sort: open tasks by due_date asc (oldest first); completed by completed_date desc (newest first)
    filtered.sort((a, b) => {
        if (a.status === 'open' && b.status === 'open') {
            return (a.due_date || '').localeCompare(b.due_date || '');
        }
        if (a.status === 'completed' && b.status === 'completed') {
            return (b.completed_date || '').localeCompare(a.completed_date || '');
        }
        return a.status === 'open' ? -1 : 1;
    });

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            rep,
            date_range: range,
            tasks: filtered,
            count: filtered.length,
            summary,
            last_modified: content.last_modified || null
        })
    };
}


// ============================================================
// POST — Action-based task mutations
// ============================================================

async function handlePost(event, token, headers, rep, action) {
    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ success: false, error: 'Invalid JSON body' })
        };
    }

    if (!action) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ success: false, error: 'Missing required param: action. Valid: create, complete, reschedule, save_chuck_output, update_note, reopen' })
        };
    }

    const { content, sha } = await fetchFileFromGitHub(token);
    if (!content.tasks) content.tasks = {};
    if (!content.tasks[rep]) content.tasks[rep] = [];

    let commitMsg = '';
    let responseTask = null;

    switch (action) {
        case 'create': {
            const validationErr = validateCreatePayload(body);
            if (validationErr) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: validationErr }) };
            }

            const openCount = content.tasks[rep].filter(t => t.status === 'open').length;
            if (openCount >= MAX_OPEN_TASKS_PER_REP) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ success: false, error: `Max ${MAX_OPEN_TASKS_PER_REP} open tasks per rep. Complete or remove tasks first.` })
                };
            }

            // Duplicate detection: same prospect_id + same due_date + status=open
            const dup = content.tasks[rep].find(t =>
                t.status === 'open' &&
                t.prospect_id === body.prospect_id &&
                t.due_date === body.due_date
            );
            if (dup) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: false,
                        error: 'Duplicate task (same prospect + same due date already open)',
                        existing_task: dup
                    })
                };
            }

            const newTask = {
                id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                rep,
                prospect_id: String(body.prospect_id),
                prospect_type: body.prospect_type,
                prospect_name: body.prospect_name || '',
                city: body.city || '',
                state: body.state || '',
                due_date: body.due_date,
                created_date: new Date().toISOString(),
                completed_date: null,
                note: (body.note || '').slice(0, 500),
                status: 'open',
                source: body.source || 'manual',
                disposition_id: body.disposition_id || null,
                chuck_output: null,
                completion_note: null
            };

            content.tasks[rep].push(newTask);
            responseTask = newTask;
            commitMsg = `Task create: ${newTask.prospect_name || newTask.prospect_id} → ${rep} ${newTask.due_date}`;
            break;
        }

        case 'complete': {
            const taskId = body.task_id;
            if (!taskId) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain task_id' }) };
            }
            const task = content.tasks[rep].find(t => t.id === taskId);
            if (!task) {
                return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Task not found' }) };
            }
            if (task.status === 'completed') {
                return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Already completed', task }) };
            }
            task.status = 'completed';
            task.completed_date = new Date().toISOString();
            if (body.completion_note) task.completion_note = String(body.completion_note).slice(0, 500);
            responseTask = task;
            commitMsg = `Task complete: ${task.prospect_name || task.prospect_id} → ${rep}`;
            break;
        }

        case 'reopen': {
            const taskId = body.task_id;
            if (!taskId) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain task_id' }) };
            }
            const task = content.tasks[rep].find(t => t.id === taskId);
            if (!task) {
                return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Task not found' }) };
            }
            task.status = 'open';
            task.completed_date = null;
            task.completion_note = null;
            // If reopening a past-due task, push due date to today
            if (task.due_date < todayDateStr()) {
                task.due_date = todayDateStr();
            }
            responseTask = task;
            commitMsg = `Task reopen: ${task.prospect_name || task.prospect_id} → ${rep}`;
            break;
        }

        case 'reschedule': {
            const taskId = body.task_id;
            const newDate = body.new_due_date;
            if (!taskId || !newDate) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain task_id and new_due_date (YYYY-MM-DD)' }) };
            }
            if (!isValidDateStr(newDate)) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'new_due_date must be valid YYYY-MM-DD format' }) };
            }
            const task = content.tasks[rep].find(t => t.id === taskId);
            if (!task) {
                return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Task not found' }) };
            }
            task.due_date = newDate;
            if (body.note !== undefined) task.note = String(body.note).slice(0, 500);
            responseTask = task;
            commitMsg = `Task reschedule: ${task.prospect_name || task.prospect_id} → ${rep} ${newDate}`;
            break;
        }

        case 'save_chuck_output': {
            const taskId = body.task_id;
            const chuckText = body.chuck_output;
            const chuckMode = body.chuck_mode || 'unknown';
            if (!taskId || !chuckText) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain task_id and chuck_output' }) };
            }
            if (body.chuck_mode && !VALID_CHUCK_MODES.includes(body.chuck_mode)) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: `Invalid chuck_mode. Valid: ${VALID_CHUCK_MODES.join(', ')}` }) };
            }
            const task = content.tasks[rep].find(t => t.id === taskId);
            if (!task) {
                return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Task not found' }) };
            }
            task.chuck_output = {
                mode: chuckMode,
                text: String(chuckText).slice(0, 10000),
                generated_at: new Date().toISOString()
            };
            responseTask = task;
            commitMsg = `Task chuck output: ${chuckMode} → ${task.prospect_name || task.prospect_id}`;
            break;
        }

        case 'update_note': {
            const taskId = body.task_id;
            if (!taskId) {
                return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Body must contain task_id' }) };
            }
            const task = content.tasks[rep].find(t => t.id === taskId);
            if (!task) {
                return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Task not found' }) };
            }
            task.note = String(body.note || '').slice(0, 500);
            responseTask = task;
            commitMsg = `Task note update: ${task.prospect_name || task.prospect_id}`;
            break;
        }

        default:
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ success: false, error: `Unknown action: ${action}. Valid: create, complete, reopen, reschedule, save_chuck_output, update_note` })
            };
    }

    content.last_modified = new Date().toISOString();
    await commitFileToGitHub(token, content, sha, commitMsg);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            rep,
            task: responseTask,
            last_modified: content.last_modified
        })
    };
}


// ============================================================
// DELETE — Remove a task or clear all for a rep
// ============================================================

async function handleDelete(token, headers, rep, taskId) {
    const { content, sha } = await fetchFileFromGitHub(token);

    if (!content.tasks?.[rep] || content.tasks[rep].length === 0) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, message: 'No tasks to delete', removed: 0 })
        };
    }

    const before = content.tasks[rep].length;
    let removed = 0;
    let msg = '';

    if (taskId) {
        content.tasks[rep] = content.tasks[rep].filter(t => t.id !== taskId);
        removed = before - content.tasks[rep].length;
        msg = `Task delete: ${taskId} (${removed} removed)`;
    } else {
        removed = before;
        content.tasks[rep] = [];
        msg = `Task clear: all tasks for ${rep} (${removed} removed)`;
    }

    content.last_modified = new Date().toISOString();
    await commitFileToGitHub(token, content, sha, msg);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            rep,
            removed,
            message: taskId ? 'Task deleted' : 'All tasks cleared',
            last_modified: content.last_modified
        })
    };
}


// ============================================================
// Validation helpers
// ============================================================

function validateCreatePayload(body) {
    if (!body.prospect_id) return 'Missing prospect_id';
    if (!body.prospect_type) return 'Missing prospect_type';
    if (!VALID_PROSPECT_TYPES.includes(body.prospect_type)) {
        return `Invalid prospect_type. Valid: ${VALID_PROSPECT_TYPES.join(', ')}`;
    }
    if (!body.due_date) return 'Missing due_date (YYYY-MM-DD)';
    if (!isValidDateStr(body.due_date)) {
        return 'due_date must be valid YYYY-MM-DD format';
    }
    if (body.source && !VALID_SOURCES.includes(body.source)) {
        return `Invalid source. Valid: ${VALID_SOURCES.join(', ')}`;
    }
    return null;
}

function isValidDateStr(s) {
    if (typeof s !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime());
}

function todayDateStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}


// ============================================================
// GitHub API Helpers (same pattern as cs-routes.mjs)
// ============================================================

async function fetchFileFromGitHub(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'PIE-Tasks'
        }
    });

    if (response.status === 404) {
        return {
            content: {
                tasks: {},
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
            'User-Agent': 'PIE-Tasks',
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
