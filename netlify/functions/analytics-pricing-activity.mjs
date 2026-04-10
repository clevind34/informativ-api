/**
 * Pricing Activity Tracker — Netlify Serverless Function
 *
 * When a rep uses the Pricing Tab, this function:
 * 1. Fetches the current pricing-activity.json from GitHub
 * 2. Appends the pricing event and updates the rep summary
 * 3. Commits the updated file back to GitHub
 * 4. This triggers a Netlify redeploy, so data stays in sync
 *
 * The GitHub token is stored as a Netlify environment variable (GITHUB_TOKEN).
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'chuck-sales-assistant';
const FILE_PATH = 'pricing-activity.json';
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

    // GET — retrieve current pricing activity data
    if (event.httpMethod === 'GET') {
        const token = process.env.GITHUB_TOKEN;
        try {
            if (!token) {
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ events: [], rep_summary: {}, warning: 'GITHUB_TOKEN not configured' })
                };
            }
            const data = await fetchFileFromGitHub(token);
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify(data.content)
            };
        } catch (e) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ events: [], rep_summary: {}, error: e.message })
            };
        }
    }

    // POST — record a pricing event
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { rep, action } = body;

    if (!rep || !action) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'rep and action are required' }) };
    }

    const validActions = ['intake_uploaded', 'internal_generated', 'package_selected', 'external_generated'];
    if (!validActions.includes(action)) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` })
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
        // 1. Fetch current pricing-activity.json from GitHub
        const fileData = await fetchFileFromGitHub(githubToken);
        const pricingActivity = fileData.content;
        const currentSha = fileData.sha;

        // 2. Build the event object
        const pricingEvent = {
            rep: body.rep,
            timestamp: body.timestamp || new Date().toISOString(),
            action: body.action
        };

        if (body.dealership_group) pricingEvent.dealership_group = body.dealership_group;
        if (body.stores_count) pricingEvent.stores_count = body.stores_count;
        if (body.packages_priced) pricingEvent.packages_priced = body.packages_priced;
        if (body.selected_packages) pricingEvent.selected_packages = body.selected_packages;
        if (body.total_monthly_value) pricingEvent.total_monthly_value = body.total_monthly_value;

        // 3. Append event
        pricingActivity.events.push(pricingEvent);

        // 4. Update rep summary
        if (!pricingActivity.rep_summary) {
            pricingActivity.rep_summary = {};
        }
        if (!pricingActivity.rep_summary[rep]) {
            pricingActivity.rep_summary[rep] = {
                sessions_this_month: 0,
                last_pricing_date: null,
                avg_deal_value_quoted: 0,
                package_mix: {}
            };
        }

        const summary = pricingActivity.rep_summary[rep];

        // Increment session count on internal_generated (that's when a pricing session starts)
        if (action === 'internal_generated') {
            summary.sessions_this_month = (summary.sessions_this_month || 0) + 1;
        }

        // Update last pricing date
        summary.last_pricing_date = pricingEvent.timestamp.split('T')[0];

        // Update avg deal value from internal_generated events
        if (body.total_monthly_value && action === 'internal_generated') {
            const repInternalEvents = pricingActivity.events.filter(
                e => e.rep === rep && e.action === 'internal_generated' && e.total_monthly_value
            );
            const totalValue = repInternalEvents.reduce((s, e) => s + e.total_monthly_value, 0);
            summary.avg_deal_value_quoted = Math.round(totalValue / repInternalEvents.length);
        }

        // Update package mix from package_selected events
        if (action === 'package_selected' && body.selected_packages) {
            // Recalculate package mix from all package_selected events for this rep
            const allSelections = pricingActivity.events.filter(
                e => e.rep === rep && e.action === 'package_selected' && e.selected_packages
            );
            const packageCounts = {};
            let totalSelections = 0;
            for (const evt of allSelections) {
                for (const pkg of Object.values(evt.selected_packages)) {
                    packageCounts[pkg] = (packageCounts[pkg] || 0) + 1;
                    totalSelections++;
                }
            }
            // Convert to percentages
            summary.package_mix = {};
            for (const [pkg, count] of Object.entries(packageCounts)) {
                summary.package_mix[pkg] = Math.round(count / totalSelections * 100) / 100;
            }
        }

        // 5. Commit back to GitHub
        await commitFileToGitHub(githubToken, pricingActivity, currentSha, rep, action);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'github',
                event: pricingEvent,
                note: 'Pricing event saved to GitHub.'
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
                note: 'GitHub sync failed — event saved locally only.'
            })
        };
    }
}

/**
 * Fetch pricing-activity.json from GitHub via API
 */
async function fetchFileFromGitHub(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Pricing-Tracker'
        }
    });

    // File doesn't exist yet — return empty structure
    if (response.status === 404) {
        return {
            content: { events: [], rep_summary: {} },
            sha: null
        };
    }

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const contentStr = Buffer.from(data.content, 'base64').toString('utf-8');
    const content = JSON.parse(contentStr);

    return {
        content,
        sha: data.sha
    };
}

/**
 * Commit updated pricing-activity.json back to GitHub
 */
async function commitFileToGitHub(token, updatedContent, currentSha, repName, action) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;

    const contentStr = JSON.stringify(updatedContent, null, 2);
    const contentBase64 = Buffer.from(contentStr).toString('base64');

    const payload = {
        message: `Pricing event: ${repName} — ${action}`,
        content: contentBase64,
        branch: BRANCH
    };

    // Include sha if updating existing file (not creating new)
    if (currentSha) {
        payload.sha = currentSha;
    }

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Pricing-Tracker',
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
