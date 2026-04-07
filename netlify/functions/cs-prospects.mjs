/**
 * PIE Custom Prospects & Group Associations — Netlify Serverless Function
 *
 * GitHub-persisted custom prospects (rep-created stores) and group associations.
 * Supports: adding new stores, associating stores with groups, adding contacts to existing stores.
 *
 * Flow:
 * 1. GET — Returns all custom prospects and group associations
 * 2. POST ?action=add_store — Creates a new prospect store
 * 3. POST ?action=set_group — Associates an existing prospect/account with a group
 * 4. POST ?action=add_contact — Adds a new contact to an existing store
 *
 * Data structure:
 * {
 *   prospects: { [prospect_id]: { company_name, city, state, oem, est_vehicles, contact_name, title, email, phone, group, pipeline, created_by, created_at } },
 *   group_associations: { [record_id]: { group, set_by, set_at } },
 *   additional_contacts: { [record_id]: [ { contact_name, title, email, phone, added_by, added_at } ] },
 *   schema_version: "1.0",
 *   last_modified: ISO timestamp
 * }
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { validateApiKey } from './auth.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'informativ-api';
const FILE_PATH = 'pie-custom-prospects.json';
const BRANCH = 'main';

export async function handler(event) {
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = validateApiKey(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');

    const headers = { 'Content-Type': 'application/json', ..._cors };

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'No GitHub token', prospects: {}, group_associations: {}, additional_contacts: {} }) };
    }

    try {
        if (event.httpMethod === 'GET') {
            return await handleGet(token, headers);
        } else if (event.httpMethod === 'POST') {
            const action = (event.queryStringParameters || {}).action || '';
            if (action === 'add_store') return await handleAddStore(event, token, headers);
            if (action === 'set_group') return await handleSetGroup(event, token, headers);
            if (action === 'add_contact') return await handleAddContact(event, token, headers);
            return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Missing or invalid action query param. Use: add_store, set_group, add_contact' }) };
        }
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    } catch (err) {
        console.error('cs-prospects error:', err);
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message }) };
    }
}

// GET — Return all custom data
async function handleGet(token, headers) {
    const { content } = await fetchFile(token);
    return {
        statusCode: 200, headers,
        body: JSON.stringify({
            success: true,
            prospects: content.prospects || {},
            group_associations: content.group_associations || {},
            additional_contacts: content.additional_contacts || {},
            count: Object.keys(content.prospects || {}).length
        })
    };
}

// POST ?action=add_store — Create a new prospect
async function handleAddStore(event, token, headers) {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid JSON' }) }; }

    const { company_name, city, state } = body;
    if (!company_name || !city || !state) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'company_name, city, and state are required' }) };
    }

    const id = 'custom_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const { content, sha } = await fetchFile(token);
    if (!content.prospects) content.prospects = {};

    content.prospects[id] = {
        company_name: body.company_name,
        city: body.city,
        state: body.state,
        contact_name: body.contact_name || '',
        title: body.title || '',
        email: body.email || '',
        phone: body.phone || '',
        oem: body.oem || '',
        est_vehicles: body.est_vehicles || 0,
        group: body.group || '',
        pipeline: body.pipeline || 'net_new',  // net_new or cross_sell
        assigned_rep: body.assigned_rep || '',
        created_by: body.created_by || 'unknown',
        created_at: new Date().toISOString()
    };
    content.last_modified = new Date().toISOString();

    await commitFile(token, content, sha, `Add store: ${company_name}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, prospect_id: id, prospect: content.prospects[id] }) };
}

// POST ?action=set_group — Associate an existing record with a group
async function handleSetGroup(event, token, headers) {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid JSON' }) }; }

    const { record_id, group, set_by } = body;
    if (!record_id || !group) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'record_id and group are required' }) };
    }

    const { content, sha } = await fetchFile(token);
    if (!content.group_associations) content.group_associations = {};

    content.group_associations[record_id] = {
        group: group,
        set_by: set_by || 'unknown',
        set_at: new Date().toISOString()
    };
    content.last_modified = new Date().toISOString();

    await commitFile(token, content, sha, `Set group: ${record_id.substring(0, 12)} → ${group}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, record_id, group }) };
}

// POST ?action=add_contact — Add a contact to an existing store
async function handleAddContact(event, token, headers) {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid JSON' }) }; }

    const { record_id, contact_name, added_by } = body;
    if (!record_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'record_id is required' }) };
    }

    const { content, sha } = await fetchFile(token);
    if (!content.additional_contacts) content.additional_contacts = {};
    if (!content.additional_contacts[record_id]) content.additional_contacts[record_id] = [];

    const contact = {
        contact_name: body.contact_name || '',
        title: body.title || '',
        email: body.email || '',
        phone: body.phone || '',
        added_by: added_by || 'unknown',
        added_at: new Date().toISOString()
    };
    content.additional_contacts[record_id].push(contact);
    content.last_modified = new Date().toISOString();

    await commitFile(token, content, sha, `Add contact to ${record_id.substring(0, 12)}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, record_id, contact }) };
}

// GitHub helpers
async function fetchFile(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
    const resp = await fetch(url, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' } });

    if (resp.status === 404) {
        return { content: { prospects: {}, group_associations: {}, additional_contacts: {}, schema_version: '1.0', last_modified: new Date().toISOString() }, sha: null };
    }
    if (!resp.ok) throw new Error(`GitHub GET ${resp.status}`);
    const data = await resp.json();
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
    return { content: JSON.parse(decoded), sha: data.sha };
}

async function commitFile(token, content, sha, message) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const body = {
        message,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
        branch: BRANCH
    };
    if (sha) body.sha = sha;
    const resp = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`GitHub commit failed: ${resp.status} — ${err}`);
    }
}
