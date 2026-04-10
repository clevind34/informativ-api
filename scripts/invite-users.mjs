#!/usr/bin/env node
/**
 * Invite all 30 Informativ users to Netlify Identity with role metadata.
 *
 * Prerequisites:
 *   1. Netlify Identity enabled on informativ-sales-api.netlify.app
 *   2. NETLIFY_AUTH_TOKEN env var set (Personal Access Token from Netlify dashboard)
 *   3. Registration set to invite-only
 *
 * Usage:
 *   NETLIFY_AUTH_TOKEN=xxx node scripts/invite-users.mjs
 *   NETLIFY_AUTH_TOKEN=xxx node scripts/invite-users.mjs --dry-run
 *   NETLIFY_AUTH_TOKEN=xxx node scripts/invite-users.mjs --debug
 */

const SITE_DOMAIN = 'informativ-sales-api.netlify.app';

const USERS = [
  // Admin (2)
  { email: 'mbyrd@informativ.com', roles: ['admin'], rep_name: 'Michael Byrd', team: null },
  { email: 'cbyrd@informativ.com', roles: ['admin'], rep_name: 'Carson Byrd', team: null },

  // Management (7)
  { email: 'dcarner@informativ.com', roles: ['elt'], rep_name: 'David Carner', team: null },
  { email: 'klang@informativ.com', roles: ['elt'], rep_name: 'Kimberly Lang', team: null },
  { email: 'nbrignola@informativ.com', roles: ['elt'], rep_name: 'Nick Brignola', team: null },
  { email: 'tbordenet@informativ.com', roles: ['manager'], rep_name: 'Teresa Bordenet', team: 'Bordenet' },
  { email: 'jcarlucci@informativ.com', roles: ['manager'], rep_name: 'Joel Carlucci', team: 'Carlucci' },
  { email: 'cknievel@informativ.com', roles: ['manager'], rep_name: 'Curtis Knievel', team: 'Knievel' },
  { email: 'ksandoval@informativ.com', roles: ['manager'], rep_name: 'Kiristen Sandoval', team: 'CS' },

  // Sales Reps (11)
  { email: 'csanford@informativ.com', roles: ['rep'], rep_name: 'Carol Sanford', team: 'Bordenet' },
  { email: 'mhanaman@informativ.com', roles: ['rep'], rep_name: 'Matt Hanaman', team: 'Bordenet' },
  { email: 'trichter@informativ.com', roles: ['rep'], rep_name: 'Tami Richter', team: 'Bordenet' },
  { email: 'tsmith@informativ.com', roles: ['rep'], rep_name: 'Trish Smith', team: 'Bordenet' },
  { email: 'cromero@informativ.com', roles: ['rep'], rep_name: 'Clarence Romero', team: 'Bordenet' },
  { email: 'agough@informativ.com', roles: ['rep'], rep_name: 'Ashton Gough', team: 'Carlucci' },
  { email: 'wcarroll@informativ.com', roles: ['rep'], rep_name: 'Ward Carroll', team: 'Carlucci' },
  { email: 'wfowler@informativ.com', roles: ['rep'], rep_name: 'William Fowler', team: 'Carlucci' },
  { email: 'bhutchinson@informativ.com', roles: ['rep'], rep_name: 'Brock Hutchinson', team: 'Carlucci' },
  { email: 'calvarado@informativ.com', roles: ['rep'], rep_name: 'Crly Alvarado', team: 'Knievel' },
  { email: 'tcanley@informativ.com', roles: ['rep'], rep_name: 'Tim Canley', team: 'Knievel' },

  // Customer Success (10)
  { email: 'asweet@informativ.com', roles: ['cs'], rep_name: 'Andrea Sweet', team: 'CS' },
  { email: 'cmanz@informativ.com', roles: ['cs'], rep_name: 'Chad Manz', team: 'CS' },
  { email: 'cbouvier@informativ.com', roles: ['cs'], rep_name: 'Chaquowa Bouvier', team: 'CS' },
  { email: 'ischweitzer@informativ.com', roles: ['cs'], rep_name: 'Irma Schweitzer', team: 'CS' },
  { email: 'jcraddock@informativ.com', roles: ['cs'], rep_name: 'Jennifer Craddock', team: 'CS' },
  { email: 'kbutler@informativ.com', roles: ['cs'], rep_name: 'Kedrick Butler', team: 'CS' },
  { email: 'kfelder@informativ.com', roles: ['cs'], rep_name: 'Kelly Felder', team: 'CS' },
  { email: 'mmiller@informativ.com', roles: ['cs'], rep_name: 'Melissa Miller', team: 'CS' },
  { email: 'rdoo@informativ.com', roles: ['cs'], rep_name: 'Robert Doo', team: 'CS' },
  { email: 'rgomez@informativ.com', roles: ['cs'], rep_name: 'Ruby Gomez', team: 'CS' },
];

const API_BASE = 'https://api.netlify.com/api/v1';

async function resolveSiteId(token) {
  // Look up the real site ID from the domain name
  const url = `${API_BASE}/sites/${SITE_DOMAIN}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`Cannot resolve site: ${resp.status} ${await resp.text()}`);
  }
  const site = await resp.json();
  return { id: site.id, name: site.name, url: site.ssl_url };
}

async function checkIdentity(token, siteId) {
  // Verify Identity is enabled and accessible
  const url = `${API_BASE}/sites/${siteId}/identity`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return { status: resp.status, ok: resp.ok, body: await resp.text() };
}

async function inviteUser(token, siteId, user, dryRun) {
  const url = `${API_BASE}/sites/${siteId}/identity/users`;

  const body = {
    email: user.email,
    app_metadata: {
      roles: user.roles,
      rep_name: user.rep_name,
      team: user.team,
    },
  };

  if (dryRun) {
    console.log(`[DRY RUN] Would invite: ${user.email} (${user.roles.join(',')}) team=${user.team}`);
    return { status: 'dry-run' };
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (resp.ok) {
    const data = await resp.json();
    console.log(`  Invited: ${user.email} → ${user.roles.join(',')} (ID: ${data.id})`);
    return { status: 'invited', id: data.id };
  } else {
    const err = await resp.text();
    if (resp.status === 422 && err.includes('already')) {
      console.log(`  Exists:  ${user.email} — already invited`);
      return { status: 'exists' };
    }
    console.error(`  FAILED:  ${user.email} — ${resp.status}: ${err}`);
    return { status: 'error', code: resp.status, detail: err };
  }
}

async function main() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const dryRun = process.argv.includes('--dry-run');
  const debug = process.argv.includes('--debug');

  if (!token && !dryRun) {
    console.error('Error: Set NETLIFY_AUTH_TOKEN env var (Netlify Personal Access Token)');
    console.error('Get one at: https://app.netlify.com/user/applications#personal-access-tokens');
    process.exit(1);
  }

  console.log(`\nInformativ Identity — User Invite Script`);

  // Step 1: Resolve the real site ID from domain name
  console.log(`\nResolving site ID for ${SITE_DOMAIN}...`);
  let siteId;
  try {
    const site = await resolveSiteId(token);
    siteId = site.id;
    console.log(`  Site: ${site.name} (${site.id})`);
    console.log(`  URL:  ${site.url}`);
  } catch (e) {
    console.error(`  ERROR: ${e.message}`);
    console.error(`  Check that your NETLIFY_AUTH_TOKEN is valid.`);
    process.exit(1);
  }

  // Step 2: Verify Identity is enabled
  if (debug || !dryRun) {
    console.log(`\nChecking Identity status...`);
    const identity = await checkIdentity(token, siteId);
    if (identity.ok) {
      console.log(`  Identity: ENABLED`);
    } else {
      console.error(`  Identity: NOT FOUND (${identity.status})`);
      console.error(`  Response: ${identity.body.substring(0, 200)}`);
      console.error(`\n  Enable Identity at: https://app.netlify.com/sites/${SITE_DOMAIN}/identity`);
      process.exit(1);
    }
  }

  // Step 3: Invite users
  console.log(`\nUsers: ${USERS.length}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  const results = { invited: 0, exists: 0, error: 0 };

  for (const user of USERS) {
    const result = await inviteUser(token, siteId, user, dryRun);
    results[result.status] = (results[result.status] || 0) + 1;

    // Rate limit: 100ms between invites to avoid throttling
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone. Invited: ${results.invited || 0}, Already existed: ${results.exists || 0}, Errors: ${results.error || 0}`);

  if (!dryRun && results.invited > 0) {
    console.log(`\nNext steps:`);
    console.log(`  1. Users will receive invite emails from Netlify`);
    console.log(`  2. They click the link, set a password, and they're in`);
    console.log(`  3. Their role metadata is already set — no further config needed`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
