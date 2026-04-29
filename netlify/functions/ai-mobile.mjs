/**
 * Chuck API — PIE Mobile Netlify Function
 * Lightweight AI proxy for field sales reps.
 * 3 action modes: call_prep, follow_up, discovery_script
 * Uses Claude Haiku 4.5 with curated mobile knowledge base.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── CONFIG ──
import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { safeError } from './safe-error.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const TEMPERATURE = 0.6;
const MAX_TOKENS_MAP = {
    call_prep: 1200,
    follow_up: 800,
    discovery_script: 600,
    competitive_pricing_response: 1000
};

// Rate limiting
const rateLimits = new Map();
const RATE_WINDOW = 60000;
const RATE_MAX = 10;

// ── KNOWLEDGE BASE ──
let mobileKB = null;
let emailGuidance = null;

function loadKB() {
    const paths = [process.cwd(), join(process.cwd(), '..', '..'), '/var/task'];
    if (!mobileKB) {
        for (const base of paths) {
            try {
                const raw = readFileSync(join(base, 'mobile-knowledge-base.json'), 'utf-8');
                mobileKB = JSON.parse(raw);
                break;
            } catch (e) { continue; }
        }
        if (!mobileKB) mobileKB = {};
    }
    if (!emailGuidance) {
        for (const base of paths) {
            try {
                const raw = readFileSync(join(base, 'email-guidance.json'), 'utf-8');
                emailGuidance = JSON.parse(raw);
                break;
            } catch (e) { continue; }
        }
    }
}

// Compact email guidance block for mobile (token-budget aware)
function getMobileEmailGuidanceBlock() {
    if (!emailGuidance) return '';
    const eg = emailGuidance;
    const prohibits = (eg.prohibitions || []).map(p => `- ${p.rule}`).join('\n');
    return `
## CUSTOMER-FACING EMAIL STANDARDS (Marketing-approved, ${eg.last_updated || 'April 2026'})
SUBJECT: 'Checking in: [Account] & Informativ' (default) or 'Let's ensure the success of [Account] with Informativ' (intervention). No creative variants. Always fill in account name.
OPENER: For check-ins, lead with thank-you for the partnership. For new-prospect bid responses, 'Thank you for the opportunity to bid on [Customer]'s credit business.'
PROHIBITIONS:
${prohibits}
CTA: '${eg.standard_cta?.wording || ''}'
The 'link to my calendar' phrasing is intentional — rep's signature carries the actual link. No placeholder URLs or {{tokens}}.
FORMATTING: 2 blank lines between paragraphs, 1 between bullets, uniform.
TONE: Warm, professional, trusted advisor. Never vendor or salesperson.
SELF-CHECK: Before returning, verify ZERO mentions of margin, ZERO tier names, ZERO 'Total Solutions' (plural), ZERO specific products attributed to customer, partnership opener present, standard CTA used. If any check fails, rewrite.
`.trim();
}

// ── CONTEXT SELECTION ──
// Each action gets different KB categories to keep context tight
const ACTION_CATEGORIES = {
    call_prep: ['products', 'competitive', 'value_selling', 'case_studies'],
    follow_up: ['products', 'value_selling', 'social_proof', 'email_standards'],
    discovery_script: ['products', 'value_selling', 'objections'],
    competitive_pricing_response: ['competitive', 'objections', 'value_selling', 'email_standards']
};

function buildContext(action, prospect) {
    loadKB();
    const categories = ACTION_CATEGORIES[action] || ['products'];
    let context = '';
    let budget = 12000; // ~3K tokens max context

    for (const cat of categories) {
        const chunks = mobileKB[cat];
        if (!chunks || budget <= 0) continue;

        // Pick top chunks that fit budget
        for (const chunk of chunks) {
            if (budget <= 0) break;
            const text = chunk.c || '';
            if (text.length > budget) continue;
            context += `\n[${chunk.s}]\n${text}\n`;
            budget -= text.length;
        }
    }

    return context;
}

// ── PROSPECT SUMMARY ──
function formatProspect(p) {
    if (!p) return 'No prospect data provided.';
    const lines = [];
    if (p.company) lines.push(`Company: ${p.company}`);
    if (p.contact) lines.push(`Contact: ${p.contact}`);
    if (p.title) lines.push(`Title: ${p.title}`);
    if (p.oem) lines.push(`OEM/Franchise: ${p.oem}`);
    if (p.city || p.state) lines.push(`Location: ${[p.city, p.state].filter(Boolean).join(', ')}`);
    if (p.vehicles_sold) lines.push(`Est. Vehicles Sold/mo: ${p.vehicles_sold}`);
    if (p.icp_score) lines.push(`ICP Score: ${p.icp_score}`);
    if (p.products) lines.push(`Current Products: ${p.products}`);
    if (p.health_score) lines.push(`Health Score: ${p.health_score}`);
    if (p.type) lines.push(`Prospect Type: ${p.type}`); // net-new, cross-sell, affiliate
    if (p.last_activity) lines.push(`Last Activity: ${p.last_activity}`);
    if (p.last_notes) lines.push(`Last Notes: ${p.last_notes}`);
    if (p.last_outcome) lines.push(`Last Outcome: ${p.last_outcome}`);
    if (p.dealer_intel) {
        const di = p.dealer_intel;
        if (di.crm) lines.push(`CRM: ${di.crm}`);
        if (di.dms) lines.push(`DMS: ${di.dms}`);
        if (di.credit_provider) lines.push(`Credit Provider: ${di.credit_provider}`);
        if (di.los) lines.push(`LOS: ${di.los}`);
    }
    return lines.join('\n');
}

// ── SYSTEM PROMPTS ──
const SYSTEM_PROMPTS = {
    call_prep: `You are Chuck, Informativ's AI sales coach, preparing a field sales rep for a prospect call.

You are direct, tactical, and concise. No fluff. The rep is likely sitting in a parking lot about to walk in.

Generate a structured call prep with these sections:
1. **Opening Hook** — A specific, personalized opening line (not generic "I noticed you...")
2. **Key Talking Points** (3-4 bullets) — What to emphasize based on this prospect's profile
3. **Discovery Questions** (2-3) — High-value questions to uncover pain and urgency
4. **Competitive Angle** — If they use a competitor (700Credit, NCC), how to position against them
5. **Products to Position** — Which Informativ solutions fit this prospect and why

Keep it under 300 words total. Use short bullets. This is a mobile screen.`,

    follow_up: `You are Chuck, Informativ's AI sales coach, drafting a follow-up email for a field sales rep.

Write a professional, concise follow-up email based on the prospect data and recent activity.

Format:
**Subject:** [compelling subject line — follow Marketing-approved subject line standards]

**Body:** [email body — 3-4 short paragraphs max]

Rules:
- Reference specifics from the last interaction (activity type, outcome, notes)
- Include one clear next step or CTA
- Professional but warm tone — not robotic
- Keep under 150 words
- No "I hope this email finds you well" or similar filler
- ALL Marketing email standards apply (see standards block at end of system prompt)`,

    competitive_pricing_response: `You are Chuck, Informativ's AI sales coach, drafting a customer-facing response to a price-pressure bid (the prospect is comparing Informativ to a thin-margin credit aggregator like Strategic Source, 700Credit, or NCC).

Use the Combatting Low Margin Credit positioning. Core structure:

1. **Open with respect for their time** — thank them for the bid opportunity, flag upfront you want to be transparent before either team invests further. Do NOT use the standard 'Thank you for your partnership' opener — this is a new-prospect bid response.

2. **Establish the bureau-cost reality** — every credit provider buys from the same three bureaus at the same wholesale cost. Bureau data cost is industry-fixed. When competitors quote significantly lower pricing, that variation reflects different margin philosophies and what each is willing to cut (service, support, compliance, fraud detection).

3. **Surface the long-term cycle** — bureaus raise prices annually, every provider passes increases through. Transactional credit pricing is a losing battle.

4. **Position structural cost control** — Credit Guardrails is the only framework actively managing WHEN/HOW credit is pulled. Structural cost control, not temporary pricing.

5. **Be direct about platform-vs-aggregator** — 'We are not built as a thin-margin credit reseller. We are built as a platform partner designed to manage cost, reduce risk, and grow with you.'

6. **Give an honest exit** — 'If the goal is the lowest number today, there will always be a thinner option than Informativ. If the goal is sustainable cost control and a platform built for long-term performance, that's where we differentiate.'

7. **Offer Credit Guardrails walkthrough** as next step. Be explicit if they're shopping pure bureau price, you're declining to bid further. 'We will not be the lowest price option.'

Format: Subject line, '---' separator, full email body. Keep under 250 words.

Marketing email standards apply (see block at end of system prompt). The 'no margin' rule still holds — even when discussing competitive pricing, you discuss bureau cost and pricing philosophy, NEVER margin.`,

    discovery_script: `You are Chuck, Informativ's AI sales coach, creating a quick discovery talk track for a cold/warm call.

Generate a concise talk track with:
1. **Intro** (1 sentence) — Who you are and why you're calling, personalized to this prospect
2. **Pain Point Hook** (1-2 sentences) — A relevant industry challenge to get them talking
3. **Value Statement** (1-2 sentences) — How Informativ addresses that pain specifically
4. **Qualifying Question** — One question to assess fit and create dialogue
5. **Soft Close** — How to ask for the next step (meeting, demo, pricing)

Total: 5 bullets, under 100 words. The rep needs to glance and go.`
};

// ── RATE LIMITING ──
function checkRate(ip) {
    const now = Date.now();
    const timestamps = rateLimits.get(ip) || [];
    const recent = timestamps.filter(t => now - t < RATE_WINDOW);
    if (recent.length >= RATE_MAX) return false;
    recent.push(now);
    rateLimits.set(ip, recent);
    return true;
}

// ── HANDLER ──
async function _handler(event) {
    // --- Unified API Gateway middleware ---
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');
    const rlCheck = checkRateLimit(event, _cors);
    if (rlCheck) return rlCheck;


    const headers = {
        'Content-Type': 'application/json',
        ..._cors
    };

    // Health check
    if (event.httpMethod === 'GET') {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'ok', actions: ['call_prep', 'follow_up', 'discovery_script', 'competitive_pricing_response'] })
        };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Rate limit
    const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    if (!checkRate(ip)) {
        return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Wait a moment.' }) };
    }

    // Parse
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { action, prospect, repName } = body;

    if (!action || !SYSTEM_PROMPTS[action]) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: call_prep, follow_up, discovery_script, competitive_pricing_response' }) };
    }

    // Build context
    const kbContext = buildContext(action, prospect);
    const prospectSummary = formatProspect(prospect);

    const userMessage = `Rep: ${repName || 'Sales Rep'}

PROSPECT PROFILE:
${prospectSummary}

${kbContext ? `INFORMATIV KNOWLEDGE:\n${kbContext}` : ''}

Generate the ${action.replace('_', ' ')} now.`;

    // Call Claude
    try {
        const client = new Anthropic();
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS_MAP[action] || 800,
            temperature: TEMPERATURE,
            system: (action === 'follow_up' || action === 'competitive_pricing_response')
                ? SYSTEM_PROMPTS[action] + '\n\n' + getMobileEmailGuidanceBlock()
                : SYSTEM_PROMPTS[action],
            messages: [{ role: 'user', content: userMessage }]
        });

        const text = response.content[0]?.text || 'Unable to generate response.';

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ response: text, action, model: MODEL })
        };

    } catch (error) {
        console.error('Chuck API error:', error);

        if (error.status === 429) {
            return { statusCode: 429, headers, body: JSON.stringify({ error: 'Chuck is busy. Try again in a moment.' }) };
        }

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Something went wrong. Try again.' })
        };
    }
}

// Phase 2B-3: Audit log wrapper
export async function handler(event) {
  const response = await _handler(event);
  logRequest(event, response);
  return response;
}
