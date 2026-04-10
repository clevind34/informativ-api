/**
 * Disposition Tracker — Netlify Serverless Function
 *
 * Cross-system sync for Customer Intelligence Dashboard, NMA Dashboard, and Chuck.
 * Logs CS disposition actions (guardrail implementations, reprices, tier changes, etc.)
 * and persists to GitHub for shared visibility across all systems.
 *
 * Flow:
 * 1. Fetches current dispositions.json from GitHub
 * 2. Appends the new disposition with timestamp and unique ID
 * 3. Updates CSM summary
 * 4. Commits back to GitHub
 *
 * The GitHub token is stored as a Netlify environment variable (GITHUB_TOKEN).
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'chuck-sales-assistant';
const FILE_PATH = 'dispositions.json';
const BRANCH = 'main';

export async function handler(event) {
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

    // GET — retrieve current dispositions with optional filtering
    if (event.httpMethod === 'GET') {
        const token = process.env.GITHUB_TOKEN;
        try {
            if (!token) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        dispositions: [],
                        csm_summary: {},
                        warning: 'GITHUB_TOKEN not configured'
                    })
                };
            }
            const data = await fetchFileFromGitHub(token);
            let dispositions = data.content.dispositions || [];

            // Apply filters from query params
            const queryStringParameters = event.queryStringParameters || {};

            if (queryStringParameters.customer_mcid) {
                dispositions = dispositions.filter(d => d.customer_mcid === queryStringParameters.customer_mcid);
            }
            if (queryStringParameters.csm_name) {
                dispositions = dispositions.filter(d => d.csm_name === queryStringParameters.csm_name);
            }
            if (queryStringParameters.source) {
                dispositions = dispositions.filter(d => d.source === queryStringParameters.source);
            }
            if (queryStringParameters.since) {
                const sinceDate = new Date(queryStringParameters.since);
                dispositions = dispositions.filter(d => new Date(d.timestamp) >= sinceDate);
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    dispositions: dispositions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
                    csm_summary: data.content.csm_summary || {},
                    total_count: dispositions.length
                })
            };
        } catch (e) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    dispositions: [],
                    csm_summary: {},
                    error: e.message
                })
            };
        }
    }

    // POST — record a new disposition
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

    const { customer_mcid, customer_name, action_type, csm_name, source } = body;

    if (!customer_mcid || !customer_name || !action_type) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: 'customer_mcid, customer_name, and action_type are required',
                valid_action_types: [
                    'Package Change',
                    'Tier Change',
                    'Reprice',
                    'Guardrail Implementation',
                    'Bureau Optimization',
                    'Other'
                ],
                valid_sources: ['ci_dashboard', 'nma_dashboard', 'chuck']
            })
        };
    }

    // Validate action type
    const validActionTypes = [
        'Package Change',
        'Tier Change',
        'Reprice',
        'Guardrail Implementation',
        'Bureau Optimization',
        'Other'
    ];
    if (!validActionTypes.includes(action_type)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: `Invalid action_type: ${action_type}`,
                valid_action_types: validActionTypes
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
                note: 'GITHUB_TOKEN not configured — disposition saved locally only.'
            })
        };
    }

    try {
        // 1. Fetch current dispositions from GitHub
        const fileData = await fetchFileFromGitHub(githubToken);
        const dispositionLog = fileData.content;
        const currentSha = fileData.sha;

        // 2. Generate unique ID
        const dispositionId = `disp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // 3. Build disposition object
        const disposition = {
            id: dispositionId,
            timestamp: body.timestamp || new Date().toISOString(),
            customer_mcid: body.customer_mcid,
            customer_name: body.customer_name,
            customer_tier: body.customer_tier || null,
            revenue_tier: body.revenue_tier || null,
            action_type: body.action_type,
            guardrails_applied: body.guardrails_applied || [],
            predicted_monthly_savings: body.predicted_monthly_savings || null,
            predicted_annual_savings: body.predicted_annual_savings || null,
            csm_name: body.csm_name || null,
            notes: body.notes || null,
            source: body.source || 'ci_dashboard'
        };

        // 4. Append disposition
        if (!dispositionLog.dispositions) dispositionLog.dispositions = [];
        dispositionLog.dispositions.push(disposition);

        // 5. Update CSM summary
        if (csm_name) {
            if (!dispositionLog.csm_summary) dispositionLog.csm_summary = {};
            if (!dispositionLog.csm_summary[csm_name]) {
                dispositionLog.csm_summary[csm_name] = {
                    total_actions: 0,
                    action_breakdown: {},
                    customers_engaged: [],
                    last_action_date: null,
                    total_savings_annual: 0
                };
            }

            const csmSummary = dispositionLog.csm_summary[csm_name];
            csmSummary.total_actions++;
            csmSummary.action_breakdown[action_type] = (csmSummary.action_breakdown[action_type] || 0) + 1;
            csmSummary.last_action_date = disposition.timestamp.split('T')[0];

            if (!csmSummary.customers_engaged.includes(customer_name)) {
                csmSummary.customers_engaged.push(customer_name);
            }

            if (body.predicted_annual_savings) {
                csmSummary.total_savings_annual += body.predicted_annual_savings;
            }
        }

        // 6. Commit back to GitHub
        const commitMsg = `Disposition: ${customer_name} — ${action_type}`;
        await commitFileToGitHub(githubToken, dispositionLog, currentSha, commitMsg);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'github',
                disposition_id: dispositionId,
                disposition: disposition,
                note: 'Disposition saved to GitHub.'
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
                note: 'GitHub sync failed — disposition saved locally only.'
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
            'User-Agent': 'Chuck-Disposition-Tracker'
        }
    });

    if (response.status === 404) {
        // File doesn't exist yet — return empty structure
        return {
            content: {
                dispositions: [],
                csm_summary: {},
                schema_version: '1.0',
                created_at: new Date().toISOString()
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
            'User-Agent': 'Chuck-Disposition-Tracker',
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
