/**
 * Training Completion Tracker — Netlify Serverless Function
 *
 * When a rep/manager completes a training week, this function:
 * 1. Fetches the current training-progress.json from GitHub
 * 2. Updates the rep's progress (marks week complete, increments counter)
 * 3. Commits the updated file back to GitHub
 * 4. This triggers a Netlify redeploy, so dashboards update automatically
 *
 * The GitHub token is stored as a Netlify environment variable (GITHUB_TOKEN).
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { validateApiKey } from './auth.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'chuck-sales-assistant';
const FILE_PATH = 'training-progress.json';
const BRANCH = 'main';

export async function handler(event) {
    // --- Unified API Gateway middleware ---
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = validateApiKey(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');


    const headers = {
        'Content-Type': 'application/json',
        ..._cors
    };

    // GET — retrieve current training progress + diagnostics
    if (event.httpMethod === 'GET') {
        const token = process.env.GITHUB_TOKEN;
        const diagnostics = {
            github_token_configured: !!token,
            github_token_length: token ? token.length : 0,
            github_token_prefix: token ? token.substring(0, 4) + '...' : 'NOT SET',
            node_version: process.version,
            timestamp: new Date().toISOString()
        };
        try {
            if (!token) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ completions: {}, diagnostics, warning: 'GITHUB_TOKEN not configured' })
                };
            }
            const data = await fetchFileFromGitHub(token);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ completions: data.content, diagnostics })
            };
        } catch (e) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ completions: {}, diagnostics, error: e.message })
            };
        }
    }

    // POST — record a completion event
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { repName, week, stepsCompleted, weeksCompleted, timestamp } = body;

    if (!repName || !week) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'repName and week required' }) };
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
        // No GitHub token configured — fall back to client-only tracking
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'client-only',
                note: 'GITHUB_TOKEN not configured — progress saved locally only. Set GITHUB_TOKEN in Netlify env vars to enable dashboard sync.'
            })
        };
    }

    try {
        // 1. Fetch current training-progress.json from GitHub
        const fileData = await fetchFileFromGitHub(githubToken);
        const trainingProgress = fileData.content;
        const currentSha = fileData.sha;

        // 2. Update the rep's progress
        if (trainingProgress.reps && trainingProgress.reps[repName]) {
            const rep = trainingProgress.reps[repName];
            const weekKey = `week_${week}`;

            // Mark week as complete
            if (rep.progress_by_week && rep.progress_by_week[weekKey]) {
                rep.progress_by_week[weekKey].module_viewed = true;
                rep.progress_by_week[weekKey].module_viewed_at = timestamp;
                rep.progress_by_week[weekKey].exercise_completed = true;
                rep.progress_by_week[weekKey].exercise_submitted_at = timestamp;
                rep.progress_by_week[weekKey].status = 'complete';
            }

            // Update summary fields
            rep.weeks_completed = weeksCompleted;
            rep.current_week = Math.min(week + 1, 12);
            rep.overall_progress_pct = Math.round((weeksCompleted / 12) * 100);

            // Update completion status
            if (weeksCompleted >= 12) {
                rep.completion_status = 'completed';
            } else if (weeksCompleted > 0) {
                rep.completion_status = 'in_progress';
            }
        }

        // 3. Commit updated file back to GitHub
        await commitFileToGitHub(githubToken, trainingProgress, currentSha, repName, week);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'github',
                repName,
                week,
                weeksCompleted,
                note: 'Progress saved to GitHub. Dashboards will update on next deploy (~60s).'
            })
        };

    } catch (e) {
        console.error('GitHub sync error:', e);

        // If GitHub sync fails, still return success for client-side tracking
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'client-only',
                error: e.message,
                note: 'GitHub sync failed — progress saved locally. Will retry on next completion.'
            })
        };
    }
}

/**
 * Fetch training-progress.json from GitHub via API
 */
async function fetchFileFromGitHub(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Training-Tracker'
        }
    });

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Decode base64 content
    const contentStr = Buffer.from(data.content, 'base64').toString('utf-8');
    const content = JSON.parse(contentStr);

    return {
        content,
        sha: data.sha
    };
}

/**
 * Commit updated training-progress.json back to GitHub
 */
async function commitFileToGitHub(token, updatedContent, currentSha, repName, week) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;

    // Encode content as base64
    const contentStr = JSON.stringify(updatedContent, null, 2);
    const contentBase64 = Buffer.from(contentStr).toString('base64');

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Training-Tracker',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: `Training complete: ${repName} finished Week ${week}`,
            content: contentBase64,
            sha: currentSha,
            branch: BRANCH
        })
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`GitHub commit failed: ${response.status} — ${errorData.message || response.statusText}`);
    }

    return await response.json();
}
