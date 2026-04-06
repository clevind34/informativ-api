/**
 * Group Reprice External Price Sheet DOCX Generator — Netlify Function
 * Generates a group-level customer-facing reprice document with:
 *   - Group summary header
 *   - Per-rooftop pricing tables (compact)
 *   - Group total summary
 *   - Tier selection/deselection support
 *
 * Input: { group_name, rooftops: [{ customer_name, current_state, bureau_volumes, bureau_detail, tier_pricing, selected_tier, recommended_tier, roi }], hidden_tiers: [] }
 * Returns base64-encoded DOCX for client-side download.
 */

import {
import { handleCors, corsHeaders } from './cors.mjs';
import { validateApiKey } from './auth.mjs';

    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, WidthType, AlignmentType, BorderStyle,
    convertInchesToTwip, Footer, Header, ImageRun, PageBreak
} from 'docx';
import { readFileSync } from 'fs';
import { join } from 'path';

let logoBuffer = null;
function loadLogo() {
    if (logoBuffer) return;
    const basePaths = [process.cwd(), join(process.cwd(), '..', '..'), '/var/task'];
    for (const base of basePaths) {
        try {
            logoBuffer = readFileSync(join(base, 'informativ-logo.png'));
            return;
        } catch (e) { continue; }
    }
    console.warn('Could not load logo file');
}

const NAVY = '1B2A4A';
const WHITE = 'FFFFFF';
const GRAY_LIGHT = 'F5F5F5';
const GRAY_TEXT = '666666';
const GREEN = '1B7A3D';
const GREEN_BG = 'E6F3E6';

function fmt(num) {
    return '$' + Math.round(num).toLocaleString('en-US');
}

function fmtPct(num) {
    return num.toFixed(1) + '%';
}

function buildGroupRepriceDoc(data) {
    const { group_name, rooftops, hidden_tiers } = data;
    const now = new Date();
    const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const noBdr = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };
    const lightBdr = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E0E0E0' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };

    const headerCell = (text, width) => new TableCell({
        width: { size: width, type: WidthType.PERCENTAGE },
        shading: { fill: NAVY },
        children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text, bold: true, color: WHITE, size: 16, font: 'Calibri' })]
        })]
    });

    const dataCell = (text, width, opts = {}) => new TableCell({
        width: { size: width, type: WidthType.PERCENTAGE },
        shading: opts.shading ? { fill: opts.shading } : undefined,
        borders: opts.borders || undefined,
        children: [new Paragraph({
            alignment: opts.align || AlignmentType.CENTER,
            spacing: { before: 30, after: 30 },
            children: [new TextRun({
                text: String(text),
                size: opts.size || 16,
                font: 'Calibri',
                bold: opts.bold || false,
                color: opts.color || '333333'
            })]
        })]
    });

    const sections = [];

    // ── Group Title ──
    sections.push(new Paragraph({
        spacing: { after: 80 },
        children: [
            new TextRun({ text: group_name.toUpperCase(), bold: true, color: NAVY, size: 36, font: 'Calibri' })
        ]
    }));

    sections.push(new Paragraph({
        spacing: { after: 40 },
        children: [
            new TextRun({ text: 'Group Pricing Review', color: GRAY_TEXT, size: 24, font: 'Calibri' }),
            new TextRun({ text: `   |   ${monthYear}`, color: GRAY_TEXT, size: 20, font: 'Calibri' })
        ]
    }));

    // Divider
    sections.push(new Paragraph({ spacing: { after: 150 }, border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: NAVY } } }));

    // ── Group Summary ──
    const totalCurrentMrr = rooftops.reduce((sum, r) => sum + (r.current_state?.mrr || 0), 0);
    const rooftopCount = rooftops.length;

    // Calculate group selected investment total
    let totalSelectedMrr = 0;
    rooftops.forEach(r => {
        const sel = r.selected_tier;
        const tp = r.tier_pricing?.[sel];
        if (tp) {
            totalSelectedMrr += r.custom_price || tp.recommended_price;
        } else {
            totalSelectedMrr += r.current_state?.mrr || 0;
        }
    });

    const groupChange = totalSelectedMrr - totalCurrentMrr;
    const groupChangeText = groupChange > 0 ? `+${fmt(groupChange)}` : groupChange < 0 ? fmt(groupChange) : 'No Change';
    const groupChangeColor = groupChange > 0 ? 'B91C1C' : groupChange < 0 ? GREEN : GRAY_TEXT;

    sections.push(new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({ text: 'GROUP OVERVIEW', bold: true, color: NAVY, size: 20, font: 'Calibri' })]
    }));

    const summaryRow = new TableRow({
        children: [
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Rooftops', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: String(rooftopCount), bold: true, size: 28, font: 'Calibri', color: NAVY })
                    ]})
                ]
            }),
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Current Group Monthly', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: fmt(totalCurrentMrr), bold: true, size: 28, font: 'Calibri', color: NAVY })
                    ]})
                ]
            }),
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Proposed Group Monthly', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: fmt(totalSelectedMrr), bold: true, size: 28, font: 'Calibri', color: GREEN })
                    ]})
                ]
            }),
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Monthly Change', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: groupChangeText, bold: true, size: 28, font: 'Calibri', color: groupChangeColor })
                    ]})
                ]
            })
        ]
    });

    sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: noBdr,
        rows: [summaryRow]
    }));

    sections.push(new Paragraph({ spacing: { after: 60 } }));

    // Annual totals
    sections.push(new Paragraph({
        spacing: { after: 200 },
        children: [
            new TextRun({ text: 'Annual Group Investment: ', color: GRAY_TEXT, size: 20, font: 'Calibri' }),
            new TextRun({ text: `${fmt(totalCurrentMrr * 12)} current`, color: GRAY_TEXT, size: 20, font: 'Calibri' }),
            new TextRun({ text: `  →  `, color: GRAY_TEXT, size: 20, font: 'Calibri' }),
            new TextRun({ text: fmt(totalSelectedMrr * 12), bold: true, color: GREEN, size: 22, font: 'Calibri' }),
            new TextRun({ text: ' proposed', color: GRAY_TEXT, size: 20, font: 'Calibri' })
        ]
    }));

    // ── Per-Rooftop Pricing ──
    sections.push(new Paragraph({
        spacing: { after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
        children: [new TextRun({ text: 'PRICING BY ROOFTOP', bold: true, color: NAVY, size: 20, font: 'Calibri' })]
    }));

    const allTiers = ['Protect', 'Enrich', 'Elevate', 'Control'];
    const visibleTiers = allTiers.filter(t => !hidden_tiers || !hidden_tiers.includes(t));
    const tierDescriptions = {
        'Protect': 'Credit + Compliance + Fraud',
        'Enrich': 'Protect + SmartPencil + Payments',
        'Elevate': 'Soft Pull + SmartPencil + Payments',
        'Control': 'Full HP + SP Suite + All Products'
    };

    // Build per-rooftop tables
    rooftops.forEach((rooftop, idx) => {
        const {
            customer_name, current_state, tier_pricing,
            selected_tier, recommended_tier, custom_price
        } = rooftop;

        const currentMrr = current_state?.mrr || 0;
        const currentPkg = current_state?.package || 'Credit';
        const bureauConfig = current_state?.bureau_config || 'N/A';

        // Rooftop header
        if (idx > 0) {
            sections.push(new Paragraph({ spacing: { after: 100 } }));
        }

        // Rooftop name with current state inline
        sections.push(new Paragraph({
            spacing: { before: idx > 0 ? 200 : 60, after: 40 },
            children: [
                new TextRun({ text: `${idx + 1}. ${customer_name}`, bold: true, size: 20, font: 'Calibri', color: NAVY }),
                new TextRun({ text: `    ${currentPkg}  |  ${fmt(currentMrr)}/mo  |  ${bureauConfig}`, size: 16, font: 'Calibri', color: GRAY_TEXT })
            ]
        }));

        // Compact tier table for this rooftop
        const colWidths = [24, 18, 18, 18, 22];

        const tierHeader = new TableRow({
            children: [
                headerCell('Package', colWidths[0]),
                headerCell('Monthly', colWidths[1]),
                headerCell('Annual', colWidths[2]),
                headerCell('vs. Current', colWidths[3]),
                headerCell('Status', colWidths[4])
            ]
        });

        const tierRows = visibleTiers.map((tier, i) => {
            const t = tier_pricing?.[tier];
            if (!t) return null;
            const isRec = tier === recommended_tier;
            const isSel = tier === selected_tier;
            const price = (isSel && custom_price) ? custom_price : t.recommended_price;
            const bg = isRec ? GREEN_BG : (i % 2 === 1 ? GRAY_LIGHT : undefined);
            const priceChange = price - currentMrr;
            const changeText = priceChange > 0 ? `+${fmt(priceChange)}` : priceChange < 0 ? fmt(priceChange) : 'No Change';
            const changeColor = priceChange > 0 ? 'B91C1C' : priceChange < 0 ? GREEN : GRAY_TEXT;

            return new TableRow({
                children: [
                    new TableCell({
                        width: { size: colWidths[0], type: WidthType.PERCENTAGE },
                        shading: bg ? { fill: bg } : undefined,
                        children: [new Paragraph({
                            spacing: { before: 30, after: 30 },
                            children: [
                                new TextRun({ text: tier, bold: true, size: 16, font: 'Calibri', color: NAVY }),
                                ...(isRec ? [new TextRun({ text: ' ★', color: GREEN, size: 14, font: 'Calibri' })] : []),
                                ...(isSel ? [new TextRun({ text: ' ●', color: 'D97706', size: 14, font: 'Calibri' })] : [])
                            ]
                        })]
                    }),
                    dataCell(fmt(price), colWidths[1], { bold: true, shading: bg, color: isRec ? GREEN : NAVY }),
                    dataCell(fmt(price * 12), colWidths[2], { shading: bg, color: GRAY_TEXT }),
                    dataCell(changeText, colWidths[3], { shading: bg, color: changeColor, bold: true }),
                    new TableCell({
                        width: { size: colWidths[4], type: WidthType.PERCENTAGE },
                        shading: bg ? { fill: bg } : undefined,
                        children: [new Paragraph({
                            alignment: AlignmentType.CENTER,
                            spacing: { before: 30, after: 30 },
                            children: [new TextRun({
                                text: t.status || (t.gm_at_recommended >= 45 ? 'At Target' : t.gm_at_recommended >= 40 ? 'Near Target' : 'Needs Increase'),
                                size: 14, font: 'Calibri',
                                color: t.gm_at_recommended >= 45 ? GREEN : t.gm_at_recommended >= 40 ? 'B45309' : 'B91C1C'
                            })]
                        })]
                    })
                ]
            });
        }).filter(Boolean);

        if (tierRows.length > 0) {
            sections.push(new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [tierHeader, ...tierRows]
            }));
        }
    });

    // ── Group Total Summary ──
    sections.push(new Paragraph({ children: [new PageBreak()] }));

    sections.push(new Paragraph({
        spacing: { after: 80 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: NAVY } },
        children: [new TextRun({ text: 'GROUP PRICING SUMMARY', bold: true, color: NAVY, size: 22, font: 'Calibri' })]
    }));

    // Summary table: Rooftop | Current | Selected Tier | Proposed | Change
    const sumHeader = new TableRow({
        children: [
            headerCell('Rooftop', 30),
            headerCell('Current', 15),
            headerCell('Selected Package', 20),
            headerCell('Proposed', 15),
            headerCell('Change', 20)
        ]
    });

    const sumRows = rooftops.map((r, i) => {
        const currentMrr = r.current_state?.mrr || 0;
        const sel = r.selected_tier || 'N/A';
        const tp = r.tier_pricing?.[sel];
        const proposedPrice = (r.custom_price || tp?.recommended_price) || currentMrr;
        const change = proposedPrice - currentMrr;
        const changeText = change > 0 ? `+${fmt(change)}` : change < 0 ? fmt(change) : 'No Change';
        const changeColor = change > 0 ? 'B91C1C' : change < 0 ? GREEN : GRAY_TEXT;
        const bg = i % 2 === 1 ? GRAY_LIGHT : undefined;

        return new TableRow({
            children: [
                dataCell(r.customer_name, 30, { align: AlignmentType.LEFT, bold: true, shading: bg, size: 15 }),
                dataCell(fmt(currentMrr), 15, { shading: bg }),
                dataCell(sel, 20, { shading: bg, bold: true, color: NAVY }),
                dataCell(fmt(proposedPrice), 15, { shading: bg, bold: true, color: GREEN }),
                dataCell(changeText, 20, { shading: bg, bold: true, color: changeColor })
            ]
        });
    });

    // Total row
    const totalProposed = rooftops.reduce((sum, r) => {
        const tp = r.tier_pricing?.[r.selected_tier];
        return sum + ((r.custom_price || tp?.recommended_price) || r.current_state?.mrr || 0);
    }, 0);
    const totalChange = totalProposed - totalCurrentMrr;
    const totalChangeText = totalChange > 0 ? `+${fmt(totalChange)}` : totalChange < 0 ? fmt(totalChange) : 'No Change';
    const totalChangeColor = totalChange > 0 ? 'B91C1C' : totalChange < 0 ? GREEN : GRAY_TEXT;

    sumRows.push(new TableRow({
        children: [
            dataCell('GROUP TOTAL', 30, { align: AlignmentType.LEFT, bold: true, color: NAVY, size: 17 }),
            dataCell(fmt(totalCurrentMrr), 15, { bold: true, color: NAVY, size: 17 }),
            dataCell('', 20, {}),
            dataCell(fmt(totalProposed), 15, { bold: true, color: GREEN, size: 17 }),
            dataCell(totalChangeText, 20, { bold: true, color: totalChangeColor, size: 17 })
        ]
    }));

    sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [sumHeader, ...sumRows]
    }));

    // Annual totals
    sections.push(new Paragraph({ spacing: { before: 200, after: 40 } }));

    sections.push(new Paragraph({
        spacing: { after: 60 },
        children: [
            new TextRun({ text: 'Current Annual Group Investment:  ', color: GRAY_TEXT, size: 22, font: 'Calibri' }),
            new TextRun({ text: fmt(totalCurrentMrr * 12), bold: true, color: NAVY, size: 28, font: 'Calibri' })
        ]
    }));

    sections.push(new Paragraph({
        spacing: { after: 60 },
        children: [
            new TextRun({ text: 'Proposed Annual Group Investment:  ', color: GRAY_TEXT, size: 22, font: 'Calibri' }),
            new TextRun({ text: fmt(totalProposed * 12), bold: true, color: GREEN, size: 28, font: 'Calibri' })
        ]
    }));

    if (totalChange !== 0) {
        sections.push(new Paragraph({
            spacing: { after: 120 },
            children: [
                new TextRun({ text: 'Annual Change:  ', color: GRAY_TEXT, size: 22, font: 'Calibri' }),
                new TextRun({ text: `${totalChange > 0 ? '+' : ''}${fmt(totalChange * 12)}`, bold: true, color: totalChangeColor, size: 28, font: 'Calibri' })
            ]
        }));
    }

    // Disclosures
    sections.push(new Paragraph({
        spacing: { before: 300, after: 60 },
        children: [new TextRun({
            text: 'All prices are monthly flat rates. Unused pulls may be banked up to 20% of your allotment and applied in subsequent periods. Usage beyond your allotment after banking is billed at the current per-pull rate per your service agreement.',
            color: GRAY_TEXT, size: 14, font: 'Calibri', italics: true
        })]
    }));

    sections.push(new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({
            text: '*Implementation fees are charged separately per rooftop.',
            color: GRAY_TEXT, size: 14, font: 'Calibri'
        })]
    }));

    sections.push(new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({
            text: `${monthYear}  |  Confidential  |  Prepared for ${group_name}`,
            color: GRAY_TEXT, size: 14, font: 'Calibri', italics: true
        })]
    }));

    // ── Build Document ──
    const docHeaders = {};
    if (logoBuffer) {
        docHeaders.default = new Header({
            children: [new Paragraph({
                children: [new ImageRun({
                    data: logoBuffer,
                    transformation: { width: 180, height: 36 },
                    type: 'png'
                })]
            })]
        });
    }

    return new Document({
        sections: [{
            properties: {
                page: {
                    margin: {
                        top: convertInchesToTwip(logoBuffer ? 0.8 : 0.5),
                        bottom: convertInchesToTwip(0.5),
                        left: convertInchesToTwip(0.6),
                        right: convertInchesToTwip(0.6)
                    }
                }
            },
            headers: docHeaders,
            footers: {
                default: new Footer({
                    children: [new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new TextRun({
                            text: `${group_name} — Group Pricing Review  |  ${monthYear}  |  Confidential`,
                            color: GRAY_TEXT, size: 14, font: 'Calibri', italics: true
                        })]
                    })]
                })
            },
            children: sections
        }]
    });
}

// ── Handler ──
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
        loadLogo();
        const data = JSON.parse(event.body);

        if (!data.group_name || !data.rooftops || !Array.isArray(data.rooftops) || data.rooftops.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'group_name and rooftops array are required' }) };
        }

        const doc = buildGroupRepriceDoc(data);
        const buffer = await Packer.toBuffer(doc);
        const base64 = buffer.toString('base64');

        const filename = `${data.group_name} - Group Pricing Review.docx`;

        return {
            statusCode: 200,
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename,
                data: base64,
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            })
        };

    } catch (error) {
        console.error('Group reprice doc generation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Document generation failed: ' + error.message })
        };
    }
}
