// TEMPORARY — delete after initial account setup
// Uses GoTrue Admin API to confirm user + set password directly
import crypto from 'crypto';
import { handleCors, corsHeaders } from './cors.mjs';
// import { validateApiKey } from './auth.mjs'; // disabled for setup

function makeAdminJWT() {
  const secret = process.env.GOTRUE_JWT_SECRET;
  if (!secret) throw new Error('GOTRUE_JWT_SECRET not available');
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'admin',
    role: 'service_role',
    iss: 'netlify',
    exp: Math.floor(Date.now()/1000) + 300
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + sig;
}

export async function handler(event) {
  const corsCheck = handleCors(event);
  if (corsCheck) return corsCheck;
  // Auth check disabled for initial setup — DELETE THIS FUNCTION after use
  const _cors = corsHeaders((event.headers || {}).origin || '');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: _cors, body: 'Method not allowed' };
  }

  try {
    const { email, password, role } = JSON.parse(event.body || '{}');
    if (!email || !password) {
      return { statusCode: 400, headers: _cors, body: JSON.stringify({ error: 'email and password required' }) };
    }

    const adminJWT = makeAdminJWT();
    const gotrueBase = process.env.IDENTITY_URL || 'https://informativ-sales-api.netlify.app/.netlify/identity';
    const adminHeaders = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + adminJWT,
    };

    // Step 1: List users to find this email
    const listResp = await fetch(gotrueBase + '/admin/users?per_page=100', { headers: adminHeaders });
    if (!listResp.ok) {
      const txt = await listResp.text();
      return { statusCode: 500, headers: _cors, body: JSON.stringify({ error: 'Admin API failed', status: listResp.status, detail: txt }) };
    }
    const data = await listResp.json();
    const users = data.users || data;
    const user = users.find(u => u.email === email);

    let userId;
    if (user) {
      userId = user.id;
      // Step 2a: Update existing user — confirm + set password + set role
      const updateBody = { 
        password: password,
        confirm: true,
        app_metadata: { roles: role ? [role] : ['admin'] }
      };
      const updateResp = await fetch(gotrueBase + '/admin/users/' + userId, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(updateBody),
      });
      const updateData = await updateResp.json();
      if (!updateResp.ok) {
        return { statusCode: 500, headers: _cors, body: JSON.stringify({ error: 'Update failed', detail: updateData }) };
      }
      return {
        statusCode: 200,
        headers: _cors,
        body: JSON.stringify({ 
          success: true, 
          action: 'updated',
          email: email,
          id: userId,
          confirmed: true,
          role: role || 'admin',
          message: 'User confirmed, password set, role assigned. You can now sign in.'
        }),
      };
    } else {
      // Step 2b: Create new user with password
      const createResp = await fetch(gotrueBase + '/admin/users', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          email: email,
          password: password,
          confirm: true,
          app_metadata: { roles: role ? [role] : ['admin'] },
        }),
      });
      const createData = await createResp.json();
      if (!createResp.ok) {
        return { statusCode: 500, headers: _cors, body: JSON.stringify({ error: 'Create failed', detail: createData }) };
      }
      return {
        statusCode: 200,
        headers: _cors,
        body: JSON.stringify({
          success: true,
          action: 'created',
          email: email,
          id: createData.id,
          confirmed: true,
          role: role || 'admin',
          message: 'User created with password and role. You can now sign in.'
        }),
      };
    }
  } catch (e) {
    return { statusCode: 500, headers: _cors, body: JSON.stringify({ error: e.message, stack: e.stack }) };
  }
}
