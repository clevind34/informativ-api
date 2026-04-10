/**
 * Certification Completion Tracker — Netlify Serverless Function
 *
 * When a rep completes all modules of a certification program:
 * 1. Fetches the current product-certifications.json from GitHub
 * 2. Adds the product to the rep's certified_products list
 * 3. Removes it from uncertified_products
 * 4. Commits the updated file back to GitHub
 * 5. Netlify auto-redeploys so dashboards + coaching data update
 *
 * Follows the same pattern as training-complete.mjs.
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'chuck-sales-assistant';
const FILE_PATH = 'product-certifications.json';
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

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { repName, programId, product, timestamp } = body;

    if (!repName || !programId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'repName and programId required' }) };
    }

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'client-only',
                note: 'GITHUB_TOKEN not configured — certification saved locally only.'
            })
        };
    }

    try {
        // 1. Fetch current product-certifications.json from GitHub
        const fileData = await fetchFileFromGitHub(githubToken);
        const certData = fileData.content;
        const currentSha = fileData.sha;

        // 2. Update the rep's certification status
        if (certData.certifications && certData.certifications[repName]) {
            const repCerts = certData.certifications[repName];

            // Check if already certified on this product
            const alreadyCertified = (repCerts.certified_products || []).some(
                c => (typeof c === 'string' ? c : c.product) === product
            );

            if (!alreadyCertified && product) {
                // Add to certified_products
                if (!repCerts.certified_products) repCerts.certified_products = [];
                repCerts.certified_products.push({
                    product: product,
                    certified_date: timestamp ? timestamp.split('T')[0] : new Date().toISOString().split('T')[0],
                    certification_type: 'quiz_completion',
                    program_id: programId
                });

                // Remove from uncertified_products
                if (repCerts.uncertified_products) {
                    repCerts.uncertified_products = repCerts.uncertified_products.filter(p => p !== product);
                }
            }
        }

        // Update last_updated
        certData.last_updated = new Date().toISOString().split('T')[0];

        // 3. Commit updated file back to GitHub
        await commitFileToGitHub(githubToken, certData, currentSha, repName, programId, product);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                stored: 'github',
                repName,
                programId,
                product,
                note: 'Certification saved to GitHub. Dashboards will update on next deploy (~60s).'
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
                note: 'GitHub sync failed — certification saved locally.'
            })
        };
    }
}

async function fetchFileFromGitHub(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Certification-Tracker'
        }
    });

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const contentStr = Buffer.from(data.content, 'base64').toString('utf-8');
    const content = JSON.parse(contentStr);

    return { content, sha: data.sha };
}

async function commitFileToGitHub(token, updatedContent, currentSha, repName, programId, product) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;

    const contentStr = JSON.stringify(updatedContent, null, 2);
    const contentBase64 = Buffer.from(contentStr).toString('base64');

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Chuck-Certification-Tracker',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: `Certification complete: ${repName} certified on ${product || programId}`,
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
