// Role-based access control middleware for Informativ API Gateway
// Depends on auth.mjs populating event._user via authenticateRequest()
//
// Roles: admin, manager, rep, cs
// Hierarchy: admin > manager > rep/cs (admin inherits all access)

import { getUser } from './auth.mjs';

// Role hierarchy — higher index = more access
const ROLE_LEVEL = { rep: 1, cs: 1, manager: 2, elt: 3, admin: 3 };

// Team membership for data scoping (manager → direct reports)
const TEAM_MAP = {
  'Teresa Bordenet': {
    role: 'manager', team: 'Bordenet',
    reports: ['Trish Smith', 'Matt Hanaman', 'Tami Richter', 'Carol Sanford',
              'Clarence Romero', 'Tom Meredith', 'Loren Rivera'],
  },
  'Joel Carlucci': {
    role: 'manager', team: 'Carlucci',
    reports: ['Ashton Gough', 'David Castone', 'William Fowler', 'Ward Carroll',
              'Brock Hutchinson', 'Great Lakes East (Open)'],
  },
  'Curtis Knievel': {
    role: 'manager', team: 'Knievel',
    reports: ['Crly Alvarado', 'Tim Canley', 'Nick Moyes'],
  },
  'Kiristen Sandoval': {
    role: 'manager', team: 'CS',
    reports: [],
  },
};

// Rep → team lookup (built from TEAM_MAP)
const REP_TEAM = {};
for (const [mgr, info] of Object.entries(TEAM_MAP)) {
  REP_TEAM[mgr] = info.team;
  for (const rep of info.reports) {
    REP_TEAM[rep] = info.team;
  }
}

// Email → rep name mapping (for matching user identity to rep data)
const EMAIL_TO_REP = {
  'mbyrd@informativ.com': 'Michael Byrd',
  'cbyrd@informativ.com': 'Carson Byrd',
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
  // CS team
  'asweet@informativ.com': 'Andrea Sweet',
  'cmanz@informativ.com': 'Chad Manz',
  'cbouvier@informativ.com': 'Chaquowa Bouvier',
  'ischweitzer@informativ.com': 'Irma Schweitzer',
  'jcraddock@informativ.com': 'Jennifer Craddock',
  'kbutler@informativ.com': 'Kedrick Butler',
  'kfelder@informativ.com': 'Kelly Felder',
  'mmiller@informativ.com': 'Melissa Miller',
  'rdoo@informativ.com': 'Robert Doo',
  'rgomez@informativ.com': 'Ruby Gomez',
  'dcarner@informativ.com': 'David Carner',
  'klang@informativ.com': 'Kimberly Lang',
  'nbrignola@informativ.com': 'Nick Brignola',
  // ELT functional owners
  'cwofford@informativ.com': 'Christina Wofford',
  'sharnekar@informativ.com': 'Santosh Harnekar',
  'dlarsen@informativ.com': 'Darin Larsen',
  'ddomm@informativ.com': 'Dave Domm',
  'hbestul@informativ.com': 'Heather Bestul',
  'rtruitt@informativ.com': 'Rebecca Truitt',
  'rrorick@informativ.com': 'Robert Rorick',
};

/**
 * Check if the authenticated user has one of the required roles.
 * Returns null if authorized, or a 403 response if not.
 *
 * If no user identity (anonymous server-to-server via API key only),
 * access is ALLOWED — server-to-server callers are trusted.
 *
 * Usage:
 *   const roleCheck = requireRole(event, _cors, 'manager', 'admin');
 *   if (roleCheck) return roleCheck;
 */
export function requireRole(event, corsHeaders, ...allowedRoles) {
  const user = getUser(event);

  // No user identity = server-to-server call (rebuild pipeline, scheduled task)
  // These are trusted — they authenticated via API key
  if (!user) return null;

  // Check if user has any of the allowed roles
  const userRoles = user.roles || [];
  const hasRole = userRoles.some(r => allowedRoles.includes(r));

  // Admin and ELT always pass
  if (!hasRole && !userRoles.includes('admin') && !userRoles.includes('elt')) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({
        error: 'Insufficient permissions',
        required: allowedRoles,
        your_roles: userRoles,
      }),
    };
  }

  return null;
}

/**
 * Get data scope for the authenticated user.
 * Returns { scope, rep_name, team, reports } for downstream data filtering.
 *
 * Scopes:
 *   'all'  — admin/management: see everything
 *   'team' — manager: see own team's data
 *   'own'  — rep: see own data only
 *   'cs'   — cs: see customer data (CI Dashboard scope)
 *   'all'  — no user identity (server-to-server): full access
 */
export function getDataScope(event) {
  const user = getUser(event);

  // Server-to-server: full access
  if (!user) return { scope: 'all', rep_name: null, team: null, reports: null };

  const roles = user.roles || [];
  const email = (user.email || '').toLowerCase();
  const repName = user.rep_name || EMAIL_TO_REP[email] || null;
  const team = repName ? REP_TEAM[repName] || null : null;

  // Admin or ELT (C-suite): full access to all dashboards
  if (roles.includes('elt')) {
    return { scope: 'all', rep_name: repName, team, reports: null };
  }

  // Admin: full access
  if (roles.includes('admin')) {
    return { scope: 'all', rep_name: repName, team, reports: null };
  }

  // Management: full access (CEO, COO, CFO, Directors see everything)
  if (roles.includes('manager')) {
    const mgrInfo = repName ? TEAM_MAP[repName] : null;
    if (mgrInfo) {
      // Director-level managers: team scope + own
      return {
        scope: 'all', // Per architecture doc: managers see all dashboards
        rep_name: repName,
        team: mgrInfo.team,
        reports: mgrInfo.reports,
      };
    }
    // C-suite managers (CEO, COO, CFO) without team: full access
    return { scope: 'all', rep_name: repName, team: null, reports: null };
  }

  // CS role: customer data access
  if (roles.includes('cs')) {
    return { scope: 'cs', rep_name: repName, team: null, reports: null };
  }

  // Rep: own data only
  if (roles.includes('rep')) {
    return { scope: 'own', rep_name: repName, team, reports: null };
  }

  // Unknown role: deny
  return { scope: 'none', rep_name: repName, team: null, reports: null };
}
