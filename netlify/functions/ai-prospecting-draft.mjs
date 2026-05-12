// /api/ai/prospecting-draft
// Generates a personalized prospecting email draft using marketing-approved templates.
// Enforces strategic positioning guardrails from Combatting Low Margin Credit doc.
// Returns structured JSON with template_id, subject, body, and personalization signals.
//
// STAGING LOCATION: Email Templates/build/ai-prospecting-draft.mjs
// DEPLOY TARGET: clevind34/informativ-api/netlify/functions/ai-prospecting-draft.mjs
// netlify.toml: add "/api/ai/prospecting-draft" -> "/.netlify/functions/ai-prospecting-draft" redirect
// included_files: add "data/marketing-prospecting-templates.json"

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { handleCors, corsHeaders } from './cors.mjs';
import { validateApiKey } from './auth.mjs';
import { logRequest } from './audit-log.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const TEMPERATURE = 0.4;
const MAX_TOKENS = 1200;

// Load templates catalog once at cold start
let TEMPLATES_CATALOG = null;
function loadTemplates() {
  if (TEMPLATES_CATALOG) return TEMPLATES_CATALOG;
  const path = join(process.cwd(), 'data', 'marketing-prospecting-templates.json');
  const raw = readFileSync(path, 'utf-8');
  TEMPLATES_CATALOG = JSON.parse(raw);
  return TEMPLATES_CATALOG;
}

function buildSystemPrompt(catalog) {
  // Compact catalog for token efficiency
  const templateSummaries = catalog.templates.map(t => ({
    id: t.id,
    category: t.category,
    subject: t.subject,
    body: t.body,
    best_for: t.best_for,
    avoid_when: t.avoid_when,
    dealer_profile: t.dealer_profile,
    primary_hook: t.primary_hook,
    case_study_subject: t.case_study_subject || null,
    is_default_fallback: t.is_default_fallback || false,
    guardrail_note: t.guardrail_note || null
  }));

  return `You are Chuck, the AI sales coach for Informativ — an automotive dealership platform combining credit, compliance, fraud detection, customer insights, and SmartPencil payment intelligence.

Generate a personalized prospecting email draft. The rep will review and send from their Outlook. You are the assistant, not the closer.

## HARD RULES — VIOLATING ANY OF THESE IS A FAILURE

1. NEVER lead with credit price competition. Bureau data costs are fixed and standardized across all providers. Competing on per-pull rates is a losing game. If the prospect intel indicates they are shopping credit price (RFP, Strategic Source, head-to-head pricing comparison), pivot to Credit Guardrails framing per the canonical language below.

2. NEVER claim "lowest price," "cheapest," "we'll match their rate," "discount," "beat their rate," "save on bureau cost," or "lower per-pull rate."

3. ALWAYS frame Informativ as an INNOVATOR, not an aggregator. We build, own, and extend the platform. SmartPencil is the latest proof. Aggregators stitch together third-party tools.

4. NEVER generate the email body from scratch. You MUST use one of the approved templates listed below as the editorial baseline. You may add ONE personalization opener and substitute tokens. That's it.

5. NEVER generate a subject line from scratch. Use the template's subject as-is OR add a brief 3-7 word personalized prefix.

6. NEVER inject a signature in the body. Outlook auto-appends the rep's signature on send. End with rep's first name + line break only.

7. Personalization SHOULD include at least one dealer-specific sentence beyond token substitution. If you have zero personalization signals beyond first name, generate a generic version with token substitution only AND set personalization_warning=true.

## CANONICAL LANGUAGE FOR PRICE-SHOPPING PROSPECTS (paraphrase, don't copy verbatim)

When prospect signals credit-price shopping (RFP, Strategic Source involvement, asks for per-pull rates, dealer_intel.last_disposition mentions pricing), use Credit Guardrails STRUCTURAL framing — NOT transactional price competition:

- "Every credit provider in the automotive space draws from the same bureau infrastructure. Underlying data costs are the same. When you see significant price variation in competing bids, you're not looking at different data — you're looking at different margin philosophies."
- "Credit bureaus raise prices every year. Every provider passes those through. A transactional approach to credit cost is a losing battle over time."
- "The only real way to control credit cost long term is utilization governance. Credit Guardrails is the only framework in the market designed to actively manage when and how credit is pulled — reducing unnecessary bureau usage while protecting compliance and stabilizing costs under a flat-rate model. That's structural cost control, not temporary pricing."
- "We are not built as a thin-margin credit reseller. We are built as a platform partner."
- "If the goal is the lowest number today, there will always be a thinner option than Informativ. If the goal is sustainable cost control and long-term performance, that's where we differentiate."
- Be willing to walk away: "If you are just looking for a credit bid, we would not want to burn up any more of your time."

Use the named framework "Credit Guardrails" — it's proprietary and differentiated.

## TEMPLATE CATALOG (25 marketing-approved templates)

${JSON.stringify(templateSummaries, null, 2)}

## TOKEN SUBSTITUTION

- {{Recipient.FirstName}} → prospect.fn (or "there" if missing)
- {{{Sender.Calendar_Link__c}}} → rep.calendar_link (if empty, replace the calendar line with: "Reply with a few times that work for you next week and I'll send an invite.")

## TEMPLATE SELECTION LOGIC (when no template_id_override provided)

Apply in order. First match wins.

1. IF dealer_intel.credit_provider is a competitor AND dealer_intel.hard_pulls_per_month > 1500 → use e25_20k_pulls_compliance with Credit Guardrails framing.
2. IF dealer_intel.last_disposition or last_activity mentions fraud → use e06 or e08.
3. IF prospect.group is set and ≥5 stores → case study (e21 Cavender for TX/SW, e22 Kunes for Midwest, e10 Boucher or e14 Pohanka for large groups).
4. IF prospect.oem is volume brand (Honda/Toyota/Chevrolet/Ford/Hyundai/Nissan/Stellantis) AND est_vehicles > 100 → speed pitch (e03 or e24).
5. IF dealer_intel.crm or dms is legacy → e17 or e19.
6. IF prospect.title includes CFO/Finance/Controller → stats-led (e06 or e15).
7. IF prospect.title includes Compliance/Audit → e15, e02, or e26.
8. PRICE-SHOPPING OVERRIDE: If prospect signals credit-price shopping (Strategic Source, RFP, per-pull pricing request) → use e17 as base BUT integrate Credit Guardrails canonical language heavily.
9. Default fallback: e17_one_platform.

De-rotation: if chosen template is in rep_recent_template_usage, pick next-best from same category.

## OUTPUT FORMAT — STRICT JSON

You MUST return valid JSON in this exact shape (no other output, no markdown wrapper):

{
  "template_id": "string (must match an id from catalog)",
  "template_rationale": "string (1-2 sentences explaining why this template fit)",
  "subject": "string (final subject line as it will appear)",
  "subject_modified": false,
  "personalization_opener": "string or null (the ONE sentence added after greeting)",
  "personalization_warning": false,
  "personalization_warning_message": null,
  "body": "string (full final email body with tokens substituted, opener inserted, ending with rep first name)",
  "personalization_signals_used": ["oem", "city", "est_vehicles"],
  "guardrail_violations": []
}

If you cannot generate (e.g., trigger insufficient_personalization), still produce the full output with personalization_warning=true. NEVER refuse — generate a generic version.

If you detected and applied a price-shopping override, set template_rationale to start with "PRICE-SHOPPING OVERRIDE: " and add "price_shopping_pivot" to personalization_signals_used.`;
}

function buildUserMessage(input) {
  return `Generate a draft email for this prospect.

PROSPECT:
${JSON.stringify(input.prospect, null, 2)}

REP:
${JSON.stringify(input.rep, null, 2)}

TEMPLATE OVERRIDE (use this template if set, skip selection logic):
${input.template_id_override || 'null'}

REP RECENT TEMPLATE USAGE (deprioritize these from selection):
${JSON.stringify(input.rep_recent_template_usage || [])}

Return JSON only. No markdown wrapper, no commentary.`;
}

function validateOutput(parsed, catalog) {
  const validIds = new Set(catalog.templates.map(t => t.id));
  const errors = [];
  if (!parsed.template_id || !validIds.has(parsed.template_id)) {
    errors.push(`template_id "${parsed.template_id}" not in catalog`);
  }
  if (!parsed.subject || typeof parsed.subject !== 'string') {
    errors.push('subject missing or not a string');
  }
  if (!parsed.body || typeof parsed.body !== 'string') {
    errors.push('body missing or not a string');
  }
  if (parsed.body && parsed.body.length > 3000) {
    errors.push(`body too long (${parsed.body.length} chars, max 3000)`);
  }
  // Check forbidden phrases
  const forbidden = ['lowest price', 'cheapest', "we'll match", "we will match",
                     'discount', 'beat their rate', 'lower per-pull rate'];
  const bodyLower = (parsed.body || '').toLowerCase();
  for (const phrase of forbidden) {
    if (bodyLower.includes(phrase)) {
      errors.push(`forbidden phrase detected: "${phrase}"`);
    }
  }
  return errors;
}

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

  if (!input.prospect || !input.rep) {
    return {
      statusCode: 400,
      headers: _cors,
      body: JSON.stringify({ error: 'Missing required fields: prospect, rep' })
    };
  }

  // Defaults for missing rep fields
  input.rep.first_name = input.rep.first_name || (input.rep.name || '').split(' ')[0] || 'there';
  input.rep.calendar_link = input.rep.calendar_link || '';

  // Defaults for missing prospect fields
  input.prospect.fn = input.prospect.fn || 'there';

  let catalog;
  try {
    catalog = loadTemplates();
  } catch (e) {
    return {
      statusCode: 500,
      headers: _cors,
      body: JSON.stringify({ error: 'Failed to load templates catalog', detail: e.message })
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: _cors,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' })
    };
  }

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: buildSystemPrompt(catalog),
      messages: [{ role: 'user', content: buildUserMessage(input) }]
    });
  } catch (e) {
    return {
      statusCode: 500,
      headers: _cors,
      body: JSON.stringify({ error: 'Anthropic API call failed', detail: e.message })
    };
  }

  const rawText = (response.content[0] && response.content[0].text) || '';

  // Strip any markdown wrapper if present
  let cleanText = rawText.trim();
  if (cleanText.startsWith('```json')) cleanText = cleanText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  else if (cleanText.startsWith('```')) cleanText = cleanText.replace(/^```\s*/, '').replace(/\s*```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(cleanText);
  } catch (e) {
    return {
      statusCode: 500,
      headers: _cors,
      body: JSON.stringify({
        error: 'AI returned invalid JSON',
        raw_output: cleanText.slice(0, 500),
        detail: e.message
      })
    };
  }

  const validationErrors = validateOutput(parsed, catalog);
  if (validationErrors.length > 0) {
    return {
      statusCode: 500,
      headers: _cors,
      body: JSON.stringify({
        error: 'AI output failed validation',
        validation_errors: validationErrors,
        ai_output: parsed
      })
    };
  }

  return {
    statusCode: 200,
    headers: { ..._cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: true,
      ...parsed,
      model: MODEL,
      generated_at: new Date().toISOString()
    })
  };
}

export const handler = async (event) => {
  const response = await _handler(event);
  await logRequest(event, response);
  return response;
};
