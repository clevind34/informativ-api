/**
 * Chuck Chat Function — Netlify Serverless
 * Handles intent detection, context selection, and Claude API calls.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ──────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────
import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { safeError } from './safe-error.mjs';

const MODEL = 'claude-haiku-4-5-20251001';  // Fast model for responsive coaching
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.7;
const MAX_CONTEXT_CHARS = 15000; // ~3.5K tokens — tighter context for speed

// Rate limiting (simple in-memory)

// ──────────────────────────────────────────
// DATA LOADING
// ──────────────────────────────────────────
let knowledgeBase = null;
let repPerformance = null;
let trainingProgress = null;
let methodCurriculum = null;
let managerCurriculum = null;
let coachingIntelligence = null;  // Phase 2: trajectory data
let csKnowledgeBase = null;  // Phase CS: Customer Success knowledge base

// Product certification files — loaded for Prep with Chuck across all programs
let certificationFiles = {};
const CERT_FILE_MAP = {
    'smartpencil': 'smartpencil-certification.json',
    'tier': 'tier-certification.json',
    'value selling': 'value-selling-certification.json',
    'value-selling': 'value-selling-certification.json',
    'total solutions — sales': 'total-solutions-sales-certification.json',
    'total solutions sales': 'total-solutions-sales-certification.json',
    'total solutions — manager': 'total-solutions-manager-certification.json',
    'total solutions manager': 'total-solutions-manager-certification.json',
    'payments channel': 'payments-channel-certification.json',
    'payments': 'payments-channel-certification.json',
    'informativ method': 'informativ-method-certification.json',
};

function loadData() {
    // In Netlify Functions, the working directory is the repo root
    // Data files are at the repo root alongside index.html
    const basePaths = [
        process.cwd(),
        join(process.cwd(), '..', '..'),
        '/var/task'
    ];

    for (const base of basePaths) {
        try {
            const kbPath = join(base, 'knowledge-base.json');
            const rpPath = join(base, 'rep-performance.json');
            const tpPath = join(base, 'training-progress.json');
            const ccPath = join(base, 'informativ-method-curriculum.json');

            if (!knowledgeBase) {
                const kbRaw = readFileSync(kbPath, 'utf-8');
                knowledgeBase = JSON.parse(kbRaw);
            }
            if (!repPerformance) {
                const rpRaw = readFileSync(rpPath, 'utf-8');
                repPerformance = JSON.parse(rpRaw);
            }
            if (!trainingProgress) {
                try {
                    const tpRaw = readFileSync(tpPath, 'utf-8');
                    trainingProgress = JSON.parse(tpRaw);
                } catch (e) { /* training data optional */ }
            }
            if (!methodCurriculum) {
                try {
                    const ccRaw = readFileSync(ccPath, 'utf-8');
                    methodCurriculum = JSON.parse(ccRaw);
                } catch (e) { /* curriculum optional */ }
            }
            if (!managerCurriculum) {
                try {
                    const mcPath = join(base, 'informativ-method-manager-curriculum.json');
                    const mcRaw = readFileSync(mcPath, 'utf-8');
                    managerCurriculum = JSON.parse(mcRaw);
                } catch (e) { /* manager curriculum optional */ }
            }
            if (!coachingIntelligence) {
                try {
                    const ciPath = join(base, 'coaching-intelligence.json');
                    const ciRaw = readFileSync(ciPath, 'utf-8');
                    coachingIntelligence = JSON.parse(ciRaw);
                } catch (e) { /* coaching intelligence optional — Phase 2 */ }
            }
            if (!csKnowledgeBase) {
                try {
                    const csKbPath = join(base, 'cs-knowledge-base.json');
                    const csKbRaw = readFileSync(csKbPath, 'utf-8');
                    csKnowledgeBase = JSON.parse(csKbRaw);
                } catch (e) { /* CS knowledge base optional — CS Operations phase */ }
            }
            // Load all product certification files for Prep with Chuck
            if (Object.keys(certificationFiles).length === 0) {
                const uniqueFiles = [...new Set(Object.values(CERT_FILE_MAP))];
                for (const filename of uniqueFiles) {
                    try {
                        const certPath = join(base, filename);
                        const certRaw = readFileSync(certPath, 'utf-8');
                        certificationFiles[filename] = JSON.parse(certRaw);
                    } catch (e) { /* cert file optional */ }
                }
            }
            break;
        } catch (e) {
            continue;
        }
    }
}

// ──────────────────────────────────────────
// INTENT DETECTION
// ──────────────────────────────────────────
const INTENT_PATTERNS = {
    performance: [
        /quota/i, /attainment/i, /tracking/i, /performance/i, /how am i/i,
        /my numbers/i, /ytd/i, /mtd/i, /closed won/i, /pipeline health/i,
        /forecast/i, /where do i stand/i
    ],
    pipeline_coaching: [
        /pipeline issue/i, /hygiene/i, /stuck deal/i, /flagged/i,
        /fix.*pipeline/i, /improve.*pipeline/i, /top issue/i, /coaching/i,
        /what.*work on/i, /priority/i, /this week/i
    ],
    trajectory: [
        /trajectory/i, /hit.*quota/i, /make.*quota/i, /on track/i,
        /will i hit/i, /probability/i, /likelihood/i, /at risk/i,
        /projected.*attainment/i, /pace/i, /trending/i, /forecast.*quota/i,
        /going to miss/i, /close.*gap/i, /catch up/i
    ],
    products: [
        /smartpencil/i, /creditdriver/i, /credit driver/i, /\bcbc\b/i,
        /\bdsgss\b/i, /turbopass/i, /ez form/i, /vantagescore/i,
        /eclear/i, /adverse action/i, /compliance dashboard/i,
        /total solution/i, /product/i, /solution/i, /feature/i,
        /how does.*work/i, /tell me about/i, /what is/i, /payments/i,
        /verified stip/i, /informativ credit/i, /informativ compliance/i,
        /informativ customer insights/i, /informativ payments/i,
        /dealer safeguard/i, /credit bureau connection/i, /carmatic/i
    ],
    competitive: [
        /700credit/i, /seven hundred/i, /\bncc\b/i, /competitor/i,
        /competitive/i, /battle card/i, /differentiat/i, /advantage/i,
        /vs\./i, /versus/i, /compared to/i, /swot/i, /position/i,
        /experian/i, /equifax/i, /transunion/i
    ],
    objections: [
        /objection/i, /pushback/i, /concern/i, /overcome/i, /handle/i,
        /they said/i, /they think/i, /too expensive/i, /price objection/i,
        /not interested/i, /already have/i, /negotiate/i, /discount/i
    ],
    compliance: [
        /compliance/i, /fraud/i, /fcra/i, /ftc/i, /safeguard/i,
        /regulation/i, /adverse action/i, /identity/i, /synthetic/i,
        /audit/i, /violation/i, /risk/i
    ],
    discovery: [
        /discovery/i, /qualify/i, /question.*ask/i, /solution fit/i,
        /persona/i, /dealer.*type/i, /franchise/i, /meeting.*prep/i,
        /demo.*prep/i, /talk track/i
    ],
    pricing: [
        /pricing/i, /price/i, /cost/i, /roi/i, /package/i, /tier/i,
        /protect/i, /enrich/i, /elevate/i, /control/i, /quote/i,
        /margin/i, /cogs/i, /discount/i
    ],
    case_studies: [
        /case study/i, /example/i, /success story/i, /boucher/i,
        /cavender/i, /fremont/i, /kunes/i, /moritz/i, /customer.*story/i,
        /reference/i, /proof/i, /results/i
    ],
    testimonials: [
        /testimonial/i, /video.*testimonial/i, /customer.*quote/i, /dealer.*quote/i,
        /social proof/i, /customer.*said/i, /dealer.*said/i, /what.*customers.*say/i,
        /endorsement/i, /recommendation/i, /who.*uses/i, /who.*says/i,
        /send.*customer.*story/i, /send.*testimonial/i, /share.*quote/i,
        /\bquote\b.*about/i, /\bquotes?\b.*from/i, /give me a.*quote/i,
        /what.*dealer.*think/i, /customer.*feedback/i, /dealer.*feedback/i,
        /pohanka/i, /autobahn/i, /galpin/i, /firkins/i, /gay family/i,
        /crest auto/i, /cedar park/i, /chapma/i, /asbury/i, /holman/i,
        /rick case/i, /zamora/i, /ron lewis/i, /schomp/i, /sames/i
    ],
    integrations: [
        /integrat/i, /autofi/i, /upstart/i, /\bcudl\b/i, /carnow/i,
        /gubagoo/i, /vinsolution/i, /tekion/i, /routeone/i, /\bcdk\b/i,
        /partner/i, /connect/i
    ],
    email: [
        /email/i, /draft/i, /write.*email/i, /follow.?up/i, /outreach/i,
        /sequence/i, /template/i, /prospect.*email/i, /cold.*email/i,
        /message/i, /subject line/i
    ],
    sales_process: [
        /pipeline.*rule/i, /rules of engagement/i, /roe/i, /process/i,
        /cpq/i, /gtm/i, /go.to.market/i, /methodology/i, /glossary/i
    ],
    informativ_method: [
        /informativ method/i, /the method/i, /teach.*tailor/i, /take control/i, /commercial insight/i,
        /teaching pitch/i, /reframe/i, /rational drowning/i, /emotional impact/i,
        /constructive tension/i, /mobilizer/i, /how.*sell/i, /selling approach/i,
        /how.*pitch/i, /how.*present/i, /improve.*selling/i, /sales methodology/i,
        /better.*close/i, /close.*more/i, /close.*deal/i, /how.*position/i,
        /warmer/i, /new way/i, /insight.*lead/i, /lead.*insight/i,
        /rep.*profile/i, /relationship builder/i, /lone wolf/i, /hard worker/i,
        /problem solver/i
    ],
    training: [
        /training/i, /module/i, /week\s*\d+/i, /my.*lesson/i, /next.*lesson/i,
        /informativ.*method/i, /the method/i, /training.*progress/i, /my.*progress/i,
        /exercise/i, /practice/i, /real.?deal.*challenge/i, /what.*learn/i,
        /curriculum/i, /this week.*learn/i, /week.*training/i,
        /show.*module/i, /start.*training/i, /continue.*training/i,
        /training.*week/i, /coaching.*module/i, /skill.*develop/i
    ],
    cert_prep: [
        /preparing for the/i, /certification quiz/i, /pass the certification/i,
        /teach me the key concepts/i, /prep.*module/i, /cert.*prep/i,
        /Module \d+:/i
    ],
    prospecting: [
        /prospect/i, /\bpie\b/i, /prospecting/i, /unactioned/i,
        /disposition/i, /territory.*coverage/i, /my.*prospects/i,
        /meeting.*conversion/i, /outreach/i, /cold.*call/i,
        /lead.*follow/i, /assigned.*lead/i, /new.*lead/i
    ]
};

function detectIntents(message) {
    const intents = new Set();
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
        for (const pattern of patterns) {
            if (pattern.test(message)) {
                intents.add(intent);
                break;
            }
        }
    }
    // Default: if no intent detected, include general product + sales process
    if (intents.size === 0) {
        intents.add('products');
        intents.add('sales_process');
    }
    return [...intents];
}

// Map intents to knowledge base categories
const INTENT_TO_CATEGORIES = {
    performance: [],  // Uses rep-performance.json instead
    pipeline_coaching: [],  // Uses rep-performance.json instead
    products: ['products'],
    competitive: ['competitive_intel'],
    objections: ['objection_handling', 'value_selling'],
    compliance: ['compliance'],
    discovery: ['value_selling', 'sales_process'],
    pricing: ['pricing'],
    case_studies: ['case_studies', 'testimonials', 'quotes'],
    testimonials: ['testimonials', 'quotes', 'case_studies'],
    integrations: ['integrations'],
    email: ['value_selling', 'sales_process'],
    sales_process: ['sales_process'],
    informativ_method: ['value_selling', 'objection_handling', 'sales_process'],
    training: ['value_selling', 'sales_process'],
    cert_prep: [],  // Uses curriculum JSON directly — no KB categories needed
    trajectory: [],  // Uses coaching-intelligence.json trajectory data — Phase 2
    prospecting: [],  // Uses coaching-intelligence.json prospecting data — injected from PIE
};

// ──────────────────────────────────────────
// CS MODE SUPPORT — Customer Success Operations
// ──────────────────────────────────────────
const CS_MODES = {
    cs_chat: {
        name: 'CS Chat',
        persona: 'CS Coach — supportive, knowledgeable, action-oriented',
        description: 'General CS assistant for customer success questions and guidance',
        kb_keys: ['product_architecture', 'pricing_tiers', 'health_score_model',
                  'dashboard_navigation', 'disposition_taxonomy', 'engagement_cadence',
                  'retention_framework', 'cs_assignment_model']
    },
    cs_health_check: {
        name: 'Health Check',
        persona: 'Health Monitor — proactive, data-driven, pattern-detecting',
        description: 'Analyze customer health scores and recommend actions',
        kb_keys: ['health_score_model', 'dashboard_navigation', 'retention_framework',
                  'engagement_cadence', 'disposition_taxonomy', 'cs_assignment_model']
    },
    cs_account_review: {
        name: 'Account Review',
        persona: 'Strategic Advisor — analytical, structured, preparation-focused',
        description: 'Build structured QBR/call prep talking points for account reviews',
        kb_keys: ['health_score_model', 'engagement_cadence', 'retention_framework',
                  'cross_sell', 'utilization_playbook', 'competitive_intelligence']
    },
    cs_reprice_scenario: {
        name: 'Reprice Scenario',
        persona: 'CSM Financial Advisor — financial, strategic, margin-focused',
        description: 'Model reprice scenarios and guide pricing conversations',
        kb_keys: ['reprice_playbook', 'pricing_tiers', 'bureau_economics',
                  'cogs_structure', 'health_score_model', 'competitive_intelligence']
    },
    cs_utilization_guidance: {
        name: 'Utilization Guidance',
        persona: 'CSA Adoption Coach — educational, adoption-focused, product-knowledgeable',
        description: 'Diagnose utilization issues and recommend feature adoption',
        kb_keys: ['utilization_playbook', 'product_architecture', 'cross_sell',
                  'csa_onboarding', 'bureau_economics', 'dashboard_navigation']
    },
    cs_disposition_response: {
        name: 'Disposition Response',
        persona: 'Escalation Handler — reactive, structured, process-driven',
        description: 'Guide disposition selection and response actions',
        kb_keys: ['disposition_taxonomy', 'retention_framework', 'escalation_support',
                  'engagement_cadence', 'support_talk_tracks', 'csm_lifecycle']
    }
};

const CS_ROLES = {
    CSM: {
        title: 'Client Success Manager',
        focus: 'Credit-tier customers, margin protection, reprice scenarios, bureau cost optimization',
        language: 'financial — margin %, COGS, ARR, reprice, bureau mix',
        key_metric: 'Portfolio GM% maintained above 27%',
        team: ['Esther Aikey', 'Kelly Felder', 'Open Role'],
        manager: 'Kiristen Sandoval'
    },
    CSA: {
        title: 'Client Success Advisor',
        focus: 'Flat-rate customers, product adoption, utilization, training, renewals',
        language: 'adoption — utilization %, feature engagement, time-to-value, training',
        key_metric: 'Time-to-value <14 days, utilization 60-80%',
        team: ['Chad Manz', 'Chaquowa Bouvier', 'Kedrick Butler', 'Irma Schweitzer', 'Ruby Gomez'],
        manager: 'Kiristen Sandoval'
    }
};

function isCSMode(mode) {
    return mode && mode.startsWith('cs_') && CS_MODES.hasOwnProperty(mode);
}

function buildCSContext(mode, userRole) {
    const modeConfig = CS_MODES[mode];
    if (!modeConfig) return '';
    const roleConfig = CS_ROLES[userRole?.toUpperCase()] || null;
    const roleName = roleConfig ? roleConfig.title : 'CS Team Member';

    // Build context from CS KB — reads from categories.{key}.chunks[] structure
    let kbContext = '';
    if (csKnowledgeBase && csKnowledgeBase.categories) {
        for (const key of modeConfig.kb_keys) {
            const category = csKnowledgeBase.categories[key];
            if (category && category.chunks) {
                // Filter chunks by role if specified (csm, csa, or both)
                const roleFilter = userRole ? userRole.toLowerCase() : null;
                const relevantChunks = category.chunks.filter(c =>
                    !c.role || c.role === 'both' || c.role === roleFilter
                );
                for (const chunk of relevantChunks) {
                    const chunkStr = `\n### ${chunk.title || key}\n${chunk.content}\n`;
                    if (kbContext.length + chunkStr.length < 40000) {
                        kbContext += chunkStr;
                    }
                }
            }
        }
    }

    return `
## ACTIVE CS MODE: ${modeConfig.name}
Persona: ${modeConfig.persona}
Purpose: ${modeConfig.description}

## USER ROLE: ${roleName} (${userRole || 'unspecified'})
Focus: ${roleConfig ? roleConfig.focus : 'General customer success'}
Language: ${roleConfig ? roleConfig.language : 'general CS'}
Key metric: ${roleConfig ? roleConfig.key_metric : 'customer health and retention'}
Manager: ${roleConfig ? roleConfig.manager : 'Kiristen Sandoval'}

## CS KNOWLEDGE BASE CONTEXT
${kbContext}
`.trim();
}

function getCSSystemPrompt(mode, userRole) {
    const roleConfig = CS_ROLES[userRole?.toUpperCase()] || null;
    const roleName = roleConfig ? roleConfig.title : 'CS Team Member';

    return `You are Chuck, Informativ's AI assistant, operating in **Customer Success mode**. You support Informativ's CS team — Client Success Managers (CSMs) and Client Success Advisors (CSAs) — with data-driven guidance on customer health, margin management, bureau optimization, and retention.

## About Informativ
Informativ is a SaaS company serving automotive dealerships with credit, compliance, fraud prevention, and desking solutions. The product suite includes:
- **Total Solution** — bundled credit + compliance + enrichment platform
- **SmartPencil** — intelligent desking tool for F&I managers
- **Informativ Customer Insights** (formerly CreditDriver) — consumer-facing credit prequalification
- **Informativ Credit** (formerly CBC) — dealer credit pulls
- **Informativ Compliance** (formerly DSGSS) — compliance and document management
- **Verified STIPs – powered by TurboPass** — income/employment/banking verification
- **Informativ Payments** (formerly Carmatic) — integrated payment processing

## Tiered Packages
- **Protect** — credit-only baseline
- **Enrich** — credit + compliance
- **Elevate** — credit + compliance + enrichment
- **Control** — full suite including SmartPencil

## CI Dashboard Revenue Tiers
- **Tier I** — ≥$100K ARR (white-glove, named CSM)
- **Tier II** — $20K-$99K ARR (proactive quarterly reviews)
- **Tier III** — <$20K ARR (tech-touch, automated health alerts)

## Health Score Model
5 weighted dimensions: Revenue Trend (0.25), Margin Health (0.25), Utilization (0.20), Engagement (0.15), Bureau Efficiency (0.15).
Thresholds: Green ≥75, Amber 50-74, Red <50. Velocity matters: a green score trending down is an amber situation.

## Your CS Personality
- **Data-driven and precise** — reference specific metrics, not vague advice
- **Role-aware** — CSMs get financial language, CSAs get adoption language
- **Action-oriented** — every response ends with concrete next steps
- **Process-compliant** — always reference CI Dashboard, dispositions, and escalation paths
- **Supportive but direct** — flag risks honestly, celebrate wins genuinely
- **Never salesy** — use CS language: "aligning" not "closing," "recommendation" not "pitch"

## CS Guardrails (ALWAYS ACTIVE)
1. Never advise on contract termination — route to retention workflow + CS Manager
2. Escalate negative margin (>10% below target) to CS Manager (Kiristen Sandoval)
3. Defer tier migration decisions to CS Manager
4. Never disclose specific bureau cost rates to customers (internal confidential)
5. Never commit to pricing on the spot — review with CS Manager first
6. Always recommend documenting actions in CI Dashboard
7. Use CS language, not sales language

## CS Escalation Path
CSA/CSM → CS Manager (Kiristen Sandoval) → Director of Client Operations (Kimberly Lang) → CRO (Michael Byrd)

Escalation triggers:
- Tier I account with health/pricing/retention issues → CS Manager
- Negative margin account → CS Manager + CRO notification
- Customer threatening cancellation → CS Manager immediately
- Health score drop >15 points in single month → CS Manager
- NPS detractor → immediate outreach within 24 hours

You are currently helping: **${roleName}** (${userRole || 'CS Team Member'})`;
}

// ──────────────────────────────────────────
// DEV MODE SUPPORT — Development Team Assistant
// Purely additive. Does not modify CS or Sales branches.
// Dev modes reuse the Sales knowledge base (buildContext) for product,
// compliance, dealer-workflow, and testimonial context, but swap the
// system prompt so Chuck answers as a Dev-team assistant — voice-of-
// customer lens, product context for engineers, no sales-coach persona.
// ──────────────────────────────────────────
const DEV_MODES = {
    dev_general: {
        name: 'General Dev Chat',
        focus: 'Broad product, customer, and business context to help engineers understand Informativ products and the "why" behind features.'
    },
    dev_customer_voice: {
        name: 'Voice of Customer',
        focus: 'Explain what dealers value and struggle with, and how product decisions affect real customer outcomes. Cite dealer scenarios and testimonials where relevant.'
    },
    dev_product_deep: {
        name: 'Product Deep Dive',
        focus: 'Deep, accurate product detail — tiers, features, integrations, and actual product behavior — aimed at a software engineer, not a sales rep.'
    },
    dev_compliance: {
        name: 'Compliance Context',
        focus: 'FCRA, FTC Safeguards, adverse action, identity/fraud rules — explain the regulatory "why" so engineers build the right controls.'
    },
    dev_dealer_workflow: {
        name: 'Dealer Workflows',
        focus: 'Concrete dealership workflows — who does what, in what order, and where Informativ products sit in the deal.'
    }
};

function isDevMode(mode) {
    return mode && typeof mode === 'string' && mode.startsWith('dev_') && DEV_MODES.hasOwnProperty(mode);
}

function getDevSystemPrompt(mode) {
    const modeConfig = DEV_MODES[mode] || DEV_MODES.dev_general;
    return `You are Chuck, Informativ's AI assistant, operating in **Development Team mode**. You support Informativ's software engineering team — not sales reps, not CSMs/CSAs. Your job is to give engineers the product, customer, compliance, and dealer-workflow context they need to build the right thing.

## STRICT PERSONA RULES
- You are the **Dev team assistant**, not a sales coach and not a CS coach.
- Do NOT introduce yourself as a sales coach. Never say "I'm Chuck, your Informativ sales coach" or anything similar.
- Do NOT use sales-coaching language: no "close the deal," no "next steps to move the deal forward," no quota/pipeline talk, no sports metaphors, no "teach, tailor, take control," no Informativ Method coaching framework.
- Do NOT coach a rep — the user is a developer, not selling anything.
- DO keep and use all Informativ product, customer, compliance, and dealer-workflow knowledge from your context. Drop only the coach persona.

## ACTIVE DEV FOCUS: ${modeConfig.name}
${modeConfig.focus}

## About Informativ
Informativ is a SaaS company serving automotive dealerships with credit, compliance, fraud prevention, and desking solutions. Product suite:
- **Total Solution** — bundled credit + compliance + enrichment platform
- **SmartPencil** — intelligent desking tool for F&I managers
- **Informativ Customer Insights** (formerly CreditDriver) — consumer-facing credit prequalification
- **Informativ Credit** (formerly CBC / Credit Bureau Connection) — dealer credit pulls
- **Informativ Compliance** (formerly DSGSS / Dealer Safeguard Solutions) — compliance and document management
- **Verified STIPs – powered by TurboPass** — income/employment/banking verification
- **Informativ Payments** (formerly Carmatic) — integrated payment processing
- **eZ Form Fill** — website credit application automation

## Product Naming Convention (critical)
Always use current product names. Translate legacy names automatically:
- DSGSS / Dealer Safeguard Solutions → **Informativ Compliance**
- CBC / Credit Bureau Connection → **Informativ Credit**
- CreditDriver / Credit Driver → **Informativ Customer Insights**
- TurboPass → **Verified STIPs – powered by TurboPass**
- Carmatic → **Informativ Payments**

## Tiered Packages
- **Protect** — credit-only baseline
- **Enrich** — credit + compliance
- **Elevate** — credit + compliance + enrichment
- **Control** — full suite including SmartPencil

## Your Style
- Concrete and specific. Cite products, tiers, dealer scenarios, and compliance rules when relevant.
- Short, scannable, technical where useful. Use bullet points and bold only where they help a developer skim.
- When a question overlaps with customer pain points, answer through a voice-of-customer lens: what dealers actually experience, not what a sales rep would pitch.
- When a question is technical/product behavior, be precise about how the product actually works — tiers, fields, flows, integrations.
- When a question is compliance-adjacent, explain the regulatory driver (FCRA, FTC Safeguards Rule, adverse action, etc.) so the engineer understands the "why."
- You may reference Informativ customer testimonials and case studies when they genuinely illustrate a customer problem or workflow. Markdown links only, never bare URLs. Don't force testimonials into unrelated answers.

You are currently helping: **a developer on the Informativ engineering team**.`;
}

// ──────────────────────────────────────────
// CONTEXT BUILDING
// ──────────────────────────────────────────
function buildContext(intents, repName, message) {
    let context = '';
    let charsUsed = 0;

    // ── CERT PREP MODE: Skip performance data, inject curriculum content ──
    const isCertPrep = intents.includes('cert_prep');
    if (isCertPrep) {
        // Extract module number from the message
        const modMatch = message && message.match(/Module\s+(\d+)/i);
        const modNum = modMatch ? parseInt(modMatch[1]) : null;

        // Detect which certification program from the message
        const msgLower = (message || '').toLowerCase();
        let matched = false;

        // Try to match a product certification file first
        for (const [key, filename] of Object.entries(CERT_FILE_MAP)) {
            if (msgLower.includes(key)) {
                const certData = certificationFiles[filename];
                if (certData && certData.modules && modNum) {
                    const mod = certData.modules.find(m => m.module === modNum);
                    if (mod) {
                        const concepts = Array.isArray(mod.key_concepts)
                            ? mod.key_concepts.join(', ')
                            : (mod.description || '');
                        const certSection = `\n## CERTIFICATION PREP — ${certData.metadata.program_name} — Module ${modNum}: ${mod.title}\n` +
                            `Description: ${mod.description || ''}\n` +
                            `Key Concepts: ${concepts}\n\n` +
                            `**Teach these concepts thoroughly.** Use concrete Informativ examples. The rep needs to understand these well enough to pass an 80% quiz.\n`;
                        context += certSection;
                        charsUsed += certSection.length;
                        matched = true;
                    }
                }
                break;
            }
        }

        // Fallback: Informativ Method curriculum (has richer lesson_content)
        if (!matched && methodCurriculum && methodCurriculum.weeks && modNum) {
            const weekData = methodCurriculum.weeks.find(w => w.week === modNum);
            if (weekData) {
                const certSection = `\n## CERTIFICATION PREP — Module ${modNum}: ${weekData.title}\n` +
                    `Theme: ${weekData.theme}\n` +
                    `Key Concepts: ${weekData.key_concepts.join(', ')}\n\n` +
                    `**Lesson Content (teach this material):**\n${weekData.lesson_content}\n\n` +
                    `**Practice Exercise:**\n${weekData.practice_exercise}\n\n` +
                    `**Coaching Questions:**\n${weekData.coaching_questions.map(q => '- ' + q).join('\n')}\n`;
                context += certSection;
                charsUsed += certSection.length;
                matched = true;
            }
        }

        // Return early — cert prep should NOT include performance data
        return context;
    }

    // Add rep performance data if relevant
    const needsRepData = intents.some(i => ['performance', 'pipeline_coaching', 'trajectory'].includes(i));
    if (repName && repPerformance && repPerformance.reps && repPerformance.reps[repName]) {
        const rep = repPerformance.reps[repName];

        if (rep.role === 'manager') {
            // ── MANAGER CONTEXT: Team-level data ──
            const tp = rep.team_performance || {};
            const drs = rep.direct_reports || [];
            let perfSection = `\n## ${repName}'s Team Performance (Manager View)\n` +
                `Team: ${rep.team} | Reports to: ${rep.manager}\n` +
                `Direct Reports: ${drs.join(', ')}\n` +
                `Team Closed Won YTD: $${tp.team_closed_won_ytd?.toLocaleString() || '0'}\n` +
                `Team Closed Won MTD: $${tp.team_closed_won_mtd?.toLocaleString() || '0'}\n` +
                `Team Q1 Quota: $${tp.team_q1_quota?.toLocaleString() || '0'}\n` +
                `Team Q1 Attainment: ${tp.team_attainment_pct || 0}%\n` +
                `Team Pipeline Value: $${tp.team_pipeline_value?.toLocaleString() || '0'}\n` +
                `Team Pipeline Opps: ${tp.team_pipeline_opps || 0}\n` +
                `Team Weighted Coverage: ${tp.team_weighted_coverage || 0}x\n` +
                `Team Meetings: ${tp.team_funnel_meetings || 0}\n`;

            // Add per-rep summaries
            if (rep.team_rep_summaries && rep.team_rep_summaries.length > 0) {
                perfSection += `\n### Direct Report Performance:\n`;
                for (const dr of rep.team_rep_summaries) {
                    perfSection += `  - ${dr.name}: Composite ${dr.composite_score || '?'}, ${dr.archetype || '?'}, ${dr.attainment_pct || 0}% att., $${(dr.cw_ytd || 0).toLocaleString()} CW YTD`;
                    if (dr.top_flag) perfSection += ` [${dr.top_flag}]`;
                    perfSection += `\n`;
                }
            }

            // Add team stuck deals
            if (rep.team_stuck_deals && rep.team_stuck_deals.length > 0) {
                perfSection += `\nTop Team Stuck Deals:\n`;
                for (const d of rep.team_stuck_deals.slice(0, 5)) {
                    perfSection += `  - ${d.account} (${d.rep || '—'}): ${d.stage} | $${(d.amount || 0).toLocaleString()} | ${d.age_days || d.age || '?'}d old`;
                    if (d.hygiene_flag) perfSection += ` | ${d.hygiene_flag}`;
                    perfSection += `\n`;
                }
            }

            // Also include personal deal note
            if (rep.performance?.closed_won_ytd > 0) {
                perfSection += `\nPersonal Deals (outliers, hidden from leaderboard): $${rep.performance.closed_won_ytd.toLocaleString()} CW YTD\n`;
            }

            context += perfSection;
            charsUsed += perfSection.length;

            // Also add individual rep data for each direct report (brief)
            for (const drName of drs) {
                const drRep = repPerformance.reps[drName];
                if (!drRep || charsUsed >= MAX_CONTEXT_CHARS) break;
                const drSection = `\n### ${drName} Detail:\n` +
                    `CW YTD: $${drRep.performance?.closed_won_ytd?.toLocaleString() || '0'} | ` +
                    `Pipeline: $${drRep.performance?.pipeline_value?.toLocaleString() || '0'} | ` +
                    `Deals: ${drRep.performance?.deal_count || 0} | ` +
                    `Hygiene: ${drRep.hygiene?.score || '?'}/100 | ` +
                    `Top Issue: ${drRep.hygiene?.topIssue || 'None'}\n`;
                context += drSection;
                charsUsed += drSection.length;
            }
        } else {
            // ── REP CONTEXT (original) ──
            const perfSection = `\n## ${repName}'s Current Performance\n` +
                `Team: ${rep.team} | Manager: ${rep.manager}\n` +
                `Annual Quota: $${rep.quota?.annual?.toLocaleString() || 'N/A'}\n` +
                `Q1 Quota: $${rep.quota?.q1?.toLocaleString() || 'N/A'}\n` +
                `March Quota: $${rep.quota?.march?.toLocaleString() || 'N/A'}\n` +
                `Closed Won YTD: $${rep.performance?.closed_won_ytd?.toLocaleString() || '0'}\n` +
                `Closed Won MTD: $${rep.performance?.closed_won_mtd?.toLocaleString() || '0'}\n` +
                `Q1 Attainment: ${rep.performance?.ytd_attainment_pct || 0}%\n` +
                `Pipeline Value: $${rep.performance?.pipeline_value?.toLocaleString() || '0'}\n` +
                `Deal Count: ${rep.performance?.deal_count || 0}\n` +
                `Avg Deal Size: $${rep.performance?.avg_deal_size?.toLocaleString() || '0'}\n` +
                `SF Meetings YTD: ${rep.activity?.sf_meetings || 0}\n` +
                `Tech Demos YTD: ${rep.activity?.tech_demos || 0}\n` +
                `Hygiene Score: ${rep.hygiene?.score || 'N/A'}/100\n` +
                `Flagged Deals: ${rep.hygiene?.flagged || 0} of ${rep.hygiene?.totalDeals || 0}\n` +
                `Top Issue: ${rep.hygiene?.topIssue || 'None'}\n`;

            if (rep.flagged_deals && rep.flagged_deals.length > 0) {
                const dealsStr = rep.flagged_deals.map(d =>
                    `  - ${d.account}: ${d.stage} | $${d.amount?.toLocaleString()} | ${d.age}d old | ${d.issues}`
                ).join('\n');
                context += perfSection + `\nTop Flagged Deals:\n${dealsStr}\n`;
            } else {
                context += perfSection;
            }
            charsUsed += context.length;
        }
    }

    // ── Phase 2: Add trajectory prediction context ──
    if (repName && coachingIntelligence && coachingIntelligence.reps) {
        const ciRep = coachingIntelligence.reps[repName];
        if (ciRep && ciRep.trajectory) {
            const t = ciRep.trajectory;
            let trajSection = `\n## Quota Trajectory Prediction (ML Model — Phase 2)\n` +
                `Probability of hitting Q1 quota: ${Math.round(t.quota_hit_probability * 100)}%\n` +
                `Risk Level: ${t.risk_level?.toUpperCase()}\n` +
                `Trajectory: ${t.trajectory_direction}\n` +
                `Projected Attainment: ${t.projected_attainment_pct}%\n` +
                `Model Confidence: ${Math.round((t.confidence || 0) * 100)}%\n` +
                `Monthly Trajectory: M1=${Math.round((t.month_1_prob || 0) * 100)}% → M2=${Math.round((t.month_2_prob || 0) * 100)}% → M3=${Math.round((t.month_3_prob || 0) * 100)}%\n` +
                `Intervention Urgency: ${t.intervention_urgency}\n`;
            if (t.key_drivers && t.key_drivers.length > 0) {
                trajSection += `Key Factors:\n`;
                for (const d of t.key_drivers) {
                    trajSection += `  - ${d.factor} (${d.impact}): ${d.detail}\n`;
                }
            }
            trajSection += `\nIMPORTANT: When coaching, reference the trajectory prediction naturally. ` +
                `If risk is HIGH or urgency is URGENT, lead with the trajectory concern. ` +
                `If trajectory is declining, address the momentum shift. ` +
                `If improving, reinforce the positive trend and identify what to sustain.\n`;
            context += trajSection;
            charsUsed += trajSection.length;
        }
        // For managers: add team trajectory summary
        if (ciRep && ciRep.team_trajectory) {
            const tt = ciRep.team_trajectory;
            let teamTrajSection = `\n## Team Trajectory Summary (ML Prediction)\n` +
                `Avg Quota Hit Probability: ${Math.round(tt.avg_quota_hit_probability * 100)}%\n` +
                `Reps at Risk: ${tt.reps_at_risk} (${(tt.at_risk_names || []).join(', ')})\n` +
                `Reps on Track: ${tt.reps_on_track}\n` +
                `Team Risk Level: ${tt.team_risk_level?.toUpperCase()}\n` +
                `\nWhen coaching managers, highlight at-risk reps and recommend proactive intervention ` +
                `before end of quarter. Trajectory data should inform 1:1 prep priorities.\n`;
            context += teamTrajSection;
            charsUsed += teamTrajSection.length;
        }
    }

    // ── Prospecting Effectiveness context ──
    if (repName && coachingIntelligence && coachingIntelligence.reps) {
        const ciRep = coachingIntelligence.reps[repName];
        if (ciRep && ciRep.prospecting) {
            const p = ciRep.prospecting;
            const dims = p.dimensions || {};
            let prospSection = `\n## Prospecting Effectiveness (PIE Dashboard)\n` +
                `Prospecting Score: ${p.composite}/100 (${p.level})\n` +
                `Team Average: ${p.teamAvg}\n` +
                `Prospects Assigned: ${p.prospectsAssigned} | Actioned: ${p.prospectsActioned} | Unactioned: ${p.prospectsAssigned - p.prospectsActioned}\n` +
                `Meetings Set: ${p.meetingsSet || 0} | Opportunities Created: ${p.opportunitiesCreated || 0}\n`;
            if (dims) {
                prospSection += `Score Dimensions:\n`;
                const dimNames = {
                    dispositionRate: 'Disposition Rate (25%)',
                    meetingConversion: 'Meeting Conversion (25%)',
                    responseVelocity: 'Response Velocity (20%)',
                    dataCompleteness: 'Data Completeness (15%)',
                    pipelineProgression: 'Pipeline Progression (15%)'
                };
                for (const [key, label] of Object.entries(dimNames)) {
                    if (dims[key]) {
                        prospSection += `  - ${label}: ${dims[key].score || 0}/100\n`;
                    }
                }
            }
            // Find weakest dimension for coaching focus
            let weakestKey = null;
            let weakestScore = 101;
            for (const [key, data] of Object.entries(dims)) {
                if (data && typeof data.score === 'number' && data.score < weakestScore) {
                    weakestScore = data.score;
                    weakestKey = key;
                }
            }
            if (weakestKey && weakestScore < 60) {
                const recommendations = {
                    dispositionRate: 'Focus on working through unactioned prospects daily. Block 30 min for PIE prospect outreach.',
                    meetingConversion: 'Outreach messaging may need refinement. Lead with pain points, not product features.',
                    responseVelocity: 'Speed to first touch matters. Check PIE assignments at 9 AM and 2 PM daily.',
                    dataCompleteness: 'Enrich prospect records before outreach — missing data lowers response rates.',
                    pipelineProgression: 'Convert warm prospects to Salesforce opportunities earlier. Create opps at first meeting confirmation.'
                };
                prospSection += `\nWeakest Area: ${weakestKey} (${weakestScore}/100)\n`;
                prospSection += `Coaching Recommendation: ${recommendations[weakestKey] || 'Address weakest prospecting dimension.'}\n`;
            }
            if (p.dataStatus === 'baseline_estimates') {
                prospSection += `\nNote: Prospecting scores are baseline estimates. Data refines as disposition volume grows.\n`;
            }
            prospSection += `\nWhen coaching on prospecting, reference PIE data naturally. ` +
                `If unactioned prospects are high (>20), flag that as an immediate action item. ` +
                `If meeting conversion is low, coach on outreach quality. ` +
                `If disposition rate is low, coach on daily prospecting habits.\n`;
            context += prospSection;
            charsUsed += prospSection.length;
        }
    }

    // ── SFDC Activity Truth context (Phase 2C, April 27 2026) ──
    // Pulls activity (Tasks/Events) + pipeline movement (stage edits) + pattern
    // classification from coaching-intelligence.json. Drives Chuck's coaching tone:
    // - movement_driven (Tami pattern) → probe deal quality, NOT activity volume
    // - task_driven (Ward pattern)     → examine call/email conversion
    // - stalled                        → diagnose blockers (curiosity over pressure)
    // - low_engagement                 → triage stalest deals together
    // - balanced                       → reinforce + identify next stretch goal
    if (repName && coachingIntelligence && coachingIntelligence.reps) {
        const ciRep = coachingIntelligence.reps[repName];
        if (ciRep && ciRep.sfdc_truth) {
            const sf = ciRep.sfdc_truth;
            let sfdcSection = `\n## SFDC Activity Truth (Live from Salesforce)\n` +
                `Workflow Pattern: ${(sf.pattern || 'unknown').toUpperCase()}\n` +
                `Pipeline Hygiene: ${(sf.hygiene_flag || 'na').toUpperCase()}\n` +
                `Activity (90d): ${sf.activity_90d?.tasks || 0} Tasks, ${sf.activity_90d?.events || 0} Calendar Events\n` +
                `Pipeline Movement (90d): ${sf.pipeline_movement_90d || 0} stage/amount edits\n` +
                `Pipeline Movement (30d): ${sf.pipeline_movement_30d || 0} stage/amount edits\n` +
                `Open Opps: ${sf.pipeline?.open_opps || 0} ($${Math.round((sf.pipeline?.open_amount || 0)/1000)}K total)\n` +
                `Stale Opps: ${sf.pipeline?.stale_count || 0} (no Tasks/Events AND no movement in 30+ days)\n` +
                `Engagement: ${sf.pipeline?.engagement_pct || 0}% of opps active in last 7 days\n`;
            if (sf.pattern_focus) {
                sfdcSection += `\nCoaching Focus (pattern-based): ${sf.pattern_focus}\n`;
            }
            if (sf.top_stale_opps && sf.top_stale_opps.length > 0) {
                sfdcSection += `\nTop Stale Opps to Triage:\n`;
                for (const o of sf.top_stale_opps.slice(0, 5)) {
                    sfdcSection += `  - ${o.account} | ${o.stage} | $${Math.round((o.amount || 0)/1000)}K | last activity: ${o.days_since_activity != null ? o.days_since_activity + 'd ago' : 'never'}\n`;
                }
            }
            sfdcSection += `\nIMPORTANT — Pattern-aware coaching:\n` +
                `- If pattern is MOVEMENT_DRIVEN (e.g., Tami): the rep advances opps via stage edits, not Tasks. ` +
                `Don't push for "more activity logging" — instead probe deal quality, qualification rigor, ` +
                `and why specific opps haven't moved despite frequent edits.\n` +
                `- If pattern is TASK_DRIVEN: high call volume, lower stage progression. Examine call ` +
                `conversion — is the rep talking to the right buyer? Are calls advancing deals?\n` +
                `- If pattern is STALLED: both signals near zero. Lead with curiosity, not pressure. ` +
                `Likely confidence, territory, or personal blocker.\n` +
                `- If pattern is LOW_ENGAGEMENT: pipeline is being neglected. Triage the top 5 stalest ` +
                `deals together; commit to specific re-engagement actions.\n` +
                `- If hygiene is CRITICAL or WARNING: surface stale opps proactively even if rep doesn't ask.\n`;
            context += sfdcSection;
            charsUsed += sfdcSection.length;
        }
    }

    // Add knowledge base sections based on intents
    if (knowledgeBase && knowledgeBase.categories) {
        const categoriesToLoad = new Set();
        for (const intent of intents) {
            const cats = INTENT_TO_CATEGORIES[intent] || [];
            cats.forEach(c => categoriesToLoad.add(c));
        }

        for (const catKey of categoriesToLoad) {
            const cat = knowledgeBase.categories[catKey];
            if (!cat || !cat.chunks) continue;

            const sectionHeader = `\n## ${cat.label}\n${cat.description}\n\n`;
            charsUsed += sectionHeader.length;

            if (charsUsed >= MAX_CONTEXT_CHARS) break;

            context += sectionHeader;

            // For testimonials/quotes: filter chunks by topic keywords in user message
            let chunksToLoad = cat.chunks;
            if ((catKey === 'testimonials' || catKey === 'quotes') && message) {
                const msgLower = message.toLowerCase();
                const topicFilters = {
                    fraud: ['fraud', 'synthetic', 'identity', 'fake', 'stolen', 'id scan'],
                    compliance: ['compliance', 'guardrail', 'fcra', 'ftc', 'safeguard', 'audit', 'regulation'],
                    customer_experience: ['customer experience', 'customer trust', 'confidence', 'transparency', 'buying process', 'friction'],
                    cost_roi: ['cost saving', 'roi', 'save money', 'credit cost', 'peace of mind', 'expense'],
                    soft_pull: ['soft pull', 'prequalif', 'pre-desk', 'pre desk', 'credit driver', 'customer insight', 'qr code'],
                    adoption: ['adoption', 'ease of use', 'easy to use', 'user-friendly', 'sales team love', 'buy-in'],
                    enterprise: ['multi-location', 'enterprise', 'large dealer group', 'multiple dealership', 'multi-store', '34 dealership', '17 dealership']
                };
                // Detect which topic the user is asking about
                let matchedKeywords = [];
                for (const [topic, keywords] of Object.entries(topicFilters)) {
                    for (const kw of keywords) {
                        if (msgLower.includes(kw)) {
                            matchedKeywords.push(...keywords);
                            break;
                        }
                    }
                }
                if (matchedKeywords.length > 0) {
                    // Score chunks by how many topic keywords they contain
                    const scored = cat.chunks.map(chunk => {
                        const contentLower = chunk.content.toLowerCase();
                        let score = 0;
                        for (const kw of matchedKeywords) {
                            if (contentLower.includes(kw)) score++;
                        }
                        return { chunk, score };
                    }).filter(s => s.score > 0)
                      .sort((a, b) => b.score - a.score);

                    // Deduplicate by company — pick best-scoring chunk per company
                    const seenCompanies = new Set();
                    const diverseChunks = [];
                    for (const s of scored) {
                        const companyMatch = s.chunk.content.match(/Company:\s*(.+)/i);
                        const company = companyMatch ? companyMatch[1].trim().toLowerCase().replace(/\s+/g, ' ') : '';
                        const companyKey = company.split(',')[0].trim(); // Normalize
                        if (!seenCompanies.has(companyKey)) {
                            seenCompanies.add(companyKey);
                            diverseChunks.push(s.chunk);
                        }
                        if (diverseChunks.length >= 6) break; // Cap at 6 diverse testimonials
                    }
                    if (diverseChunks.length > 0) {
                        chunksToLoad = diverseChunks;
                    }
                }
            }

            // Add chunks up to budget
            for (const chunk of chunksToLoad) {
                if (charsUsed + chunk.content.length > MAX_CONTEXT_CHARS) break;
                context += `[Source: ${chunk.source}]\n${chunk.content}\n\n`;
                charsUsed += chunk.content.length + chunk.source.length + 20;
            }
        }
    }

    // Add training context if training intent detected or rep is enrolled
    const needsTraining = intents.includes('training') || intents.includes('informativ_method');
    if (repName && needsTraining && trainingProgress && trainingProgress.reps && trainingProgress.reps[repName]) {
        const repTraining = trainingProgress.reps[repName];
        const currentWeek = repTraining.current_week || 1;
        const weeksCompleted = repTraining.weeks_completed || 0;
        const progressPct = repTraining.overall_progress_pct || 0;

        let trainingSection = `\n## ${repName}'s Informativ Method Training Progress\n` +
            `Program: 12-Week Informativ Method\n` +
            `Current Week: ${currentWeek} of 12\n` +
            `Weeks Completed: ${weeksCompleted}\n` +
            `Overall Progress: ${progressPct}%\n` +
            `Status: ${repTraining.completion_status || 'enrolled'}\n`;

        // Inject current week's curriculum content
        if (methodCurriculum && methodCurriculum.weeks) {
            const weekData = methodCurriculum.weeks.find(w => w.week === currentWeek);
            if (weekData) {
                trainingSection += `\n### This Week's Module: Week ${currentWeek} — ${weekData.title}\n` +
                    `Theme: ${weekData.theme}\n` +
                    `Key Concepts: ${weekData.key_concepts.join(', ')}\n\n` +
                    `**Lesson:**\n${weekData.lesson_content}\n\n` +
                    `**Practice Exercise:**\n${weekData.practice_exercise}\n\n` +
                    `**Real-Deal Challenge:**\n${weekData.real_deal_challenge}\n\n` +
                    `**Coaching Questions to Ask:**\n${weekData.coaching_questions.map(q => '- ' + q).join('\n')}\n`;
            }
        }

        // Check week completion status
        const weekKey = `week_${currentWeek}`;
        const weekProgress = repTraining.progress_by_week?.[weekKey];
        if (weekProgress) {
            trainingSection += `\nWeek ${currentWeek} Status:\n` +
                `  Module Viewed: ${weekProgress.module_viewed ? 'Yes' : 'Not yet'}\n` +
                `  Exercise Completed: ${weekProgress.exercise_completed ? 'Yes' : 'Not yet'}\n` +
                `  Real-Deal Challenge Applied: ${weekProgress.real_deal_challenge_applied ? 'Yes' : 'Not yet'}\n`;
        }

        if (charsUsed + trainingSection.length <= MAX_CONTEXT_CHARS) {
            context += trainingSection;
            charsUsed += trainingSection.length;
        }
    }

    // Add manager training content OR team context based on manager mode
    const isManagerProfile = repName && repPerformance && repPerformance.reps &&
        repPerformance.reps[repName] && repPerformance.reps[repName].role === 'manager';
    if (isManagerProfile && needsTraining) {
        // Inject manager-specific curriculum content (coaching overlay)
        const managerEnrolled = trainingProgress && trainingProgress.reps &&
            trainingProgress.reps[repName] && trainingProgress.reps[repName].manager_track_enrolled;
        if (managerEnrolled && managerCurriculum && managerCurriculum.weeks) {
            const repTraining = trainingProgress.reps[repName];
            const currentWeek = repTraining.current_week || 1;
            const weekData = managerCurriculum.weeks.find(w => w.week === currentWeek);
            if (weekData) {
                const co = weekData.coaching_overlay || {};
                let mgrSection = `\n## Manager Training — Week ${currentWeek}: ${weekData.title}\n` +
                    `Theme: ${weekData.theme}\n` +
                    `Key Concepts: ${weekData.key_concepts.join(', ')}\n\n` +
                    `**Lesson (same content your reps are learning):**\n${weekData.lesson_content}\n\n` +
                    `**COACHING OVERLAY — What Makes This Week Different for Managers:**\n` +
                    `**Week Objective:** ${co.week_objective || ''}\n\n` +
                    `**What to Listen For on Rep Calls:**\n${(co.what_to_listen_for || []).map(x => '- ' + x).join('\n')}\n\n` +
                    `**1:1 Coaching Guide:**\n${co.one_on_one_guide || ''}\n\n` +
                    `**Common Mistakes to Correct:**\n${(co.common_mistakes || []).map(x => '- ' + x).join('\n')}\n\n` +
                    `**Field Observation Guide:**\n${co.field_observation || ''}\n\n` +
                    `**Practice Exercise:**\n${weekData.practice_exercise || ''}\n\n` +
                    `**Coaching Questions:**\n${(weekData.coaching_questions || []).map(q => '- ' + q).join('\n')}\n`;

                if (charsUsed + mgrSection.length <= MAX_CONTEXT_CHARS) {
                    context += mgrSection;
                    charsUsed += mgrSection.length;
                }
            }
        }

        // Also show team training progress
        if (trainingProgress && trainingProgress.reps) {
            let teamSection = `\n## Team Training Progress (Manager View)\n`;
            const managerName = repName;
            for (const [rName, rData] of Object.entries(trainingProgress.reps)) {
                if (!rData.enrolled) continue;
                const repInfo = repPerformance.reps[rName];
                if (repInfo && (repInfo.manager === managerName || managerName === 'Michael Byrd')) {
                    teamSection += `- ${rName}: Week ${rData.current_week || 1}, ${rData.weeks_completed || 0}/12 completed (${rData.overall_progress_pct || 0}%)\n`;
                }
            }
            if (charsUsed + teamSection.length <= MAX_CONTEXT_CHARS) {
                context += teamSection;
                charsUsed += teamSection.length;
            }
        }
    }

    return context;
}

// ──────────────────────────────────────────
// SYSTEM PROMPT
// ──────────────────────────────────────────
function getSystemPrompt(repName) {
    // Check if this is a manager profile
    const managerMode = repName && repPerformance && repPerformance.reps &&
        repPerformance.reps[repName] && repPerformance.reps[repName].role === 'manager';

    return `You are Chuck, Informativ's friendly and knowledgeable sales coach. You help Informativ's sales reps close more deals, understand products, handle objections, navigate competitive situations, and improve their performance.

## About Informativ
Informativ is a SaaS company serving automotive dealerships with credit, compliance, fraud prevention, and desking solutions. The product suite includes:
- **Total Solution** — bundled credit + compliance + enrichment platform
- **SmartPencil** — intelligent desking tool for F&I managers
- **Informativ Customer Insights** (formerly CreditDriver) — consumer-facing credit prequalification
- **Informativ Credit** (formerly CBC / Credit Bureau Connection) — dealer credit pulls
- **Informativ Compliance** (formerly DSGSS / Dealer Safeguard Solutions) — compliance and document management
- **Verified STIPs – powered by TurboPass** — income/employment/banking verification
- **Informativ Payments** (formerly Carmatic) — integrated payment processing
- **eZ Form Fill** — website credit application automation

## CRITICAL: Product Naming Convention
ALWAYS use the current product names. If the knowledge base or rep mentions legacy names, translate them automatically:
- DSGSS or Dealer Safeguard Solutions → **Informativ Compliance**
- CBC or Credit Bureau Connection → **Informativ Credit**
- CreditDriver or Credit Driver → **Informativ Customer Insights**
- TurboPass → **Verified STIPs – powered by TurboPass**
- Carmatic → **Informativ Payments**
Never use the old names in your responses unless quoting a specific legacy document. Always use the current Informativ-branded names.

## Tiered Packages
- **Protect** — credit-only baseline
- **Enrich** — credit + compliance
- **Elevate** — credit + compliance + enrichment
- **Control** — full suite including SmartPencil

## Testimonials, Quotes & Case Studies
You have access to 34 video testimonials, 22 customer quotes, and 5 detailed case studies from real Informativ customers. When a rep asks for customer proof, social proof, testimonials, quotes, or references to share with a prospect:
1. **Match by topic** — find the testimonial/quote most relevant to the rep's situation (e.g., fraud prevention, compliance guardrails, soft pulls, cost savings, customer experience, sales adoption)
2. **Always use markdown links — NEVER output bare URLs.** Format links as clickable text: [Watch the Video](url) or [Read the Case Study](url). The chat renders markdown so these become clickable buttons.
3. **Include the key quote** — pull the most compelling 1-2 sentences from the transcript
4. **Layer multiple types** — if possible, pair a video testimonial with a short quote and/or a case study for maximum impact
5. **Match dealer profile** — if the rep mentions the prospect is a multi-location group, prioritize Kunes (34 locations), Pohanka, Cavender (17 locations), or Galpin (7 rooftops). For single-point dealers, use Autobahn BMW, Kia Moritz, or Toyota of Cedar Park.

Example response format:
"Great question! Here are some customer references on compliance guardrails you can share:

**Video:** Jimmy Robinson (CFO, Pohanka Auto Group) talks about how Informativ's compliance guardrails bring consistency across their stores. [Watch the Video](https://informativ.com/confident-consistent-sales-with-informativ/)

> *'The consistency comes from having clear expectations, and that makes your dealership run smoother.'*

**Quote:** Anthony Tigano, Chapman Auto Group — *'With Informativ, you can't advance the deal unless you clear compliance checks. Our audit scores have improved dramatically.'* [See All Quotes](https://informativ.com/testimonials/)

**Case Study:** Kunes Auto Group controls credit costs and compliance risks across 34 dealerships with Informativ's Total Solution. [Read the Case Study](https://informativ.com/case-studies/case-study-kunes-auto-group/)"

## Your Personality
- **Knowledgeable and direct** — give specific, actionable advice, not generic platitudes
- **Encouraging but honest** — celebrate wins, but don't sugarcoat problems
- **Action-oriented** — always end with specific next steps the rep should take
- **Revenue-focused** — tie advice back to deal progression, pipeline value, and quota attainment
- **Conversational** — keep responses focused and scannable, use bold for key points
- **Occasional sports metaphors** — but don't overdo it
- **Informativ Method-driven** — coach reps to teach, tailor, and take control in every deal

## The Informativ Method — Sales Coaching Framework
You are trained in The Informativ Method. Apply these principles in ALL coaching interactions:

### The 5 Rep Profiles (Know Who You're Coaching)
- **Insight Leader** — teaches customers new perspectives, tailors messaging, takes control of the sale. This is the winning profile. Coach every rep toward this.
- **Relationship Builder** — focuses on rapport and customer comfort. Common but underperforms in complex sales. Coach them to add teaching and constructive tension.
- **Hard Worker** — high activity, self-motivated, but activity ≠ results without insight-led selling. Coach them to work smarter with commercial insights.
- **Lone Wolf** — independent, instinct-driven. Produces results but doesn't follow process. Coach them to apply structure to their instincts.
- **Problem Solver** — detail-oriented, reliable post-sale. Coach them to lead with insights earlier in the cycle rather than waiting to react.

### Teach, Tailor, Take Control (The Core Framework)
When coaching reps on ANY deal, evaluate whether they are doing all three:

**1. TEACH — Lead with Commercial Insight**
- Don't lead with product features. Lead with an insight the dealer didn't know about their own business.
- Commercial insights reframe how the dealer thinks about a problem — they should think "I never thought about it that way."
- Examples for Informativ:
  - "Most dealers don't realize they're losing $X per month in compliance exposure because they treat it as a checkbox, not a revenue protection strategy."
  - "The average dealer pulls credit 3x per deal. Each unnecessary pull costs you in bureau fees AND customer friction. What if you could cut that to 1.2 pulls?"
  - "Dealers using desking tools without integrated credit data are leaving 12-18% of deals on the table because F&I can't see the full picture at the point of sale."
- Coach reps to develop 2-3 teaching insights they can use in every first meeting.

**2. TAILOR — Customize the Message to the Stakeholder**
- Different stakeholders care about different things. The rep must tailor the insight to the persona:
  - **Dealer Principal / Owner**: Enterprise value, risk exposure, margin protection, competitive positioning
  - **GM / General Manager**: Operational efficiency, deal velocity, staff productivity, P&L impact
  - **F&I Director**: Compliance risk, product penetration, deal profitability, lender relationships
  - **IT / Technology Director**: Integration complexity, data security, vendor consolidation, uptime
  - **Controller / CFO**: Cost reduction, audit readiness, fee transparency, ROI
- Coach reps to ask: "Who else is involved in this decision?" and prepare tailored talk tracks for each stakeholder.

**3. TAKE CONTROL — Drive the Sale with Constructive Tension**
- Don't avoid tension. Use it constructively to move deals forward.
- Taking control means:
  - Setting a clear agenda before every meeting
  - Proactively naming the next step at the end of every call (never "I'll follow up")
  - Pushing back respectfully on vague timelines: "What would need to happen to get this decided by [date]?"
  - Addressing price/discount requests by reframing value: "Let's talk about what you're losing today without this, not what it costs to have it."
  - Asking for the business directly when the moment is right
- Coach reps who are uncomfortable with tension — this is the #1 skill gap in B2B sales.

### The Teaching Pitch Structure
When coaching reps on presentations, demos, or pitch structure, guide them through this 6-step flow:

1. **The Warmer** — Open with something the dealer will agree with. Build credibility. ("Every dealer we talk to is dealing with rising compliance costs and tighter bureau margins...")
2. **The Reframe** — Introduce a perspective they haven't considered. This is the "aha" moment. ("But the real cost isn't the bureau fees — it's the deals you're losing because your current process creates friction at the wrong moment.")
3. **Rational Drowning** — Stack data and evidence that makes the current approach feel untenable. Use metrics, benchmarks, and industry data. ("Dealers averaging 3+ credit pulls per deal see 22% higher fallout in F&I...")
4. **Emotional Impact** — Make it personal. Connect the data to their specific pain. ("That means for a dealership your size, you're looking at roughly $X in lost deal profit annually — just from process friction.")
5. **A New Way** — Present the vision of what's possible WITHOUT naming your product yet. ("What if you could give your F&I team a full credit picture at the point of sale, reduce pulls by 60%, and flag compliance issues before they become audit findings?")
6. **Your Solution** — NOW introduce Informativ as the answer. ("That's exactly what our Total Solution does — and here's how [Dealer X] achieved these results in 90 days.")

### Applying The Informativ Method to Pipeline Coaching
When reviewing pipeline or coaching on stuck deals, always ask:
- "What insight did you teach them that they didn't already know?" (If none → the deal lacks differentiation)
- "Who else in the dealership have you engaged beyond your main contact?" (If only one → the deal is at risk of single-threading)
- "What is the next concrete step with a date attached?" (If vague → the rep isn't taking control)
- "What happens to this dealer if they do nothing?" (If no consequence → there's no urgency and the deal will stall)

### Constructive Tension Coaching
When a rep says a deal is "going well" but it's not progressing:
- Challenge them: "What specific evidence do you have that this deal is moving forward vs. the dealer being polite?"
- Coach them on creating urgency without being pushy — tie it to business impact, not artificial deadlines
- Help them identify the "mobilizer" — the person inside the dealership who will champion the deal internally (this is NOT always the friendliest contact)

## How to Respond
1. **Performance questions**: Reference the rep's actual data. Be specific about numbers. Identify which Informativ Method behaviors could improve their results.
2. **Product questions**: Explain features, benefits, and how to position them. Frame product value as a commercial insight the rep can teach to dealers.
3. **Competitive questions**: Use battle card positioning AND teach the rep to reframe the conversation away from feature comparison toward business insight.
4. **Objection handling**: Give the rep specific Informativ Method language — reframe objections into teaching moments rather than defensive responses.
5. **Email drafting**: Write professional, concise emails that lead with insight, not product features. Follow the Warmer → Reframe → New Way structure. Use Informativ Method language.
6. **Discovery/prep**: Provide persona-specific questions and talk tracks. Coach the rep to prepare a tailored teaching insight for each stakeholder in the room.
7. **Pipeline coaching**: Identify specific deals needing attention. Diagnose whether the gap is in Teaching, Tailoring, or Taking Control.
8. **Informativ Method coaching**: When asked about methodology, selling approach, or how to improve, explicitly reference Informativ Method principles and give the rep a specific behavior to practice.

## Rules
- Keep responses focused and scannable — use bullet points and bold for key info
- When coaching on performance, be specific about what metrics need improvement and by how much
- When handling objections, give exact Informativ Method reframe language the rep can use, not just general advice
- When drafting emails, make them ready to copy-paste with minimal editing, always leading with insight
- Reference real Informativ products, features, and pricing tiers
- When coaching on deals, always evaluate Teach/Tailor/Take Control and identify the gap
- If you don't have enough information to answer, ask a clarifying question
- Don't make up deal data or performance numbers — only reference what's provided
- When a rep is stuck, diagnose their rep profile tendency and coach them toward Insight Leader behaviors

## Certification Prep Mode
When a user asks you to help them prepare for a certification module (e.g., "I'm preparing for the Informativ Method Certification — Module 2..."), you are in **Certification Prep Mode**. This is your HIGHEST priority — override all other coaching instincts.

### Certification Prep Rules (CRITICAL)
1. **TEACH THE MODULE CONTENT ONLY** — Do NOT coach on pipeline, performance, aged deals, or team issues. Focus 100% on the certification material.
2. **Deliver the lesson conversationally** — Teach the key concepts from the curriculum in ~200-300 words. Use concrete Informativ examples. Make it engaging but informative.
3. **One question at a time** — After teaching, ask ONE coaching question to check understanding.
4. **Stay in the conversation** — When they answer, provide genuine feedback, push where they could go deeper, then ask a follow-up or present the practice exercise.
5. **After the teaching conversation** — Offer to quiz them: "Ready to take the certification quiz? Head to the Certs tab and click 'Take Quiz' for this module."
6. **Keep responses under 300 words** — Scannable, not overwhelming.
7. **DO NOT reference the user's pipeline, team performance, deal data, or coaching priorities** — This is a learning session, not a coaching session.
8. **For managers** — Teach the same content. If they want to know how to coach their reps on this topic, they can ask separately. But cert prep = teach the material.

${managerMode ? `
## Manager Mode
You are coaching a MANAGER. When they ask performance, pipeline, or coaching questions (NOT cert prep), provide team-level coaching and help them develop their reps.

### Team Oversight
- **Certification Progress**: When they ask about team progress, reference certification completion data.
- **Coaching the Coach**: Help managers identify which reps need coaching attention based on certification progress AND performance data.
- **Performance Context**: When pipeline data is available, help managers prioritize coaching.
` : ''}

${repName ? `\nThe rep you're coaching is: **${repName}**` : '\nNo rep is currently selected. You can still help with general questions, but for personalized coaching, ask them to select their profile.'}`;
}

// ──────────────────────────────────────────

// ──────────────────────────────────────────
// HANDLER
// ──────────────────────────────────────────
async function _handler(event) {
    // --- Unified API Gateway middleware ---
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');
    const rlCheck = checkRateLimit(event, _cors);
    if (rlCheck) return rlCheck;


    // CORS headers
    const headers = {
        'Content-Type': 'application/json',
        ..._cors
    };

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // Rate limiting

    // Parse request
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { message, repName, history, mode, user_role } = body;

    if (!message || typeof message !== 'string') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message is required' }) };
    }

    // SEC-2026-013: Server-side mode validation — ensure mode is a known value
    const VALID_SALES_MODES = ['coach', 'pricing', 'coaching', 'performance', 'certifications', 'call_prep', 'follow_up', 'discovery_script'];
    const VALID_CS_MODES = Object.keys(CS_MODES); // cs_chat, cs_health_check, etc.
    const VALID_DEV_MODES = Object.keys(DEV_MODES); // dev_general, dev_customer_voice, etc.
    const ALL_VALID_MODES = [...VALID_SALES_MODES, ...VALID_CS_MODES, ...VALID_DEV_MODES];

    if (mode && !ALL_VALID_MODES.includes(mode)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid mode specified' }) };
    }

    // SEC-2026-013: Role-mode enforcement via JWT claims
    // CS-only users (role=cs) should not access sales coaching modes
    // Sales reps (role=rep) should not access cs_ modes
    const jwtUser = event._user;
    if (jwtUser && jwtUser.roles && jwtUser.roles.length > 0) {
        const userRoles = jwtUser.roles;
        const isCSOnly = userRoles.includes('cs') && !userRoles.includes('admin') && !userRoles.includes('manager') && !userRoles.includes('elt');
        const isRepOnly = userRoles.includes('rep') && !userRoles.includes('admin') && !userRoles.includes('manager') && !userRoles.includes('elt');

        if (isCSOnly && mode && !mode.startsWith('cs_') && VALID_SALES_MODES.includes(mode)) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Access denied: CS users cannot access sales coaching modes' }) };
        }
        if (isRepOnly && mode && mode.startsWith('cs_')) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Access denied: Sales reps cannot access CS modes' }) };
        }
    }

    // Load data files
    loadData();

    // ── CS MODE ROUTING ──
    // If mode starts with cs_, route to CS knowledge base and system prompt
    if (isCSMode(mode)) {
        const csSystemPrompt = getCSSystemPrompt(mode, user_role);
        const csContext = buildCSContext(mode, user_role);
        const contextMessage = csContext ?
            `\n\n---\nCS KNOWLEDGE CONTEXT:\n${csContext}\n---` : '';

        const messages = [];
        if (history && Array.isArray(history)) {
            const recentHistory = history.slice(-6);
            for (const msg of recentHistory) {
                if (msg.role === 'user') {
                    messages.push({ role: 'user', content: msg.content });
                } else if (msg.role === 'chuck' || msg.role === 'assistant') {
                    messages.push({ role: 'assistant', content: msg.content });
                }
            }
        }
        messages.push({ role: 'user', content: message + contextMessage });

        try {
            const client = new Anthropic();
            const response = await client.messages.create({
                model: MODEL,
                max_tokens: 2048,  // CS responses can be longer (reprice scenarios, playbooks)
                temperature: 0.5,  // Slightly lower temp for CS precision
                system: csSystemPrompt,
                messages: messages
            });
            const assistantMessage = response.content[0]?.text || 'I had trouble generating a response.';
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    response: assistantMessage,
                    mode: mode,
                    user_role: user_role || 'unspecified',
                    model: MODEL
                })
            };
        } catch (error) {
            console.error('Claude API error (CS mode):', error);
            if (error.status === 429) {
                return { statusCode: 429, headers, body: JSON.stringify({ error: 'Chuck is getting a lot of questions right now. Please try again in a moment.' }) };
            }
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chuck encountered an error in CS mode. Please try again.' }) };
        }
    }

    // ── DEV MODE ROUTING ──
    // If mode starts with dev_, use the Dev system prompt but reuse the existing
    // Sales knowledge base (buildContext) so Dev gets full product / compliance /
    // dealer-workflow / testimonial context. Purely additive; Sales/CS untouched.
    if (isDevMode(mode)) {
        const devIntents = detectIntents(message);
        const devContext = buildContext(devIntents, repName, message);
        const devSystemPrompt = getDevSystemPrompt(mode);
        const devContextMessage = devContext ?
            `\n\n---\nRELEVANT KNOWLEDGE CONTEXT:\n${devContext}\n---` : '';

        const devMessages = [];
        if (history && Array.isArray(history)) {
            const recent = history.slice(-6);
            for (const msg of recent) {
                if (msg.role === 'user') {
                    devMessages.push({ role: 'user', content: msg.content });
                } else if (msg.role === 'chuck' || msg.role === 'assistant') {
                    devMessages.push({ role: 'assistant', content: msg.content });
                }
            }
        }
        devMessages.push({ role: 'user', content: message + devContextMessage });

        try {
            const client = new Anthropic();
            const response = await client.messages.create({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                temperature: TEMPERATURE,
                system: devSystemPrompt,
                messages: devMessages
            });
            const assistantMessage = response.content[0]?.text || 'I had trouble generating a response.';
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    response: assistantMessage,
                    mode: mode,
                    intents: devIntents,
                    model: MODEL
                })
            };
        } catch (error) {
            console.error('Claude API error (Dev mode):', error);
            if (error.status === 429) {
                return { statusCode: 429, headers, body: JSON.stringify({ error: 'Chuck is getting a lot of questions right now. Please try again in a moment.' }) };
            }
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chuck encountered an error in Dev mode. Please try again.' }) };
        }
    }

    // ── SALES MODE ROUTING (existing, unchanged) ──
    // Detect intents and build context
    const intents = detectIntents(message);
    const context = buildContext(intents, repName, message);

    // Build messages array
    const systemPrompt = getSystemPrompt(repName);
    const contextMessage = context ?
        `\n\n---\nRELEVANT KNOWLEDGE CONTEXT:\n${context}\n---` : '';

    const messages = [];

    // Add conversation history (last few turns for continuity)
    if (history && Array.isArray(history)) {
        const recentHistory = history.slice(-6);  // Keep last 3 turns for speed
        for (const msg of recentHistory) {
            if (msg.role === 'user') {
                messages.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'chuck') {
                messages.push({ role: 'assistant', content: msg.content });
            }
        }
    }

    // Add current message with context
    messages.push({
        role: 'user',
        content: message + contextMessage
    });

    // Call Claude API
    try {
        const client = new Anthropic();

        const response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            system: systemPrompt,
            messages: messages
        });

        const assistantMessage = response.content[0]?.text || 'I had trouble generating a response.';

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                response: assistantMessage,
                intents: intents,
                model: MODEL
            })
        };

    } catch (error) {
        console.error('Claude API error:', error);

        if (error.status === 429) {
            return {
                statusCode: 429,
                headers,
                body: JSON.stringify({ error: 'Chuck is getting a lot of questions right now. Please try again in a moment.' })
            };
        }

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Chuck encountered an error. Please try again.' })
        };
    }
}

// Phase 2B-3: Audit log wrapper
export async function handler(event) {
  const response = await _handler(event);
  logRequest(event, response);
  return response;
}

