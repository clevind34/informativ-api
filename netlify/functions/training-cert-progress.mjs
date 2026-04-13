/**
 * Certification Quiz Progress — Server-Side Persistence
 *
 * Stores per-rep module-level quiz results so progress syncs across devices.
 * GET  ?rep=Name         → returns { results: { programId: { moduleNum: { score, passed, ... } } } }
 * POST { repName, results } → saves full certModuleResults object for the rep
 *
 * Persistence: cert-progress.json in clevind34/informativ-api repo (data/ directory)
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'informativ-api';
const FILE_PATH = 'data/cert-progress.json';
const BRANCH = 'main';

async function _handler(event) {
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');
    const headers = { 'Content-Type': 'application/json', ..._cors };

    const githubToken = process.env.GITHUB_TOKEN;

    // GET — return progress for a specific rep
    if (event.httpMethod === 'GET') {
        const rep = (event.queryStringParameters || {}).rep;
        if (!rep) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'rep query parameter required' }) };
        }

        if (!githubToken) {
            return { statusCode: 200, headers, body: JSON.stringify({ results: {}, stored: 'none' }) };
        }

        try {
            const fileData = await fetchFile(githubToken);
            const allProgress = fileData.content;
            const repResults = allProgress[rep] || {};
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ results: repResults, stored: 'github' })
            };
        } catch (e) {
            // File may not exist yet
            if (e.message.includes('404')) {
                return { statusCode: 200, headers, body: JSON.stringify({ results: {}, stored: 'none' }) };
            }
            return { statusCode: 200, headers, body: JSON.stringify({ results: {}, error: e.message }) };
        }
    }

    // POST — save progress for a rep
    if (event.httpMethod === 'POST') {
        let body;
        try {
            body = JSON.parse(event.body);
        } catch (e) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
        }

        const { repName, results } = body;
        if (!repName || !results) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'repName and results required' }) };
        }

        if (!githubToken) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, stored: 'client-only' })
            };
        }

        try {
            // Fetch existing file (or create new)
            let allProgress = {};
            let currentSha = null;
            try {
                const fileData = await fetchFile(githubToken);
                allProgress = fileData.content;
                currentSha = fileData.sha;
            } catch (e) {
                if (!e.message.includes('404')) throw e;
                // File doesn't exist yet — will create
            }

            // Merge: server-side wins for conflicts, but keep best scores
            const existing = allProgress[repName] || {};
            for (const [progId, modules] of Object.entries(results)) {
                if (!existing[progId]) existing[progId] = {};
                for (const [modNum, result] of Object.entries(modules)) {
                    const prev = existing[progId][modNum];
                    // Keep the better score (higher score wins)
                    if (!prev || result.score > prev.score) {
                        existing[progId][modNum] = result;
                    }
                }
            }
            allProgress[repName] = existing;

            // Commit
            await commitFile(githubToken, allProgress, currentSha, repName);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    stored: 'github',
                    repName,
                    programs: Object.keys(existing).length
                })
            };
        } catch (e) {
            console.error('Cert progress save error:', e);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, stored: 'client-only', error: e.message })
            };
        }
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
}

async function fetchFile(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Cert-Progress'
        }
    });
    if (!response.ok) {
        throw new Error(`GitHub ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const contentStr = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content: JSON.parse(contentStr), sha: data.sha };
}

async function commitFile(token, content, currentSha, repName) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const contentStr = JSON.stringify(content, null, 2);
    const contentBase64 = Buffer.from(contentStr).toString('base64');

    const body = {
        message: `Cert progress sync: ${repName}`,
        content: contentBase64,
        branch: BRANCH
    };
    if (currentSha) body.sha = currentSha;

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Cert-Progress',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(`GitHub commit failed: ${response.status} — ${err.message || response.statusText}`);
    }
    return await response.json();
}

export async function handler(event) {
    const response = await _handler(event);
    logRequest(event, response);
    return response;
}
