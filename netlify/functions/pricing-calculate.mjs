/**
 * Pricing Calculator — Netlify Function
 * Pure math engine: no AI calls. Takes parsed intake data, returns full pricing matrix.
 * Matches the COGS and optimization logic from the Informativ pricing calculator skill.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { handleCors, corsHeaders } from './cors.mjs';
import { validateApiKey } from './auth.mjs';

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
// Accepts either a number (volume) or a range string like "0-5", "6-20", etc.
function getStipsCost(stipsInput) {
    if (!stipsInput) return 0;

    // If it's a range string like "0-5", parse the min value and look up
    let volume;
    if (typeof stipsInput === 'string') {
        const parts = stipsInput.split('-');
        volume = parseInt(parts[0]) || 0;
        // Use the min of the range for lookup — the range itself defines the tier
        for (const tier of cogsRates.verified_stips_lookup) {
            if (volume >= tier.min && volume <= tier.max) return tier.cost;
            // Also match if the string exactly matches a tier range
            const tierRange = `${tier.min}-${tier.max}`;
            if (stipsInput === tierRange) return tier.cost;
        }
    } else {
        volume = stipsInput;
    }

    if (volume <= 0) return 0;
    for (const tier of cogsRates.verified_stips_lookup) {
        if (volume >= tier.min && volume <= tier.max) return tier.cost;
    }
    // Above max range — use highest
    return cogsRates.verified_stips_lookup[cogsRates.verified_stips_lookup.length - 1].cost;
}

// ── Tier Cost Calculations ──
function calculateTierCosts(store) {
    const r = cogsRates.bureau_rates;
    const p = cogsRates.product_rates;
    const s = cogsRates.subcode_fees;

    const efxHp = store.efx_hp || 0;
    const expHp = store.exp_hp || 0;
    const tuHp = store.tu_hp || 0;
    const efxSp = store.efx_sp || 0;
    const expSp = store.exp_sp || 0;
    const tuSp = store.tu_sp || 0;
    const dealertrack = store.dealertrack || 0;
    const stipsVol = store.verified_stips || 0;
    const vehiclesSold = store.vehicles_sold || 0;

    const stipsCost = getStipsCost(stipsVol);
    const syntheticIdHp = (efxHp + expHp + tuHp) * p.synthetic_id;

    // Suggested HP for SmartPencil = vehicles_sold * 1.5, ceiling to nearest 100
    const suggHp = vehiclesSold * 1.5;
    const smartPencilCost = Math.ceil(suggHp / 100) * 100 * p.smartpencils;

    // Subcode/SMS fees (conditional on volume > 0)
    const efxHpSubcode = efxHp > 0 ? s.EFX_HP_subcode : 0;
    const efxHpSms = efxHp > 0 ? s.EFX_HP_sms : 0;
    const tuHpSubcode = tuHp > 0 ? s.TU_HP_subcode : 0;
    const expHpSubcode = expHp > 0 ? s.EXP_HP_subcode : 0;
    const efxSpSubcode = efxSp > 0 ? s.EFX_SP_subcode : 0;
    const efxSpSms = efxSp > 0 ? s.EFX_SP_sms : 0;
    const expSpSubcode = expSp > 0 ? s.EXP_SP_subcode : 0;

    // DealerTrack cost: flat fee if volume > 0
    const dealertrackCost = dealertrack > 0 ? p.dealertrack : 0;

    // PROTECT = HP bureaus + DealerTrack + STIPS + Synthetic ID + HP subcodes + Compliance + DL Fraud
    const protectCost =
        (efxHp * r.EFX_HP) + (expHp * r.EXP_HP) + (tuHp * r.TU_HP) +
        dealertrackCost + stipsCost + syntheticIdHp +
        efxHpSubcode + efxHpSms + tuHpSubcode + expHpSubcode +
        p.compliance_suite + p.dl_fraud_check;

    // ENRICH = Protect + SmartPencil + Payments Base
    const enrichCost = protectCost + smartPencilCost + p.informativ_payments_base;

    // ELEVATE = SP bureaus + DealerTrack + STIPS + Synthetic ID (HP vols) + SP subcodes + Compliance + Payments + DL Fraud
    const syntheticIdForElevate = syntheticIdHp; // Still uses HP volumes
    const elevateCost =
        (efxSp * r.EFX_SP) + (expSp * r.EXP_SP) + (tuSp * r.TU_SP) +
        dealertrackCost + stipsCost + syntheticIdForElevate +
        efxSpSubcode + efxSpSms + expSpSubcode +
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
        Control: Math.round(controlCost * 100) / 100
    };
}

// ── Pricing Optimization ──
function optimizePricing(store, tierCosts) {
    const thresholds = cogsRates.gm_thresholds;
    const desiredPrice = store.desired_monthly_price || 0;
    const tiers = ['Protect', 'Enrich', 'Elevate', 'Control'];
    const result = {};

    // If no desired price, use List Price (Target GM% for each tier)
    if (!desiredPrice || desiredPrice <= 0) {
        for (const tier of tiers) {
            const cost = tierCosts[tier];
            const targetGm = thresholds[tier].target;
            const listPrice = Math.round(cost / (1 - targetGm));
            result[tier] = {
                price: listPrice,
                gm_pct: Math.round(targetGm * 1000) / 10,
                status: 'At Target',
                cost: cost
            };
        }
        // Recommend the tier with best value proposition (Enrich typically)
        result.recommended = 'Enrich';
        result.recommendation_reason = 'List pricing at Target GM% — no desired price specified';
        return result;
    }

    // With desired price: run the full optimization logic
    for (const tier of tiers) {
        const cost = tierCosts[tier];
        const target = thresholds[tier].target;
        const manager = thresholds[tier].manager;
        const floor = thresholds[tier].floor;

        // GM% at desired price
        const gmAtDesired = cost > 0 ? (desiredPrice - cost) / desiredPrice : 0;

        if (gmAtDesired >= target) {
            // Step 1: At or above target
            result[tier] = {
                price: desiredPrice,
                gm_pct: Math.round(gmAtDesired * 1000) / 10,
                status: 'At Target',
                cost: cost
            };
        } else if (gmAtDesired >= manager) {
            // Step 2: Between target and manager threshold
            result[tier] = {
                price: desiredPrice,
                gm_pct: Math.round(gmAtDesired * 1000) / 10,
                status: 'Mgr Approval',
                cost: cost
            };
        } else {
            // Step 4: Deal Desk — price at MAX(desired * 1.10, cost / 0.61)
            const dealDeskPrice = Math.max(
                Math.round(desiredPrice * 1.10),
                Math.round(cost / (1 - floor))
            );
            const gmAtDealDesk = (dealDeskPrice - cost) / dealDeskPrice;
            result[tier] = {
                price: dealDeskPrice,
                gm_pct: Math.round(gmAtDealDesk * 1000) / 10,
                status: 'Deal Desk',
                cost: cost
            };
        }
    }

    // Step 3: Revenue Maximization Rule — find best recommendation
    let recommended = null;
    const tierOrder = ['Control', 'Elevate', 'Enrich', 'Protect']; // highest value first

    for (const tier of tierOrder) {
        const cost = tierCosts[tier];
        const manager = thresholds[tier].manager;
        const priceAtMgr = Math.round(cost / (1 - manager));

        // Is this tier's manager-threshold price within 10% of desired?
        if (Math.abs(priceAtMgr - desiredPrice) / desiredPrice <= 0.10) {
            const gmAtMgr = (priceAtMgr - cost) / priceAtMgr;
            if (gmAtMgr >= manager) {
                recommended = tier;
                // Override this tier's pricing to manager threshold
                result[tier] = {
                    price: priceAtMgr,
                    gm_pct: Math.round(gmAtMgr * 1000) / 10,
                    status: gmAtMgr >= thresholds[tier].target ? 'At Target' : 'Mgr Approval',
                    cost: cost
                };
                break;
            }
        }
    }

    // If no revenue max match, recommend the best tier at target or manager
    if (!recommended) {
        for (const tier of ['Enrich', 'Protect', 'Elevate', 'Control']) {
            if (result[tier].status !== 'Deal Desk') {
                recommended = tier;
                break;
            }
        }
        // If all are Deal Desk, recommend Protect (lowest cost)
        if (!recommended) recommended = 'Protect';
    }

    result.recommended = recommended;
    result.recommendation_reason = result[recommended].status === 'Deal Desk'
        ? 'All tiers require Deal Desk at this price point'
        : `Best tier at ${result[recommended].status}`;

    return result;
}

// ── ROI Calculation ──
function calculateROI(stores, totalRecommendedMonthly) {
    const roi = cogsRates.roi_assumptions;
    const numRooftops = stores.length;

    // Aggregate volumes across all stores
    let totalVehicles = 0;
    let totalHardPulls = 0;
    let totalDesiredPrice = 0;
    let totalImplFees = 0;

    for (const store of stores) {
        totalVehicles += store.vehicles_sold || 0;
        totalHardPulls += (store.efx_hp || 0) + (store.exp_hp || 0) + (store.tu_hp || 0);
        totalDesiredPrice += store.desired_monthly_price || 0;
        totalImplFees += store.implementation_fee || 0;
    }

    // 1. Credit Bureau Savings
    //    Pulls switched to soft save (hard cost - soft cost) per pull
    const pullsSwitched = totalHardPulls * 12 * roi.pct_pulls_switched_to_soft;
    const savingsPerPull = roi.cost_per_hard_pull - roi.cost_per_soft_pull;
    const creditBureauSavings = Math.round(pullsSwitched * savingsPerPull);

    // 2. Fraud Prevention Savings
    const fraudSavings = Math.round(roi.fraud_events_per_rooftop_per_year * roi.avg_cost_per_fraud_event * numRooftops);

    // 3. FTC Fine Avoidance
    const ftcSavings = Math.round(roi.compliance_violations_per_group * roi.ftc_fine_per_violation);

    // 4. Conversion Uplift (Customer Insights / pre-qualification)
    //    vehicles_sold * 1.5 soft pulls → 44% complete app → 40% show → 9% close × 12 months × PVR
    const prequalVolume = totalVehicles * 1.5;
    const dealsRevived = prequalVolume * roi.prequal_complete_app_rate * roi.prequal_show_rate * roi.prequal_close_rate * 12;
    const conversionUplift = Math.round(dealsRevived * roi.avg_profit_per_unit);

    // 5. SmartPencil PVR Improvement ($100/deal × vehicles × 12)
    const smartPencilImpact = Math.round(totalVehicles * roi.smartpencil_pvr_lift_per_deal * 12);

    // 6. Current Spend Offset (desired price = current credit + compliance spend)
    const currentSpendOffset = Math.round(totalDesiredPrice * 12);

    // Totals
    const totalAnnualSavings = creditBureauSavings + fraudSavings + ftcSavings
        + conversionUplift + smartPencilImpact + currentSpendOffset;

    const annualInformativCost = Math.round(totalRecommendedMonthly * 12);
    const implCost = totalImplFees || 0;
    const year1Cost = annualInformativCost + implCost;
    const netSavings = totalAnnualSavings - year1Cost;
    const roiPct = year1Cost > 0 ? Math.round((netSavings / year1Cost) * 100) : 0;
    const paybackMonths = netSavings > 0 ? Math.round((year1Cost / (totalAnnualSavings / 12)) * 10) / 10 : null;

    return {
        line_items: {
            credit_bureau_savings: { value: creditBureauSavings, label: 'Credit Bureau Savings', description: 'Soft pull migration reduces per-pull cost', source: 'Informativ internal bureau rate analysis' },
            fraud_prevention: { value: fraudSavings, label: 'Fraud Prevention Savings', description: `${numRooftops} rooftop${numRooftops > 1 ? 's' : ''} × avg. fraud event cost`, source: roi.fraud_event_source },
            ftc_fine_avoidance: { value: ftcSavings, label: 'FTC Compliance Risk Avoidance', description: 'Estimated exposure per violation', source: roi.ftc_fine_source },
            conversion_uplift: { value: conversionUplift, label: 'Customer Insights Conversion Uplift', description: `${Math.round(dealsRevived)} incremental deals/yr from pre-qualification`, source: roi.conversion_source },
            smartpencil_impact: { value: smartPencilImpact, label: 'SmartPencil PVR Improvement', description: `$${roi.smartpencil_pvr_lift_per_deal}/deal × ${totalVehicles} vehicles/mo × 12 months`, source: roi.smartpencil_source },
            current_spend_offset: { value: currentSpendOffset, label: 'Current Credit & Compliance Spend', description: 'Existing vendor costs replaced by Informativ', source: 'Dealer-provided current spend' }
        },
        totals: {
            total_annual_savings: totalAnnualSavings,
            year_1_informativ_cost: year1Cost,
            net_savings: netSavings,
            roi_pct: roiPct,
            payback_months: paybackMonths,
            deals_revived: Math.round(dealsRevived)
        }
    };
}

// ── Main Handler ──
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

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        loadRates();
        const body = JSON.parse(event.body);
        const { group_name, contact_name, website, stores } = body;

        if (!stores || !Array.isArray(stores) || stores.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'No store data provided' }) };
        }

        const results = {
            group_name: group_name || 'Unknown Group',
            contact_name: contact_name || '',
            website: website || '',
            stores: [],
            summary: {
                total_stores: 0,
                total_vehicles: 0,
                total_recommended_monthly: 0,
                total_recommended_annual: 0,
                tier_mix: {}
            }
        };

        for (const store of stores) {
            if (!store.dealership_name || !store.vehicles_sold) continue;

            const tierCosts = calculateTierCosts(store);
            const pricing = optimizePricing(store, tierCosts);

            const storeResult = {
                dealership_name: store.dealership_name,
                vehicles_sold: store.vehicles_sold,
                desired_price: store.desired_monthly_price || 0,
                implementation_fee: store.implementation_fee || 0,
                hard_pulls: (store.efx_hp || 0) + (store.exp_hp || 0) + (store.tu_hp || 0),
                soft_pulls: (store.efx_sp || 0) + (store.exp_sp || 0) + (store.tu_sp || 0),
                tiers: {
                    Protect: pricing.Protect,
                    Enrich: pricing.Enrich,
                    Elevate: pricing.Elevate,
                    Control: pricing.Control
                },
                recommended: pricing.recommended,
                recommendation_reason: pricing.recommendation_reason,
                selected_package: null // Rep fills this in
            };

            results.stores.push(storeResult);
            results.summary.total_stores++;
            results.summary.total_vehicles += store.vehicles_sold;

            const recPrice = pricing[pricing.recommended].price;
            results.summary.total_recommended_monthly += recPrice;

            results.summary.tier_mix[pricing.recommended] =
                (results.summary.tier_mix[pricing.recommended] || 0) + 1;
        }

        results.summary.total_recommended_annual = results.summary.total_recommended_monthly * 12;

        // Calculate ROI using original store data from request body
        results.roi = calculateROI(stores, results.summary.total_recommended_monthly);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(results)
        };

    } catch (error) {
        console.error('Pricing calculation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Pricing calculation failed: ' + error.message })
        };
    }
}
