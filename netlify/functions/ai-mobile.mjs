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
import { validateApiKey } from './auth.mjs';

const MODEL = 'claude-haiku-4-5-20251001';
const TEMPERATURE = 0.6;
const MAX_TOKENS_MAP = {
    call_prep: 1200,
    follow_up: 800,
    discovery_script: 600
};

// Rate limiting
const rateLimits = new Map();
const RATE_WINDOW = 60000;
const RATE_MAX = 10;

// ── KNOWLEDGE BASE ──
let mobileKB = null;

function loadKB() {
    if (mobileKB) return;
    const paths = [process.cwd(), join(process.cwd(), '..', '..'), '/var/task'];
    for (const base of paths) {
        try {
            const raw = readFileSync(join(base, 'mobile-knowledge-base.json'), 'utf-8');
            mobileKB = JSON.parse(raw);
            return;
        } catch (e) { continue; }
    }
    mobileKB = {};
}

// ── CONTEXT SELECTION ──
// Each action gets different KB categories to keep context tight
const ACTION_CATEGORIES = {
    call_prep: ['products', 'competitive', 'value_selling', 'case_studies'],
    follow_up: ['products', 'value_selling', 'social_proof'],
    discovery_script: ['products', 'value_selling', 'objections']
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
**Subject:** [compelling subject line]

**Body:** [email body — 3-4 short paragraphs max]

Rules:
- Reference specifics from the last interaction (activity type, outcome, notes)
- Include one clear next step or CTA
- Professional but warm tone — not robotic
- Keep under 150 words
- No "I hope this email finds you well" or similar filler`,

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
export async function handler(event) {
    // --- Unified API Gateway middleware ---
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = validateApiKey(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');


    const headers = {
        'Content-Type': 'application/json',
        ..._cors
    };

    // Health check
    if (event.httpMethod === 'GET') {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'ok', actions: ['call_prep', 'follow_up', 'discovery_script'] })
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
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: call_prep, follow_up, discovery_script' }) };
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
            system: SYSTEM_PROMPTS[action],
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
