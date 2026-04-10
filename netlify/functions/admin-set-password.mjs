// Admin function to set Netlify Identity user password
// Creates or updates a user in the Identity system
// Requires: ADMIN_PASSWORD_SECRET env var (shared secret)

import crypto from 'crypto';

const IDENTITY_URL = process.env.IDENTITY_URL || 'https://informativ-sales-api.netlify.app/.identity';

export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Secret',
      },
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { email, password, role } = body;

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'email and password required' }),
      };
    }

    // Verify secret header (temporary protection until Identity is fully set up)
    const adminSecret = process.env.ADMIN_PASSWORD_SECRET;
    const headerSecret = (event.headers || {})['x-secret'];
    
    if (adminSecret && headerSecret !== adminSecret) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized — invalid or missing X-Secret header' }),
      };
    }

    // Create a Netlify Identity JWT (service role token)
    const jwt = makeAdminJWT();

    // Call Netlify Identity API to upsert the user
    const resp = await fetch(IDENTITY_URL + '/admin/users', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + jwt,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: {},
        app_metadata: {
          roles: role ? [role] : [],
        },
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('[admin-set-password] GoTrue API error:', resp.status, errBody);
      
      // If 422 Unprocessable Entity, likely user already exists
      if (resp.status === 422) {
        // Try updating existing user instead
        const userResp = await fetch(IDENTITY_URL + '/admin/users', {
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + jwt },
        });

        if (userResp.ok) {
          const users = await userResp.json();
          const existing = users.find(u => u.email === email);
          
          if (existing) {
            const updateResp = await fetch(IDENTITY_URL + '/admin/users/' + existing.id, {
              method: 'PUT',
              headers: {
                'Authorization': 'Bearer ' + jwt,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                password,
                app_metadata: {
                  roles: role ? [role] : [],
                },
              }),
            });

            if (!updateResp.ok) {
              throw new Error('Failed to update user: ' + (await updateResp.text()));
            }

            return {
              statusCode: 200,
              body: JSON.stringify({ message: 'User updated', email, role }),
            };
          }
        }
      }

      throw new Error('GoTrue API error ' + resp.status + ': ' + errBody);
    }

    const user = await resp.json();
    return {
      statusCode: 201,
      body: JSON.stringify({ message: 'User created', email: user.email, id: user.id, role }),
    };
  } catch (err) {
    console.error('[admin-set-password] Error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}

/**
 * Generate a Netlify Identity service role JWT
 * Tries multiple env var names for the GoTrue JWT secret since exact naming is unclear
 */
function makeAdminJWT() {
  // Netlify may use different env var names for the Identity JWT secret
  const secret = process.env.GOTRUE_JWT_SECRET 
    || process.env.JWT_SECRET 
    || process.env.IDENTITY_JWT_SECRET
    || process.env.NETLIFY_IDENTITY_JWT_SECRET;
  
  if (!secret) {
    // Dump relevant env var names for debugging
    const relevant = Object.keys(process.env).filter(k => 
      /jwt|gotrue|identity|secret|token/i.test(k)
    );
    throw new Error('No JWT secret found. Available relevant env vars: ' + JSON.stringify(relevant) + '. All env prefixes: ' + [...new Set(Object.keys(process.env).map(k => k.split('_')[0]))].join(','));
  }

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
