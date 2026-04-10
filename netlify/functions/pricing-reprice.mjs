/**
 * Reprice Pricing Calculator — Netlify Function
 * Takes an existing customer's actual usage data from CI Dashboard,
 * calculates COGS and optimized tier pricing for all 4 tiers.
 * Returns pricing matrix with current vs. proposed comparison.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';

let cogsRates = null;

function loadRates() {
    if (cogsRates) return;
    const basePaths = [process.cwd(), join(process.cwd(), '..', '..'), '/var/task'];
    for (const base of basePaths) {
        try {
            const raw = readFileSync(join(base, 'cogs-rates.json'), 'utf-8');
            cogsRates = JSON.parse(raw);
            return;
        } catch (e) { continue; }
    }
    throw new Error('Could not load cogs-rates.json');
}

// ── STIPS Lookup ──
function getStipsCost(volume) {
    if (!volume || volume <= 0) return 0;
    for (const tier of cogsRates.verified_stips_lookup) {
        if (volume >= tier.min && volume <= tier.max) return tier.cost;
    }
    return cogsRates.verified_stips_lookup[cogsRates.verified_stips_lookup.length - 1].cost;
}

// ── Calculate COGS for all 4 tiers using actual bureau volumes ──
function calculateRepriceTierCosts(customer) {
    const r = cogsRates.bureau_rates;
    const p = cogsRates.product_rates;
    const s = cogsRates.subcode_fees;

    // Use actual bureau pull volumes from CI data (latest month average or provided)
    const efxHp = customer.efx_hp || 0;
    const expHp = customer.exp_hp || 0;
    const tuHp = customer.tu_hp || 0;
    const efxSp = customer.efx_sp || 0;
    const expSp = customer.exp_sp || 0;
    const tuSp = customer.tu_sp || 0;

    // DealerTrack: assume active if customer currently has it (default yes for auto)
    const dealertrackCost = customer.has_dealertrack ? p.dealertrack : 0;

    // STIPS: estimate from total HP volume
    const totalHp = efxHp + expHp + tuHp;
    const stipsCost = getStipsCost(customer.verified_stips || Math.round(totalHp * 0.15));

    // Synthetic ID: based on HP volumes
    const syntheticIdHp = totalHp * p.synthetic_id;

    // SmartPencil: use suggested HP (vehicles * 1.5, ceiling to 100)
    // For reprices, estimate vehicles from HP volume (HP ≈ vehicles * 1.5)
    const estimatedVehicles = customer.vehicles_sold || Math.round(totalHp / 1.5) || 0;
    const suggHp = estimatedVehicles * 1.5;
    const smartPencilCost = Math.ceil(suggHp / 100) * 100 * p.smartpencils;

    // Subcode/SMS fees (conditional on volume > 0)
    const efxHpSubcode = efxHp > 0 ? s.EFX_HP_subcode : 0;
    const efxHpSms = efxHp > 0 ? s.EFX_HP_sms : 0;
    const tuHpSubcode = tuHp > 0 ? s.TU_HP_subcode : 0;
    const expHpSubcode = expHp > 0 ? s.EXP_HP_subcode : 0;
    const efxSpSubcode = efxSp > 0 ? s.EFX_SP_subcode : 0;
    const efxSpSms = efxSp > 0 ? s.EFX_SP_sms : 0;
    const expSpSubcode = expSp > 0 ? s.EXP_SP_subcode : 0;

    // PROTECT = HP bureaus + DealerTrack + STIPS + Synthetic ID + HP subcodes + Compliance + DL Fraud
    const protectCost =
        (efxHp * r.EFX_HP) + (expHp * r.EXP_HP) + (tuHp * r.TU_HP) +
        dealertrackCost + stipsCost + syntheticIdHp +
        efxHpSubcode + efxHpSms + tuHpSubcode + expHpSubcode +
        p.compliance_suite + p.dl_fraud_check;

    // ENRICH = Protect + SmartPencil + Payments Base
    const enrichCost = protectCost + smartPencilCost + p.informativ_payments_base;

    // ELEVATE = (HP+SP combined) at SP rates + DealerTrack + STIPS + Synthetic ID (HP vols) + SP subcodes + Compliance + Payments + DL Fraud
    // Elevate converts hard pulls to soft pulls — COGS uses combined HP+SP volume at SP bureau rates
    const elevateEfx = efxHp + efxSp;
    const elevateExp = expHp + expSp;
    const elevateTu = tuHp + tuSp;
    const elevateEfxSubcode = elevateEfx > 0 ? s.EFX_SP_subcode : 0;
    const elevateEfxSms = elevateEfx > 0 ? s.EFX_SP_sms : 0;
    const elevateExpSubcode = elevateExp > 0 ? s.EXP_SP_subcode : 0;
    const elevateCost =
        (elevateEfx * r.EFX_SP) + (elevateExp * r.EXP_SP) + (elevateTu * r.TU_SP) +
        dealertrackCost + stipsCost + syntheticIdHp +
        elevateEfxSubcode + elevateEfxSms + elevateExpSubcode +
        p.compliance_suite + p.informativ_payments_base + p.dl_fraud_check;

    // CONTROL = Everything combined
    const controlCost =
        (efxHp * r.EFX_HP) + (expHp * r.EXP_HP) + (tuHp * r.TU_HP) +
        (efxSp * r.EFX_SP) + (expSp * r.EXP_SP) + (tuSp * r.TU_SP) +
        dealertrackCost + stipsCost + syntheticIdHp + smartPencilCost +
        efxHpSubcode + efxHpSms + tuHpSubcode + expHpSubcode +
        efxSpSubcode + efxSpSms + expSpSubcode +
        p.compliance_suite + p.informativ_payments_base + p.dl_fraud_check;

    return {
        Protect: Math.round(protectCost * 100) / 100,
        Enrich: Math.round(enrichCost * 100) / 100,
        Elevate: Math.round(elevateCost * 100) / 100,
        Control: Math.round(controlCost * 100) / 100,
        // Cost breakdown for transparency
        _breakdown: {
            bureau_hp: Math.round(((efxHp * r.EFX_HP) + (expHp * r.EXP_HP) + (tuHp * r.TU_HP)) * 100) / 100,
            bureau_sp: Math.round(((efxSp * r.EFX_SP) + (expSp * r.EXP_SP) + (tuSp * r.TU_SP)) * 100) / 100,
            bureau_elevate: Math.round(((elevateEfx * r.EFX_SP) + (elevateExp * r.EXP_SP) + (elevateTu * r.TU_SP)) * 100) / 100,
            dealertrack: dealertrackCost,
            stips: stipsCost,
            synthetic_id: Math.round(syntheticIdHp * 100) / 100,
            smartpencil: smartPencilCost,
            compliance: p.compliance_suite,
            dl_fraud: p.dl_fraud_check,
            payments_base: p.informativ_payments_base,
            subcodes_hp: Math.round((efxHpSubcode + efxHpSms + tuHpSubcode + expHpSubcode) * 100) / 100,
            subcodes_sp: Math.round((efxSpSubcode + efxSpSms + expSpSubcode) * 100) / 100,
            subcodes_elevate: Math.round((elevateEfxSubcode + elevateEfxSms + elevateExpSubcode) * 100) / 100
        }
    };
}

// ── Pricing Optimization for Reprices ──
function optimizeRepricePricing(customer, tierCosts) {
    const thresholds = cogsRates.gm_thresholds;
    const currentMrr = customer.current_mrr || 0;
    const tiers = ['Protect', 'Enrich', 'Elevate', 'Control'];
    const result = {};

    for (const tier of tiers) {
        const cost = tierCosts[tier];
        const target = thresholds[tier].target;
        const manager = thresholds[tier].manager;
        const floor = thresholds[tier].floor;

        // Calculate list price at target GM%
        const listPrice = Math.round(cost / (1 - target));

        // Calculate GM% at current MRR (to show where customer sits today)
        const gmAtCurrent = currentMrr > 0 ? (currentMrr - cost) / currentMrr : 0;

        // For reprices, always show the target price as the recommended starting point
        // If current MRR already meets target, recommend maintaining or upgrading
        let recommendedPrice, status;

        if (gmAtCurrent >= target) {
            // Current price already at or above target for this tier
            recommendedPrice = Math.max(currentMrr, listPrice);
            status = 'At Target';
        } else if (gmAtCurrent >= manager) {
            // Current price in manager approval range
            recommendedPrice = listPrice;
            status = 'Mgr Approval';
        } else {
            // Below manager threshold — needs price increase
            recommendedPrice = listPrice;
            status = cost > 0 && gmAtCurrent < floor ? 'Deal Desk' : 'Needs Increase';
        }

        // Floor enforcement — never price below the tier floor
        const floorPrice = Math.round(cost / (1 - floor));
        recommendedPrice = Math.max(recommendedPrice, floorPrice);

        const gmAtRecommended = recommendedPrice > 0 ? (recommendedPrice - cost) / recommendedPrice : 0;

        // Manager threshold price — the minimum CS can discount to without Deal Desk
        const managerPrice = Math.round(cost / (1 - manager));

        // Deal Desk price — absolute minimum at 40% GM (requires Deal Desk approval)
        const DEAL_DESK_GM = 0.40;
        const dealDeskPrice = Math.round(cost / (1 - DEAL_DESK_GM));

        result[tier] = {
            cost: cost,
            list_price: listPrice,
            recommended_price: recommendedPrice,
            manager_price: managerPrice,
            deal_desk_price: dealDeskPrice,
            gm_at_list: Math.round((1 - cost / listPrice) * 1000) / 10,
            gm_at_current: Math.round(gmAtCurrent * 1000) / 10,
            gm_at_recommended: Math.round(gmAtRecommended * 1000) / 10,
            gm_at_manager: Math.round(manager * 1000) / 10,
            gm_at_deal_desk: Math.round(DEAL_DESK_GM * 1000) / 10,
            status: status,
            price_change: recommendedPrice - currentMrr,
            price_change_pct: currentMrr > 0 ? Math.round((recommendedPrice - currentMrr) / currentMrr * 1000) / 10 : 0
        };
    }

    // Recommend the best tier based on customer's current package and usage
    let recommended = 'Protect';
    const currentPkg = (customer.current_package || '').toLowerCase();

    if (currentPkg.includes('control')) {
        recommended = 'Control';
    } else if (currentPkg.includes('elevate')) {
        recommended = 'Elevate';
    } else if (currentPkg.includes('enrich')) {
        recommended = 'Enrich';
    } else if (customer.efx_sp + customer.exp_sp + customer.tu_sp > 0 &&
               customer.efx_hp + customer.exp_hp + customer.tu_hp > 0) {
        // Has both HP and SP pulls — suggest Control
        recommended = 'Control';
    } else if (customer.efx_sp + customer.exp_sp + customer.tu_sp > 0) {
        recommended = 'Elevate';
    } else {
        // Has HP pulls — suggest Enrich for value-add or Protect for cost-conscious
        recommended = 'Enrich';
    }

    // Override: if the cross-sell recommendation exists from CI, use it
    if (customer.cross_sell_rec) {
        const csrMap = { 'protect': 'Protect', 'enrich': 'Enrich', 'elevate': 'Elevate', 'control': 'Control' };
        const mapped = csrMap[(customer.cross_sell_rec || '').toLowerCase()];
        if (mapped) recommended = mapped;
    }

    result.recommended = recommended;

    return result;
}

// ── ROI Calculation for Reprices ──
function calculateRepriceROI(customer, tierPricing) {
    const roi = cogsRates.roi_assumptions;
    const currentMrr = customer.current_mrr || 0;
    const recommended = tierPricing.recommended;
    const recTier = tierPricing[recommended];
    const newMonthly = recTier.recommended_price;

    const totalHp = (customer.efx_hp || 0) + (customer.exp_hp || 0) + (customer.tu_hp || 0);
    const estimatedVehicles = customer.vehicles_sold || Math.round(totalHp / 1.5) || 0;

    // 1. Credit Bureau Savings (if moving to soft pulls)
    const pullsSwitched = totalHp * 12 * roi.pct_pulls_switched_to_soft;
    const savingsPerPull = roi.cost_per_hard_pull - roi.cost_per_soft_pull;
    const creditBureauSavings = Math.round(pullsSwitched * savingsPerPull);

    // 2. Fraud Prevention Savings
    const fraudSavings = Math.round(roi.fraud_events_per_rooftop_per_year * roi.avg_cost_per_fraud_event);

    // 3. FTC Fine Avoidance
    const ftcSavings = Math.round(roi.compliance_violations_per_group * roi.ftc_fine_per_violation);

    // 4. Conversion Uplift
    const prequalVolume = estimatedVehicles * 1.5;
    const dealsRevived = prequalVolume * roi.prequal_complete_app_rate * roi.prequal_show_rate * roi.prequal_close_rate * 12;
    const conversionUplift = Math.round(dealsRevived * roi.avg_profit_per_unit);

    // 5. SmartPencil PVR Improvement
    const smartPencilImpact = Math.round(estimatedVehicles * roi.smartpencil_pvr_lift_per_deal * 12);

    // 6. Current Spend Offset
    const currentSpendOffset = Math.round(currentMrr * 12);

    const totalAnnualSavings = creditBureauSavings + fraudSavings + ftcSavings
        + conversionUplift + smartPencilImpact + currentSpendOffset;

    const annualInformativCost = Math.round(newMonthly * 12);
    const netSavings = totalAnnualSavings - annualInformativCost;
    const roiPct = annualInformativCost > 0 ? Math.round((netSavings / annualInformativCost) * 100) : 0;
    const paybackMonths = netSavings > 0 ? Math.round((annualInformativCost / (totalAnnualSavings / 12)) * 10) / 10 : null;

    return {
        line_items: {
            credit_bureau_savings: { value: creditBureauSavings, label: 'Credit Bureau Savings', description: 'Soft pull migration reduces per-pull cost', source: 'Informativ internal bureau rate analysis' },
            fraud_prevention: { value: fraudSavings, label: 'Fraud Prevention Savings', description: 'Avg. fraud event cost avoidance per rooftop', source: roi.fraud_event_source },
            ftc_fine_avoidance: { value: ftcSavings, label: 'FTC Compliance Risk Avoidance', description: 'Estimated exposure per violation', source: roi.ftc_fine_source },
            conversion_uplift: { value: conversionUplift, label: 'Customer Insights Conversion Uplift', description: `${Math.round(dealsRevived)} incremental deals/yr from pre-qualification`, source: roi.conversion_source },
            smartpencil_impact: { value: smartPencilImpact, label: 'SmartPencil PVR Improvement', description: `$${roi.smartpencil_pvr_lift_per_deal}/deal × ${estimatedVehicles} vehicles/mo × 12 months`, source: roi.smartpencil_source },
            current_spend_offset: { value: currentSpendOffset, label: 'Current Credit & Compliance Spend', description: 'Existing vendor costs replaced by Informativ', source: 'Customer current MRR' }
        },
        totals: {
            total_annual_savings: totalAnnualSavings,
            year_1_informativ_cost: annualInformativCost,
            net_savings: netSavings,
            roi_pct: roiPct,
            payback_months: paybackMonths,
            deals_revived: Math.round(dealsRevived)
        }
    };
}

// ── Main Handler ──
async function _handler(event) {
    // --- Unified API Gateway middleware ---
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = await authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');


    const headers = {
        'Content-Type': 'application/json',
        ..._cors
    };

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        loadRates();
        const body = JSON.parse(event.body);

        // Validate required fields
        if (!body.customer_name) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'customer_name is required' }) };
        }

        // Build customer object from CI data fields
        const customer = {
            customer_name: body.customer_name,
            current_mrr: body.current_mrr || 0,
            current_package: body.current_package || 'Unknown',
            bureau_config: body.bureau_config || '',
            customer_type: body.customer_type || 'Auto',
            // Bureau pull volumes (monthly averages from CI data)
            efx_hp: body.efx_hp || 0,
            exp_hp: body.exp_hp || 0,
            tu_hp: body.tu_hp || 0,
            efx_sp: body.efx_sp || 0,
            exp_sp: body.exp_sp || 0,
            tu_sp: body.tu_sp || 0,
            // Optional fields
            vehicles_sold: body.vehicles_sold || 0,
            has_dealertrack: body.has_dealertrack !== false,
            verified_stips: body.verified_stips || 0,
            cross_sell_rec: body.cross_sell_rec || null,
            health_score: body.health_score || 0,
            margin_pct: body.margin_pct || 0,
            margin_3mo: body.margin_3mo || 0,
            revenue_tier: body.revenue_tier || '',
            group_name: body.group_name || null
        };

        // Calculate tier costs
        const tierCosts = calculateRepriceTierCosts(customer);

        // Optimize pricing
        const pricing = optimizeRepricePricing(customer, tierCosts);

        // Calculate ROI
        const roi = calculateRepriceROI(customer, pricing);

        const result = {
            customer_name: customer.customer_name,
            group_name: customer.group_name,
            customer_type: customer.customer_type,
            current_state: {
                mrr: customer.current_mrr,
                package: customer.current_package,
                bureau_config: customer.bureau_config,
                margin_pct: customer.margin_pct,
                margin_3mo: customer.margin_3mo,
                health_score: customer.health_score,
                revenue_tier: customer.revenue_tier
            },
            bureau_volumes: {
                hard_pulls: {
                    efx: customer.efx_hp,
                    exp: customer.exp_hp,
                    tu: customer.tu_hp,
                    total: customer.efx_hp + customer.exp_hp + customer.tu_hp
                },
                soft_pulls: {
                    efx: customer.efx_sp,
                    exp: customer.exp_sp,
                    tu: customer.tu_sp,
                    total: customer.efx_sp + customer.exp_sp + customer.tu_sp
                }
            },
            estimated_vehicles: customer.vehicles_sold || Math.round((customer.efx_hp + customer.exp_hp + customer.tu_hp) / 1.5) || 0,
            bureau_detail: {
                equifax_hp: customer.efx_hp,
                equifax_sp: customer.efx_sp,
                experian_hp: customer.exp_hp,
                experian_sp: customer.exp_sp,
                transunion_hp: customer.tu_hp,
                transunion_sp: customer.tu_sp,
                months_averaged: body.months_averaged || 3
            },
            tier_pricing: pricing,
            cost_breakdown: tierCosts._breakdown,
            roi: roi,
            recommended_tier: pricing.recommended,
            recommended_price: pricing[pricing.recommended].recommended_price,
            recommended_gm: pricing[pricing.recommended].gm_at_recommended
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Reprice calculation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Reprice calculation failed: ' + error.message })
        };
    }
}

// Phase 2B-3: Audit log wrapper
export async function handler(event) {
  const response = await _handler(event);
  logRequest(event, response);
  return response;
}
