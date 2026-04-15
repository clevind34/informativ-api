// GET /api/auth/me — Returns authenticated user's identity, role, and team
// Replaces client-side hardcoded email-to-role mappings (security fix)
// Requires valid JWT in Authorization: Bearer header

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest, getUser, sessionHeaders } from './auth.mjs';
import { getDataScope } from './roles.mjs';

// Email → display name (server-side only — never exposed as a full list)
const EMAIL_TO_NAME = {
  'mbyrd@informativ.com': 'Michael Byrd',
  'cbyrd@informativ.com': 'Carson Byrd',
  'dcarner@informativ.com': 'David Carner',
  'klang@informativ.com': 'Kimberly Lang',
  'nbrignola@informativ.com': 'Nick Brignola',
  'tbordenet@informativ.com': 'Teresa Bordenet',
  'jcarlucci@informativ.com': 'Joel Carlucci',
  'cknievel@informativ.com': 'Curtis Knievel',
  'ksandoval@informativ.com': 'Kiristen Sandoval',
  'csanford@informativ.com': 'Carol Sanford',
  'mhanaman@informativ.com': 'Matt Hanaman',
  'trichter@informativ.com': 'Tami Richter',
  'tsmith@informativ.com': 'Trish Smith',
  'cromero@informativ.com': 'Clarence Romero',
  'agough@informativ.com': 'Ashton Gough',
  'wcarroll@informativ.com': 'Ward Carroll',
  'wfowler@informativ.com': 'William Fowler',
  'bhutchinson@informativ.com': 'Brock Hutchinson',
  'calvarado@informativ.com': 'Crly Alvarado',
  'tcanley@informativ.com': 'Tim Canley',
  'asweet@informativ.com': 'Andrea Sweet',
  'cmanz@informativ.com': 'Chad Manz',
  'cbouvier@informativ.com': 'Chaquowa Bouvier',
  'ischweitzer@informativ.com': 'Irma Schweitzer',
  'jcraddock@informativ.com': 'Jennifer Craddock',
  'kbutler@informativ.com': 'Kedrick Butler',
  'kfelder@informativ.com': 'Kelly Felder',
  'mmiller@informativ.com': 'Melissa Miller',
  'eaikey@informativ.com': 'Esther Aikey',
  'rgomez@informativ.com': 'Ruby Gomez',
  'rrorick@informativ.com': 'Robert Rorick',
  'cwofford@informativ.com': 'Christina Wofford',
  'sharnekar@informativ.com': 'Santosh Harnekar',
  'dlarsen@informativ.com': 'Darin Larsen',
  'ddomm@informativ.com': 'Dave Domm',
  'hbestul@informativ.com': 'Heather Bestul',
  'rtruitt@informativ.com': 'Rebecca Truitt',
};

export async function handler(event) {
  const corsCheck = handleCors(event);
  if (corsCheck) return corsCheck;

  const _cors = corsHeaders((event.headers || {}).origin || '');

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { ..._cors }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Authenticate — requires valid JWT (not just API key)
  const authCheck = await authenticateRequest(event);
  if (authCheck) return authCheck;

  const user = getUser(event);
  if (!user) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json', ..._cors },
      body: JSON.stringify({ error: 'Authentication required. Please log in.' }),
    };
  }

  const email = (user.email || '').toLowerCase();
  const scope = getDataScope(event);
  const displayName = EMAIL_TO_NAME[email] || null;

  // Determine primary role (highest privilege)
  const roles = user.roles || [];
  let primaryRole = 'unknown';
  if (roles.includes('admin')) primaryRole = 'admin';
  else if (roles.includes('elt')) primaryRole = 'elt';
  else if (roles.includes('manager')) primaryRole = 'manager';
  else if (roles.includes('cs') || roles.includes('csm') || roles.includes('csa')) primaryRole = 'cs';
  else if (roles.includes('rep')) primaryRole = 'rep';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      ..._cors,
      ...sessionHeaders(event),
    },
    body: JSON.stringify({
      email,
      name: displayName,
      role: primaryRole,
      roles,
      team: scope.team,
      rep_name: scope.rep_name,
      scope: scope.scope,
    }),
  };
}
