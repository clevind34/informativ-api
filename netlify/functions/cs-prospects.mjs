/**
 * PIE Custom Prospects & Group Associations — Netlify Serverless Function
 *
 * GitHub-persisted custom prospects (rep-created stores) and group associations.
 * Supports: adding new stores, associating stores with groups, adding contacts to existing stores,
 * and assigning contact roles (Decision Maker — Store/Group, Referrer, Contact).
 *
 * Flow:
 * 1. GET — Returns all custom prospects, group associations, additional contacts, contact roles
 * 2. POST ?action=add_store — Creates a new prospect store
 * 3. POST ?action=set_group — Associates an existing prospect/account with a group
 * 4. POST ?action=add_contact — Adds a new contact to an existing store (optional role field)
 * 5. POST ?action=set_contact_role — Sets the role of any contact (primary or additional)
 *
 * Contact roles (v1, single DM flag per record):
 *   - "contact" (default) — generic contact, no special status
 *   - "dm_store" — Decision Maker for this store/dealership only
 *   - "dm_group" — Decision Maker for the dealer group (cross-rooftop authority)
 *   - "referrer" — original contact who referred us to the actual DM, kept for credit/audit
 *
 * Pipeline row display logic (handled in frontend, not backend):
 *   When a contact has role dm_store or dm_group, the prospect/cross-sell row in the Pipeline tab
 *   displays THAT contact's name/title/phone instead of the original primary contact. Original
 *   stays visible in the detail panel with the Referrer (or other) badge.
 *
 * Data structure:
 * {
 *   prospects: { [prospect_id]: { ...store fields } },
 *   group_associations: { [record_id]: { group, set_by, set_at } },
 *   additional_contacts: { [record_id]: [ { contact_name, title, email, phone, role, added_by, added_at } ] },
 *   contact_roles: { [record_id]: { primary: "<role>", "0": "<role>", "1": "<role>", ... } },
 *   schema_version: "1.1",
 *   last_modified: ISO timestamp
 * }
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { safeError } from './safe-error.mjs';

const GITHUB_OWNER = 'clevind34';
const GITHUB_REPO = 'informativ-api';
const FILE_PATH = 'pie-custom-prospects.json';
const BRANCH = 'main';

const VALID_ROLES = ['contact', 'dm_store', 'dm_group', 'referrer'];

function _validateRole(role) {
    if (role === undefined || role === null || role === '') return 'contact';
    if (VALID_ROLES.indexOf(role) === -1) return null;
    return role;
}

async function _handler(event) {
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');
    const rlCheck = checkRateLimit(event, _cors);
    if (rlCheck) return rlCheck;

    const headers = { 'Content-Type': 'application/json', ..._cors };

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'No GitHub token', prospects: {}, group_associations: {}, additional_contacts: {}, contact_roles: {} }) };
    }

    try {
        if (event.httpMethod === 'GET') {
            return await handleGet(token, headers);
        } else if (event.httpMethod === 'POST') {
            const action = (event.queryStringParameters || {}).action || '';
            if (action === 'add_store') return await handleAddStore(event, token, headers);
            if (action === 'set_group') return await handleSetGroup(event, token, headers);
            if (action === 'add_contact') return await handleAddContact(event, token, headers);
            if (action === 'set_contact_role') return await handleSetContactRole(event, token, headers);
            return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Missing or invalid action query param. Use: add_store, set_group, add_contact, set_contact_role' }) };
        }
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    } catch (err) {
        console.error('cs-prospects error:', err);
        return safeError(200, 'Prospect operation failed', err, _cors);
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
            contact_roles: content.contact_roles || {},
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
        pipeline: body.pipeline || 'net_new',
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

    const { record_id, added_by } = body;
    if (!record_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'record_id is required' }) };
    }

    const role = _validateRole(body.role);
    if (role === null) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: `Invalid role. Use one of: ${VALID_ROLES.join(', ')}` }) };
    }

    const { content, sha } = await fetchFile(token);
    if (!content.additional_contacts) content.additional_contacts = {};
    if (!content.additional_contacts[record_id]) content.additional_contacts[record_id] = [];
    if (!content.contact_roles) content.contact_roles = {};
    if (!content.contact_roles[record_id]) content.contact_roles[record_id] = {};

    const contact = {
        contact_name: body.contact_name || '',
        title: body.title || '',
        email: body.email || '',
        phone: body.phone || '',
        role: role,
        added_by: added_by || 'unknown',
        added_at: new Date().toISOString()
    };
    content.additional_contacts[record_id].push(contact);

    // Mirror the role into contact_roles map (keyed by array index)
    const newIdx = content.additional_contacts[record_id].length - 1;
    content.contact_roles[record_id][String(newIdx)] = role;

    content.last_modified = new Date().toISOString();

    await commitFile(token, content, sha, `Add contact (${role}) to ${record_id.substring(0, 12)}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, record_id, contact, contact_index: newIdx }) };
}

// POST ?action=set_contact_role — Set the role of any contact (primary or additional)
async function handleSetContactRole(event, token, headers) {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid JSON' }) }; }

    const { record_id, contact_key, set_by } = body;
    if (!record_id || contact_key === undefined || contact_key === null) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'record_id and contact_key are required. contact_key = "primary" or array index of additional contact (string).' }) };
    }

    const role = _validateRole(body.role);
    if (role === null) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: `Invalid role. Use one of: ${VALID_ROLES.join(', ')}` }) };
    }

    const { content, sha } = await fetchFile(token);
    if (!content.contact_roles) content.contact_roles = {};
    if (!content.contact_roles[record_id]) content.contact_roles[record_id] = {};

    // Validate contact_key — "primary" or numeric string within additional_contacts range
    const key = String(contact_key);
    if (key !== 'primary') {
        const idx = parseInt(key, 10);
        if (isNaN(idx) || idx < 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'contact_key must be "primary" or a non-negative integer string' }) };
        }
        const additional = (content.additional_contacts || {})[record_id] || [];
        if (idx >= additional.length) {
            return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: `contact_key index ${idx} out of range (additional_contacts has ${additional.length} entries)` }) };
        }
        // Mirror role onto the contact object itself for consistency on future GET reads
        if (additional[idx]) additional[idx].role = role;
    }

    content.contact_roles[record_id][key] = role;
    content.last_modified = new Date().toISOString();

    // Audit metadata (lightweight)
    if (!content.contact_role_history) content.contact_role_history = [];
    content.contact_role_history.push({
        record_id,
        contact_key: key,
        role,
        set_by: set_by || 'unknown',
        set_at: new Date().toISOString()
    });
    // Cap history at last 500 entries to keep file lean
    if (content.contact_role_history.length > 500) {
        content.contact_role_history = content.contact_role_history.slice(-500);
    }

    await commitFile(token, content, sha, `Set role: ${record_id.substring(0, 12)} ${key} → ${role}`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, record_id, contact_key: key, role }) };
}

// GitHub helpers
async function fetchFile(token) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${BRANCH}`;
    const resp = await fetch(url, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' } });

    if (resp.status === 404) {
        return { content: { prospects: {}, group_associations: {}, additional_contacts: {}, contact_roles: {}, schema_version: '1.1', last_modified: new Date().toISOString() }, sha: null };
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

// Phase 2B-3: Audit log wrapper
export async function handler(event) {
  const response = await _handler(event);
  logRequest(event, response);
  return response;
}
