// /api/email/draft-to-outlook
// Generates a prospecting email via /api/ai/prospecting-draft, then delivers via:
//   Path A: Microsoft Graph /me/messages with isDraft:true (if rep has stored M365 token)
//   Path B: Outlook Web compose URL fallback (if no M365 token)
//
// Enforces 25/day cap per rep + 7-day same-prospect cooldown.
// Logs every draft to data/email-drafts-log.json (gateway repo) for cap tracking + Discipline scoring.
//
// STAGING LOCATION: Email Templates/build/email-draft-to-outlook.mjs
// DEPLOY TARGET: clevind34/informativ-api/netlify/functions/email-draft-to-outlook.mjs
// netlify.toml: add "/api/email/draft-to-outlook" -> "/.netlify/functions/email-draft-to-outlook" redirect
// included_files: add "data/email-drafts-log.json"

import { handleCors, corsHeaders } from './cors.mjs';
import { validateApiKey } from './auth.mjs';
import { logRequest } from './audit-log.mjs';

const DRAFTS_LOG_PATH = 'data/email-drafts-log.json';
const M365_TOKENS_PATH = 'data/m365-tokens-by-rep.json';
const GITHUB_REPO = 'Informativ-Business/informativ-api';
const DAILY_CAP = 25;
const COOLDOWN_DAYS = 7;
const OUTLOOK_WEB_COMPOSE = 'https://outlook.office.com/mail/deeplink/compose';

// ─────────────────────────────────────────────────────────────
// GitHub Contents API helpers (for drafts log persistence)
// ─────────────────────────────────────────────────────────────

async function ghGetFile(path) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not configured');
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'informativ-api' }
  });
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const data = await res.json();
  return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
}

async function ghPutFile(path, content, sha, message) {
  const token = process.env.GITHUB_TOKEN;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    ...(sha ? { sha } : {})
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'informativ-api',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ─────────────────────────────────────────────────────────────
// Drafts log helpers (cap + cooldown enforcement)
// ─────────────────────────────────────────────────────────────

async function loadDraftsLog() {
  try {
    const { content, sha } = await ghGetFile(DRAFTS_LOG_PATH);
    if (!content) return { log: { drafts: [] }, sha: null };
    return { log: JSON.parse(content), sha };
  } catch (e) {
    console.error('Failed to load drafts log:', e.message);
    return { log: { drafts: [] }, sha: null };
  }
}

function checkCapAndCooldown(log, repEmail, prospectId, overrideCooldown) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const cooldownCutoff = new Date(now.getTime() - COOLDOWN_DAYS * 86400000);

  const drafts = log.drafts || [];

  // Daily cap is a HARD ceiling — never overridable
  const todayCount = drafts.filter(d => d.rep_email === repEmail && d.date === today).length;
  if (todayCount >= DAILY_CAP) {
    return { allowed: false, reason: 'daily_cap_reached', todayCount, cap: DAILY_CAP };
  }

  // Same-prospect within cooldown (SOFT — rep can override)
  const sameProspect = drafts.find(d =>
    d.rep_email === repEmail &&
    d.prospect_id === prospectId &&
    new Date(d.timestamp) > cooldownCutoff
  );
  if (sameProspect) {
    const daysAgo = Math.floor((now - new Date(sameProspect.timestamp)) / 86400000);
    if (!overrideCooldown) {
      return {
        allowed: false,
        reason: 'cooldown_active',
        last_drafted: sameProspect.timestamp,
        days_ago: daysAgo,
        cooldown_days: COOLDOWN_DAYS,
        can_override: true
      };
    }
    // Override granted — allow but tag for audit
    return {
      allowed: true,
      cooldown_overridden: true,
      previous_draft_days_ago: daysAgo,
      todayCount,
      capRemaining: DAILY_CAP - todayCount
    };
  }

  return { allowed: true, todayCount, capRemaining: DAILY_CAP - todayCount };
}

async function appendDraftLog(log, sha, entry) {
  const newLog = {
    ...log,
    last_updated: new Date().toISOString(),
    drafts: [...(log.drafts || []), entry]
  };
  // Keep last 10000 entries (rolling window) to prevent unbounded growth
  if (newLog.drafts.length > 10000) {
    newLog.drafts = newLog.drafts.slice(-10000);
  }
  await ghPutFile(
    DRAFTS_LOG_PATH,
    JSON.stringify(newLog, null, 2),
    sha,
    `Email draft logged: ${entry.rep_email} → ${entry.prospect_id}`
  );
}

// ─────────────────────────────────────────────────────────────
// M365 token lookup (for Graph API delivery)
// ─────────────────────────────────────────────────────────────

async function getRepM365Token(repEmail) {
  try {
    const { content } = await ghGetFile(M365_TOKENS_PATH);
    if (!content) return null;
    const tokens = JSON.parse(content);
    const repToken = tokens[repEmail];
    if (!repToken) return null;
    // Check expiry
    if (repToken.expires_at && new Date(repToken.expires_at) < new Date()) {
      console.log(`M365 token expired for ${repEmail}`);
      return null;
    }
    return repToken.access_token;
  } catch (e) {
    console.error('Failed to load M365 tokens:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Delivery: Microsoft Graph (Path A)
// ─────────────────────────────────────────────────────────────

async function createGraphDraft(accessToken, recipientEmail, subject, body) {
  const url = 'https://graph.microsoft.com/v1.0/me/messages';
  const message = {
    subject,
    body: {
      contentType: 'Text',
      content: body
    },
    toRecipients: [{ emailAddress: { address: recipientEmail } }]
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Microsoft Graph draft creation failed: ${res.status} ${err}`);
  }
  const data = await res.json();
  // webLink takes the rep directly to the draft in Outlook on the web
  return { draft_id: data.id, outlook_url: data.webLink };
}

// ─────────────────────────────────────────────────────────────
// Delivery: Outlook Web Compose URL (Path B fallback)
// ─────────────────────────────────────────────────────────────

function buildOutlookWebUrl(recipientEmail, subject, body) {
  // Outlook on the web compose URL with pre-populated fields.
  // CRITICAL: use encodeURIComponent (spaces -> %20), NOT URLSearchParams
  // (which encodes spaces as +). Outlook renders + literally in the body
  // because the compose deeplink doesn't decode application/x-www-form-urlencoded.
  const to = encodeURIComponent(recipientEmail || '');
  const subj = encodeURIComponent(subject || '');
  const bd = encodeURIComponent(body || '');
  return `${OUTLOOK_WEB_COMPOSE}?to=${to}&subject=${subj}&body=${bd}`;
}

// ─────────────────────────────────────────────────────────────
// Internal call to /api/ai/prospecting-draft
// ─────────────────────────────────────────────────────────────

async function generateDraftContent(input, apiKey) {
  // Call sibling function via internal URL or by importing handler directly.
  // Simplest: invoke via fetch to the same gateway origin.
  const gatewayBase = process.env.URL || 'https://informativ-sales-api.netlify.app';
  const res = await fetch(`${gatewayBase}/api/ai/prospecting-draft`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI generation failed: ${res.status} ${err}`);
  }
  return await res.json();
}

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

async function _handler(event) {
  const corsCheck = handleCors(event);
  if (corsCheck) return corsCheck;

  const authCheck = validateApiKey(event);
  if (authCheck) return authCheck;

  const _cors = corsHeaders((event.headers || {}).origin || '');

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: _cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: _cors, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { prospect, rep, template_id_override, override_cooldown } = input;
  if (!prospect || !rep || !prospect.id || !rep.email) {
    return {
      statusCode: 400,
      headers: _cors,
      body: JSON.stringify({ error: 'Missing required fields: prospect.id, rep.email' })
    };
  }

  // ─── 1. Cap + cooldown check ──────────────────────────────
  const { log, sha } = await loadDraftsLog();
  const capCheck = checkCapAndCooldown(log, rep.email, prospect.id, !!override_cooldown);
  if (!capCheck.allowed) {
    return {
      statusCode: 429,
      headers: _cors,
      body: JSON.stringify({
        success: false,
        error: capCheck.reason,
        ...capCheck
      })
    };
  }

  // ─── 2. Recent template usage lookup ──────────────────────
  const recentTemplates = (log.drafts || [])
    .filter(d => d.rep_email === rep.email)
    .slice(-30) // last 30 drafts
    .map(d => d.template_id);
  const uniqueRecent = [...new Set(recentTemplates)];

  // ─── 3. Generate email content via AI ─────────────────────
  let aiOutput;
  try {
    aiOutput = await generateDraftContent({
      prospect,
      rep,
      template_id_override,
      rep_recent_template_usage: uniqueRecent
    }, process.env.API_KEY);
  } catch (e) {
    return {
      statusCode: 500,
      headers: _cors,
      body: JSON.stringify({ success: false, error: 'AI generation failed', detail: e.message })
    };
  }

  if (!aiOutput.success) {
    return {
      statusCode: 500,
      headers: _cors,
      body: JSON.stringify({ success: false, error: 'AI returned non-success', detail: aiOutput })
    };
  }

  // ─── 4. Resolve recipient email ───────────────────────────
  // Prefer prospect.email; fall back to first additional contact; else empty (rep adds in Outlook)
  const recipientEmail = prospect.email
    || (prospect.contacts && prospect.contacts[0] && prospect.contacts[0].email)
    || '';

  // ─── 5. Decide delivery path ──────────────────────────────
  const m365Token = await getRepM365Token(rep.email);
  let deliveryMode, outlookUrl, draftId = null;

  if (m365Token) {
    try {
      const graphResult = await createGraphDraft(m365Token, recipientEmail, aiOutput.subject, aiOutput.body);
      deliveryMode = 'graph_draft';
      outlookUrl = graphResult.outlook_url;
      draftId = graphResult.draft_id;
    } catch (e) {
      console.error('Graph draft failed, falling back to web compose:', e.message);
      deliveryMode = 'outlook_web_compose_fallback';
      outlookUrl = buildOutlookWebUrl(recipientEmail, aiOutput.subject, aiOutput.body);
    }
  } else {
    deliveryMode = 'outlook_web_compose';
    outlookUrl = buildOutlookWebUrl(recipientEmail, aiOutput.subject, aiOutput.body);
  }

  // ─── 6. Log to drafts log (for cap tracking + Discipline) ─
  const logEntry = {
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    rep_email: rep.email,
    rep_name: rep.name,
    prospect_id: prospect.id,
    prospect_company: prospect.company_name || prospect.co || '',
    template_id: aiOutput.template_id,
    delivery_mode: deliveryMode,
    personalization_warning: aiOutput.personalization_warning || false,
    subject: aiOutput.subject,
    body_length: aiOutput.body.length,
    draft_id: draftId,
    cooldown_overridden: capCheck.cooldown_overridden || false,
    previous_draft_days_ago: capCheck.previous_draft_days_ago || null
  };

  try {
    await appendDraftLog(log, sha, logEntry);
  } catch (e) {
    console.error('Drafts log write failed (non-fatal):', e.message);
    // Don't fail the request — rep still gets their draft
  }

  // ─── 6b. Fire-and-forget: log to pie-activity-log for Discipline scoring ───
  // Counts email_drafted as an activity event toward the rep's daily target.
  // compute_daily_activity.py reads pie-activity-log.json — this is the wire.
  try {
    const gatewayBase = process.env.URL || 'https://informativ-sales-api.netlify.app';
    fetch(`${gatewayBase}/api/analytics/field-activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY },
      body: JSON.stringify({
        rep: rep.name,
        rep_email: rep.email,
        prospect_id: prospect.id,
        prospect_company: prospect.company_name || prospect.co || '',
        event_type: 'email_drafted',
        outcome: 'draft_created',
        metadata: {
          template_id: aiOutput.template_id,
          delivery_mode: deliveryMode,
          personalization_warning: aiOutput.personalization_warning || false
        },
        timestamp: new Date().toISOString()
      })
    }).catch(function(e) { console.error('field-activity log non-fatal:', e.message); });
  } catch (e) {
    // Fire-and-forget — never block the response
  }

  // ─── 7. Return to caller ──────────────────────────────────
  return {
    statusCode: 200,
    headers: { ..._cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      delivery_mode: deliveryMode,
      outlook_url: outlookUrl,
      draft_id: draftId,
      template_id: aiOutput.template_id,
      template_rationale: aiOutput.template_rationale,
      subject: aiOutput.subject,
      body: aiOutput.body,
      body_preview: aiOutput.body.slice(0, 300) + (aiOutput.body.length > 300 ? '…' : ''),
      personalization_warning: aiOutput.personalization_warning || false,
      personalization_warning_message: aiOutput.personalization_warning_message || null,
      cap_remaining: capCheck.capRemaining - 1,
      cap_daily: DAILY_CAP,
      cooldown_overridden: capCheck.cooldown_overridden || false
    })
  };
}

export const handler = async (event) => {
  const response = await _handler(event);
  await logRequest(event, response);
  return response;
};
