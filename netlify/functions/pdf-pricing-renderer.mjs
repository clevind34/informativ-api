/**
 * Shared PDF Pricing Renderer — Used by docs-reprice-sheet.mjs and docs-group-reprice-sheet.mjs
 *
 * Generates clean one-page pricing PDFs and (optionally) appends the bundled
 * tier-descriptions.pdf marketing one-pager. Used when the rep checks
 * "Include Tier Descriptions" on either CI Dashboard or PIE Dashboard reprice flow.
 *
 * Returns Uint8Array (PDF bytes). Caller base64-encodes for JSON return.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFileSync } from 'fs';
import { join } from 'path';

// Brand colors (matching DOCX functions)
const NAVY = rgb(0x1B / 255, 0x2A / 255, 0x4A / 255);
const WHITE = rgb(1, 1, 1);
const GRAY_TEXT = rgb(0.40, 0.40, 0.40);
const GRAY_LIGHT = rgb(0.96, 0.96, 0.96);
const GREEN = rgb(0.11, 0.48, 0.24);
const GREEN_BG = rgb(0.90, 0.95, 0.90);
const RED = rgb(0.73, 0.11, 0.11);
const BORDER = rgb(0.85, 0.85, 0.85);

// Page geometry (US Letter portrait)
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const MARGIN_Y = 54;

const fmt = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');

let tierDescriptionsBytes = null;
function loadTierDescriptions() {
    if (tierDescriptionsBytes) return tierDescriptionsBytes;
    const basePaths = [process.cwd(), join(process.cwd(), '..', '..'), '/var/task'];
    for (const base of basePaths) {
        try {
            tierDescriptionsBytes = readFileSync(join(base, 'tier-descriptions.pdf'));
            return tierDescriptionsBytes;
        } catch (e) { continue; }
    }
    console.warn('[pdf-pricing-renderer] Could not load tier-descriptions.pdf');
    return null;
}

function drawText(page, text, x, y, opts = {}) {
    page.drawText(String(text || ''), {
        x, y,
        size: opts.size || 10,
        font: opts.font,
        color: opts.color || rgb(0.2, 0.2, 0.2),
        maxWidth: opts.maxWidth,
    });
}

function drawRect(page, x, y, w, h, fill, border = null) {
    if (fill) page.drawRectangle({ x, y, width: w, height: h, color: fill });
    if (border) page.drawRectangle({ x, y, width: w, height: h, borderColor: border, borderWidth: 0.5 });
}

function wrapText(text, font, size, maxWidth) {
    if (!text) return [];
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
        const tryLine = line ? line + ' ' + w : w;
        const width = font.widthOfTextAtSize(tryLine, size);
        if (width > maxWidth && line) {
            lines.push(line);
            line = w;
        } else {
            line = tryLine;
        }
    }
    if (line) lines.push(line);
    return lines;
}

async function _buildRepriceCorePdf(pdfDoc, data) {
    const {
        customer_name, group_name, current_state, bureau_volumes,
        tier_pricing, recommended_tier, roi, contact_name
    } = data;

    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const helvOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const displayName = group_name || customer_name || 'Customer';
    const displayContact = contact_name || customer_name || '';

    const now = new Date();
    const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    let y = PAGE_H - MARGIN_Y;

    drawText(page, 'Informativ', MARGIN_X, y - 8, { font: helvBold, size: 18, color: NAVY });
    const dateW = helv.widthOfTextAtSize(monthYear, 10);
    drawText(page, monthYear, PAGE_W - MARGIN_X - dateW, y - 4, { font: helv, size: 10, color: GRAY_TEXT });
    y -= 26;

    drawText(page, 'PRICING REVIEW', MARGIN_X, y - 8, { font: helvBold, size: 9, color: GRAY_TEXT });
    y -= 24;

    drawText(page, displayName.toUpperCase(), MARGIN_X, y - 18, { font: helvBold, size: 22, color: NAVY });
    y -= 26;

    if (displayContact) {
        drawText(page, 'Prepared for ' + displayContact, MARGIN_X, y - 12, { font: helv, size: 11, color: GRAY_TEXT });
        y -= 18;
    }

    page.drawLine({
        start: { x: MARGIN_X, y: y - 4 },
        end:   { x: PAGE_W - MARGIN_X, y: y - 4 },
        thickness: 0.75,
        color: BORDER,
    });
    y -= 22;

    drawText(page, 'CURRENT ACCOUNT', MARGIN_X, y - 10, { font: helvBold, size: 10, color: NAVY });
    y -= 24;

    const colW = (PAGE_W - 2 * MARGIN_X) / 4;
    const totalHp = bureau_volumes && bureau_volumes.hard_pulls ? (bureau_volumes.hard_pulls.total || 0) : 0;
    const totalSp = bureau_volumes && bureau_volumes.soft_pulls ? (bureau_volumes.soft_pulls.total || 0) : 0;
    let pullVol = '';
    if (totalHp > 0) pullVol += totalHp + ' HP';
    if (totalHp > 0 && totalSp > 0) pullVol += ' / ';
    if (totalSp > 0) pullVol += totalSp + ' SP';
    if (!pullVol) pullVol = '—';

    const summaryFields = [
        { label: 'Current Monthly', value: fmt(current_state ? current_state.mrr : 0) },
        { label: 'Current Package', value: (current_state && current_state.package) || 'Unknown' },
        { label: 'Bureau Config',   value: (current_state && current_state.bureau_config) || 'N/A' },
        { label: 'Monthly Pulls',   value: pullVol },
    ];
    summaryFields.forEach((f, i) => {
        const x = MARGIN_X + i * colW;
        drawText(page, f.label.toUpperCase(), x, y - 8, { font: helvBold, size: 7, color: GRAY_TEXT });
        const valSize = 13;
        const valLines = wrapText(f.value, helvBold, valSize, colW - 8);
        drawText(page, valLines[0] || '', x, y - 24, { font: helvBold, size: valSize, color: NAVY });
    });
    y -= 56;

    drawText(page, 'PRICING RECOMMENDATION', MARGIN_X, y, { font: helvBold, size: 10, color: NAVY });
    y -= 14;
    drawText(page, 'Based on actual usage, the highlighted package is recommended.', MARGIN_X, y, {
        font: helvOblique, size: 9, color: GRAY_TEXT
    });
    y -= 18;

    const tierDescriptions = {
        'Protect': 'Credit reporting, compliance, fraud prevention',
        'Enrich':  'Protect + SmartPencil pre-desking + Payments',
        'Elevate': 'Soft pull bureau + compliance + SmartPencil',
        'Control': 'Full HP + SP bureau + all products'
    };
    const allTiers = ['Protect', 'Enrich', 'Elevate', 'Control'];
    const tiers = allTiers.filter(t => tier_pricing && tier_pricing[t]);

    const tableX = MARGIN_X;
    const tableW = PAGE_W - 2 * MARGIN_X;
    const colDefs = [
        { label: 'Package',    w: 0.20 },
        { label: 'Includes',   w: 0.45 },
        { label: 'Monthly',    w: 0.18 },
        { label: 'vs Current', w: 0.17 },
    ];
    const colWs = colDefs.map(c => c.w * tableW);
    const xs = [tableX];
    for (let i = 0; i < colWs.length - 1; i++) xs.push(xs[i] + colWs[i]);

    drawRect(page, tableX, y - 22, tableW, 22, NAVY);
    colDefs.forEach((c, i) => {
        drawText(page, c.label.toUpperCase(), xs[i] + 6, y - 14, { font: helvBold, size: 9, color: WHITE });
    });
    y -= 22;

    const rowH = 38;
    tiers.forEach((tier, i) => {
        const t = tier_pricing[tier];
        const isRec = tier === recommended_tier;
        const fill = isRec ? GREEN_BG : (i % 2 === 1 ? GRAY_LIGHT : WHITE);
        drawRect(page, tableX, y - rowH, tableW, rowH, fill, BORDER);

        drawText(page, tier, xs[0] + 6, y - 14, { font: helvBold, size: 11, color: NAVY });
        if (isRec) {
            drawText(page, '» RECOMMENDED', xs[0] + 6, y - 28, { font: helvBold, size: 7, color: GREEN });
        }

        const desc = tierDescriptions[tier] || '';
        const descLines = wrapText(desc, helv, 9, colWs[1] - 12);
        descLines.slice(0, 2).forEach((ln, k) => {
            drawText(page, ln, xs[1] + 6, y - 14 - k * 11, { font: helv, size: 9, color: GRAY_TEXT });
        });

        drawText(page, fmt(t.recommended_price), xs[2] + 6, y - 18, { font: helvBold, size: 13, color: NAVY });
        if (typeof t.gm_at_recommended === 'number') {
            drawText(page, t.gm_at_recommended.toFixed(1) + '% GM', xs[2] + 6, y - 30, { font: helv, size: 8, color: GRAY_TEXT });
        }

        const cur = (current_state && current_state.mrr) || 0;
        const delta = t.recommended_price - cur;
        let changeText, changeColor;
        if (Math.abs(delta) < 1) { changeText = 'No Change'; changeColor = GRAY_TEXT; }
        else if (delta > 0)      { changeText = '+' + fmt(delta); changeColor = RED; }
        else                     { changeText = '-' + fmt(Math.abs(delta)); changeColor = GREEN; }
        drawText(page, changeText, xs[3] + 6, y - 18, { font: helvBold, size: 12, color: changeColor });

        y -= rowH;
    });

    y -= 18;

    if (roi && roi.totals) {
        const r = roi.totals;
        drawText(page, 'EXPECTED RETURN', MARGIN_X, y, { font: helvBold, size: 10, color: NAVY });
        y -= 16;

        const roiFields = [
            { label: 'Annual Investment',    value: fmt(r.annual_investment || 0) },
            { label: 'Estimated Annual ROI', value: fmt(r.annual_roi_value || r.annual_value || 0) },
            { label: 'ROI %',                value: typeof r.roi_pct === 'number' ? r.roi_pct + '%' : '—' },
        ];
        const rcW = (PAGE_W - 2 * MARGIN_X) / roiFields.length;
        roiFields.forEach((f, i) => {
            const x = MARGIN_X + i * rcW;
            drawRect(page, x + 4, y - 50, rcW - 8, 50, GRAY_LIGHT, BORDER);
            drawText(page, f.label.toUpperCase(), x + 12, y - 16, { font: helvBold, size: 7, color: GRAY_TEXT });
            drawText(page, f.value, x + 12, y - 38, { font: helvBold, size: 16, color: NAVY });
        });
        y -= 60;
    }

    const footY = MARGIN_Y - 8;
    page.drawLine({
        start: { x: MARGIN_X, y: footY + 14 },
        end:   { x: PAGE_W - MARGIN_X, y: footY + 14 },
        thickness: 0.5,
        color: BORDER,
    });
    drawText(page, 'Prepared for ' + (displayContact || displayName) + ', ' + displayName + '  |  ' + monthYear,
        MARGIN_X, footY, { font: helvOblique, size: 8, color: GRAY_TEXT });
    drawText(page, 'Informativ Confidential', PAGE_W - MARGIN_X - 100, footY, { font: helv, size: 8, color: GRAY_TEXT });
}

export async function buildRepricePdfBytes(data, opts) {
    const includeTierDescriptions = !!(opts && opts.includeTierDescriptions);
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle((data.group_name || data.customer_name || 'Customer') + ' — Pricing Review');
    pdfDoc.setProducer('Informativ Pricing System');
    pdfDoc.setCreator('Informativ');
    pdfDoc.setCreationDate(new Date());

    await _buildRepriceCorePdf(pdfDoc, data);

    if (includeTierDescriptions) {
        await _appendTierDescriptions(pdfDoc);
    }

    return await pdfDoc.save();
}

async function _buildGroupCorePdf(pdfDoc, data) {
    const { group_name, rooftops } = data;
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const helvOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    const now = new Date();
    const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    let totalCurrentMrr = 0;
    let totalRecommended = 0;
    (rooftops || []).forEach(r => {
        totalCurrentMrr += (r.current_mrr || 0);
        totalRecommended += (r.recommended_price || 0);
    });
    const annualInv = totalRecommended * 12;
    const monthlyDelta = totalRecommended - totalCurrentMrr;

    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN_Y;

    drawText(page, 'Informativ', MARGIN_X, y - 8, { font: helvBold, size: 18, color: NAVY });
    const dateW = helv.widthOfTextAtSize(monthYear, 10);
    drawText(page, monthYear, PAGE_W - MARGIN_X - dateW, y - 4, { font: helv, size: 10, color: GRAY_TEXT });
    y -= 26;

    drawText(page, 'GROUP PRICING REVIEW', MARGIN_X, y - 8, { font: helvBold, size: 9, color: GRAY_TEXT });
    y -= 24;

    drawText(page, (group_name || 'Group').toUpperCase(), MARGIN_X, y - 18, { font: helvBold, size: 22, color: NAVY });
    y -= 26;

    drawText(page, (rooftops || []).length + ' rooftops  •  Recommended monthly: ' + fmt(totalRecommended) + '  •  Annual: ' + fmt(annualInv),
        MARGIN_X, y - 12, { font: helv, size: 11, color: GRAY_TEXT });
    y -= 18;

    page.drawLine({
        start: { x: MARGIN_X, y: y - 4 }, end: { x: PAGE_W - MARGIN_X, y: y - 4 },
        thickness: 0.75, color: BORDER,
    });
    y -= 22;

    const kpis = [
        { label: 'Current Monthly Total', value: fmt(totalCurrentMrr) },
        { label: 'New Monthly Total',     value: fmt(totalRecommended) },
        { label: 'Monthly Change',        value: (monthlyDelta >= 0 ? '+' : '-') + fmt(Math.abs(monthlyDelta)),
                                          color: monthlyDelta > 0 ? RED : (monthlyDelta < 0 ? GREEN : NAVY) },
        { label: 'Annual Investment',     value: fmt(annualInv) },
    ];
    const kpiW = (PAGE_W - 2 * MARGIN_X) / kpis.length;
    kpis.forEach((k, i) => {
        const x = MARGIN_X + i * kpiW;
        drawRect(page, x + 4, y - 56, kpiW - 8, 56, GRAY_LIGHT, BORDER);
        drawText(page, k.label.toUpperCase(), x + 12, y - 16, { font: helvBold, size: 7, color: GRAY_TEXT });
        drawText(page, k.value, x + 12, y - 40, { font: helvBold, size: 16, color: k.color || NAVY });
    });
    y -= 72;

    drawText(page, 'PER-ROOFTOP RECOMMENDATION', MARGIN_X, y, { font: helvBold, size: 10, color: NAVY });
    y -= 16;

    const tableX = MARGIN_X;
    const tableW = PAGE_W - 2 * MARGIN_X;
    const cols = [
        { label: 'Dealership', w: 0.32 },
        { label: 'City/State', w: 0.18 },
        { label: 'Package',    w: 0.16 },
        { label: 'Current',    w: 0.12 },
        { label: 'New',        w: 0.12 },
        { label: 'Change',     w: 0.10 },
    ];
    const colWs2 = cols.map(c => c.w * tableW);
    const xs2 = [tableX];
    for (let i = 0; i < colWs2.length - 1; i++) xs2.push(xs2[i] + colWs2[i]);

    drawRect(page, tableX, y - 20, tableW, 20, NAVY);
    cols.forEach((c, i) => {
        drawText(page, c.label.toUpperCase(), xs2[i] + 6, y - 13, { font: helvBold, size: 8, color: WHITE });
    });
    y -= 20;

    const rowH2 = 22;
    const rooftopList = (rooftops || []).slice(0, 22);
    rooftopList.forEach((r, i) => {
        const fill = i % 2 === 1 ? GRAY_LIGHT : WHITE;
        drawRect(page, tableX, y - rowH2, tableW, rowH2, fill, BORDER);

        const name = r.dealership_name || r.customer_name || '—';
        const nameLines = wrapText(name, helvBold, 9, colWs2[0] - 10);
        drawText(page, nameLines[0] || '', xs2[0] + 6, y - 14, { font: helvBold, size: 9, color: NAVY });

        drawText(page, r.location || ((r.city || '') + (r.state ? ', ' + r.state : '')) || '—',
            xs2[1] + 6, y - 14, { font: helv, size: 8, color: GRAY_TEXT });
        drawText(page, r.recommended_tier || r.selected_tier || '—',
            xs2[2] + 6, y - 14, { font: helvBold, size: 9, color: NAVY });
        drawText(page, fmt(r.current_mrr || 0), xs2[3] + 6, y - 14, { font: helv, size: 9 });
        drawText(page, fmt(r.recommended_price || 0), xs2[4] + 6, y - 14, { font: helvBold, size: 9, color: NAVY });

        const delta = (r.recommended_price || 0) - (r.current_mrr || 0);
        let changeText, changeColor;
        if (Math.abs(delta) < 1) { changeText = '—'; changeColor = GRAY_TEXT; }
        else if (delta > 0)      { changeText = '+' + fmt(delta); changeColor = RED; }
        else                     { changeText = '-' + fmt(Math.abs(delta)); changeColor = GREEN; }
        drawText(page, changeText, xs2[5] + 6, y - 14, { font: helvBold, size: 9, color: changeColor });

        y -= rowH2;
    });

    if ((rooftops || []).length > rooftopList.length) {
        y -= 12;
        drawText(page, '+ ' + (rooftops.length - rooftopList.length) + ' additional rooftops — see attached detail',
            MARGIN_X, y, { font: helvOblique, size: 9, color: GRAY_TEXT });
    }

    const footY = MARGIN_Y - 8;
    page.drawLine({
        start: { x: MARGIN_X, y: footY + 14 }, end: { x: PAGE_W - MARGIN_X, y: footY + 14 },
        thickness: 0.5, color: BORDER,
    });
    drawText(page, (group_name || 'Group') + '  |  ' + monthYear + '  |  Informativ Confidential',
        MARGIN_X, footY, { font: helvOblique, size: 8, color: GRAY_TEXT });
}

export async function buildGroupRepricePdfBytes(data, opts) {
    const includeTierDescriptions = !!(opts && opts.includeTierDescriptions);
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle((data.group_name || 'Group') + ' — Group Pricing Review');
    pdfDoc.setProducer('Informativ Pricing System');
    pdfDoc.setCreator('Informativ');
    pdfDoc.setCreationDate(new Date());

    await _buildGroupCorePdf(pdfDoc, data);

    if (includeTierDescriptions) {
        await _appendTierDescriptions(pdfDoc);
    }

    return await pdfDoc.save();
}

async function _appendTierDescriptions(pdfDoc) {
    const bytes = loadTierDescriptions();
    if (!bytes) return;
    try {
        const tierPdf = await PDFDocument.load(bytes);
        const pages = await pdfDoc.copyPages(tierPdf, tierPdf.getPageIndices());
        pages.forEach(p => pdfDoc.addPage(p));
    } catch (e) {
        console.error('[pdf-pricing-renderer] Failed to append tier descriptions:', e.message);
    }
}
