/**
 * Reprice External Price Sheet DOCX Generator — Netlify Function
 * Generates a customer-facing reprice document with:
 *   - Client's Original Monthly Price and Current Package
 *   - Current Bureau Configuration
 *   - All 4 tier options (Protect, Enrich, Elevate, Control) with recommended highlighted
 *   - New Monthly Investment for each option
 *   - ROI savings analysis
 *
 * Returns base64-encoded DOCX for client-side download.
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { logRequest } from './audit-log.mjs';
import {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, WidthType, AlignmentType, BorderStyle,
    convertInchesToTwip, Footer, Header, ImageRun
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
const AMBER_TEXT = '92400E';

function fmt(num) {
    return '$' + Math.round(num).toLocaleString('en-US');
}

function fmtPct(num) {
    return num.toFixed(1) + '%';
}

function buildRepriceDoc(data) {
    const {
        customer_name, group_name, current_state, bureau_volumes,
        tier_pricing, selected_tier, roi, estimated_vehicles,
        contact_name
    } = data;

    const now = new Date();
    const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const displayName = group_name || customer_name;
    const displayContact = contact_name || customer_name;

    // Selected tier data
    const selectedTierData = tier_pricing[selected_tier];
    const selectedPrice = selectedTierData.recommended_price;
    const annualInvestment = selectedPrice * 12;

    // Pull totals based on selected package
    const totalHp = bureau_volumes.hard_pulls.total;
    const totalSp = bureau_volumes.soft_pulls.total;

    // Which pulls to show based on selected tier
    const showHardPulls = ['Protect', 'Enrich', 'Control'].includes(selected_tier);
    const showSoftPulls = ['Elevate', 'Control'].includes(selected_tier);

    const noBdr = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };
    const lightBdr = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E0E0E0' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };

    // ── Helper cells ──
    const headerCell = (text, width) => new TableCell({
        width: { size: width, type: WidthType.PERCENTAGE },
        shading: { fill: NAVY },
        children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text, bold: true, color: WHITE, size: 18, font: 'Calibri' })]
        })]
    });

    const dataCell = (text, width, opts = {}) => new TableCell({
        width: { size: width, type: WidthType.PERCENTAGE },
        shading: opts.shading ? { fill: opts.shading } : undefined,
        borders: opts.borders || undefined,
        children: [new Paragraph({
            alignment: opts.align || AlignmentType.CENTER,
            children: [new TextRun({
                text: String(text),
                size: opts.size || 18,
                font: 'Calibri',
                bold: opts.bold || false,
                color: opts.color || '333333'
            })]
        })]
    });

    const sections = [];

    // ── Title ──
    sections.push(new Paragraph({
        spacing: { after: 100 },
        children: [
            new TextRun({ text: displayName.toUpperCase(), bold: true, color: NAVY, size: 32, font: 'Calibri' }),
            new TextRun({ text: `   Pricing Review for ${displayContact}`, color: GRAY_TEXT, size: 24, font: 'Calibri' })
        ]
    }));

    // Divider
    sections.push(new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } } }));

    // ── Current Account Summary ──
    sections.push(new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({
            text: 'CURRENT ACCOUNT',
            bold: true, color: NAVY, size: 20, font: 'Calibri'
        })]
    }));

    // Current state table — 2x2 grid
    const currentStateRow1 = new TableRow({
        children: [
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Current Monthly Investment', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: fmt(current_state.mrr), bold: true, size: 24, font: 'Calibri', color: NAVY })
                    ]})
                ]
            }),
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Current Package', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: current_state.package || 'Unknown', bold: true, size: 24, font: 'Calibri', color: NAVY })
                    ]})
                ]
            }),
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Bureau Configuration', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: current_state.bureau_config || 'N/A', bold: true, size: 20, font: 'Calibri', color: NAVY })
                    ]})
                ]
            }),
            new TableCell({
                width: { size: 25, type: WidthType.PERCENTAGE },
                borders: lightBdr,
                children: [
                    new Paragraph({ spacing: { before: 40, after: 10 }, children: [
                        new TextRun({ text: 'Monthly Pull Volume', size: 14, font: 'Calibri', color: GRAY_TEXT })
                    ]}),
                    new Paragraph({ spacing: { after: 40 }, children: [
                        new TextRun({ text: `${totalHp > 0 ? totalHp + ' HP' : ''}${totalHp > 0 && totalSp > 0 ? ' / ' : ''}${totalSp > 0 ? totalSp + ' SP' : ''}`, bold: true, size: 20, font: 'Calibri', color: NAVY })
                    ]})
                ]
            })
        ]
    });

    sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: noBdr,
        rows: [currentStateRow1]
    }));

    // ── Bureau Usage Detail ──
    // Show monthly average pulls by bureau — this is the data driving the COGS calculation
    if (data.bureau_detail) {
        const bd = data.bureau_detail;

        sections.push(new Paragraph({ spacing: { before: 200, after: 60 } }));

        sections.push(new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({
                text: 'BUREAU USAGE DETAIL',
                bold: true, color: NAVY, size: 20, font: 'Calibri'
            })]
        }));

        sections.push(new Paragraph({
            spacing: { after: 100 },
            children: [new TextRun({
                text: `Monthly averages based on ${bd.months_averaged || 3}-month trailing usage data.`,
                color: GRAY_TEXT, size: 14, font: 'Calibri'
            })]
        }));

        // Bureau table: Bureau | Hard Pulls/Mo | Soft Pulls/Mo
        const bureauHeaderRow = new TableRow({
            children: [
                headerCell('Bureau', 34),
                headerCell('Hard Pulls / Mo', 33),
                headerCell('Soft Pulls / Mo', 33)
            ]
        });

        const bureauNames = [
            { key: 'equifax', label: 'Equifax (EQF)' },
            { key: 'experian', label: 'Experian (EXP)' },
            { key: 'transunion', label: 'TransUnion (TU)' }
        ];

        const bureauRows = bureauNames.map((bureau, i) => {
            const bg = i % 2 === 1 ? GRAY_LIGHT : undefined;
            const hp = bd[bureau.key + '_hp'] || 0;
            const sp = bd[bureau.key + '_sp'] || 0;
            return new TableRow({
                children: [
                    dataCell(bureau.label, 34, { align: AlignmentType.LEFT, bold: true, shading: bg }),
                    dataCell(hp > 0 ? hp.toLocaleString('en-US') : '\u2014', 33, { shading: bg, color: hp > 0 ? '333333' : GRAY_TEXT }),
                    dataCell(sp > 0 ? sp.toLocaleString('en-US') : '\u2014', 33, { shading: bg, color: sp > 0 ? '333333' : GRAY_TEXT })
                ]
            });
        });

        // Total row
        const totalBureauRow = new TableRow({
            children: [
                dataCell('TOTAL', 34, { align: AlignmentType.LEFT, bold: true }),
                dataCell(totalHp > 0 ? totalHp.toLocaleString('en-US') : '\u2014', 33, { bold: true, color: NAVY }),
                dataCell(totalSp > 0 ? totalSp.toLocaleString('en-US') : '\u2014', 33, { bold: true, color: NAVY })
            ]
        });

        sections.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [bureauHeaderRow, ...bureauRows, totalBureauRow]
        }));
    }

    // Spacer
    sections.push(new Paragraph({ spacing: { after: 200 } }));

    // ── Pricing Options Header ──
    sections.push(new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({
            text: 'PRICING OPTIONS',
            bold: true, color: NAVY, size: 20, font: 'Calibri'
        })]
    }));

    sections.push(new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({
            text: 'Based on your actual usage data, we recommend the highlighted package below.',
            color: GRAY_TEXT, size: 16, font: 'Calibri'
        })]
    }));

    // ── Tier Comparison Table ──
    // Only show tiers present in tier_pricing (hidden tiers are filtered out by frontend)
    const allTiers = ['Protect', 'Enrich', 'Elevate', 'Control'];
    const tiers = allTiers.filter(t => tier_pricing[t]);
    const tierDescriptions = {
        'Protect': 'Credit reporting, compliance, fraud prevention',
        'Enrich': 'Protect + SmartPencil pre-desking + Payments',
        'Elevate': 'Soft pull bureau + compliance + SmartPencil + Payments',
        'Control': 'Full HP + SP bureau suite + all products'
    };

    // Header row
    const tierTableHeader = new TableRow({
        children: [
            headerCell('Package', 24),
            headerCell('Includes', 34),
            headerCell('Monthly Investment', 24),
            headerCell('vs. Current', 18)
        ]
    });

    // Tier rows
    const tierRows = tiers.map((tier, i) => {
        const t = tier_pricing[tier];
        const isSelected = tier === selected_tier;
        const isRecommended = tier === data.recommended_tier;
        // Green highlight follows the RECOMMENDED tier (★), not the selected tier
        const bg = isRecommended ? GREEN_BG : (i % 2 === 1 ? GRAY_LIGHT : undefined);
        const priceChange = t.recommended_price - current_state.mrr;
        const changeText = priceChange > 0 ? `+${fmt(priceChange)}` : priceChange < 0 ? fmt(priceChange) : 'No Change';
        const changeColor = priceChange > 0 ? 'B91C1C' : priceChange < 0 ? GREEN : GRAY_TEXT;

        return new TableRow({
            children: [
                new TableCell({
                    width: { size: 24, type: WidthType.PERCENTAGE },
                    shading: bg ? { fill: bg } : undefined,
                    children: [
                        new Paragraph({ spacing: { before: 60, after: 10 }, children: [
                            new TextRun({ text: tier, bold: true, size: 20, font: 'Calibri', color: NAVY }),
                            ...(isRecommended ? [new TextRun({ text: '  ★', color: GREEN, size: 18, font: 'Calibri' })] : [])
                        ]}),
                        ...(isRecommended ? [new Paragraph({ spacing: { after: 40 }, children: [
                            new TextRun({ text: 'RECOMMENDED', bold: true, size: 12, font: 'Calibri', color: GREEN })
                        ]})] : [new Paragraph({ spacing: { after: 40 } })])
                    ]
                }),
                dataCell(tierDescriptions[tier], 34, { align: AlignmentType.LEFT, size: 15, color: GRAY_TEXT, shading: bg }),
                new TableCell({
                    width: { size: 24, type: WidthType.PERCENTAGE },
                    shading: bg ? { fill: bg } : undefined,
                    children: [new Paragraph({
                        alignment: AlignmentType.CENTER,
                        spacing: { before: 50, after: 50 },
                        children: [new TextRun({
                            text: fmt(t.recommended_price),
                            bold: true, size: 22, font: 'Calibri', color: isRecommended ? GREEN : NAVY
                        })]
                    })]
                }),
                new TableCell({
                    width: { size: 18, type: WidthType.PERCENTAGE },
                    shading: bg ? { fill: bg } : undefined,
                    children: [new Paragraph({
                        alignment: AlignmentType.CENTER,
                        spacing: { before: 50, after: 50 },
                        children: [new TextRun({
                            text: changeText, size: 16, font: 'Calibri', color: changeColor, bold: true
                        })]
                    })]
                })
            ]
        });
    });

    sections.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [tierTableHeader, ...tierRows]
    }));

    // ── Selected Package Summary ──
    sections.push(new Paragraph({ spacing: { before: 300, after: 60 }, border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } } }));

    // Annual investment for selected
    sections.push(new Paragraph({
        spacing: { after: 80 },
        children: [
            new TextRun({ text: 'Your New Annual Investment: ', color: GRAY_TEXT, size: 22, font: 'Calibri' }),
            new TextRun({ text: fmt(annualInvestment), bold: true, color: NAVY, size: 32, font: 'Calibri' })
        ]
    }));

    // Summary stats for selected package
    const statParts = [];
    if (estimated_vehicles > 0) statParts.push(`${estimated_vehicles} Vehicles/Mo`);
    if (showHardPulls && totalHp > 0) statParts.push(`${totalHp} Hard Pulls`);
    if (showSoftPulls && totalSp > 0) statParts.push(`${totalSp} Soft Pulls`);

    if (statParts.length > 0) {
        sections.push(new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({
                text: `${selected_tier} Package  |  ${statParts.join('  |  ')}`,
                color: GRAY_TEXT, size: 18, font: 'Calibri'
            })]
        }));
    }

    sections.push(new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({
            text: `All prices are monthly flat rates  |  ${monthYear}  |  Confidential`,
            color: GRAY_TEXT, size: 16, font: 'Calibri'
        })]
    }));

    // ── ROI Section (forced to new page so it never splits) ──
    if (roi) {
        const t = roi.totals;
        const items = roi.line_items;
        const sources = new Set();
        Object.values(items).forEach(li => { if (li.source) sources.add(li.source); });

        sections.push(new Paragraph({
            pageBreakBefore: true,
            spacing: { after: 60 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
            children: [new TextRun({
                text: 'ESTIMATED RETURN ON INVESTMENT',
                bold: true, color: NAVY, size: 22, font: 'Calibri'
            })]
        }));

        // KPI strip
        const kpiCell = (value, label, valueColor) => new TableCell({
            width: { size: 25, type: WidthType.PERCENTAGE },
            shading: { fill: NAVY },
            borders: noBdr,
            children: [
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 80, after: 20 }, children: [
                    new TextRun({ text: value, bold: true, color: valueColor || WHITE, size: 28, font: 'Calibri' })
                ]}),
                new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [
                    new TextRun({ text: label, color: 'B0BEC5', size: 14, font: 'Calibri' })
                ]})
            ]
        });

        sections.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: noBdr,
            rows: [new TableRow({
                children: [
                    kpiCell(fmt(t.total_annual_savings), 'Est. Annual Savings', '8BC34A'),
                    kpiCell(fmt(t.net_savings), 'Net Savings (Year 1)', '8BC34A'),
                    kpiCell(`${t.roi_pct}%`, 'Return on Investment'),
                    kpiCell(t.payback_months ? `${t.payback_months} mo` : 'N/A', 'Payback Period')
                ]
            })]
        }));

        sections.push(new Paragraph({ spacing: { after: 120 } }));

        // ROI line items — 2-column paired layout
        const liHeaderCell = (text, width, hasLeftBorder) => new TableCell({
            width: { size: width, type: WidthType.PERCENTAGE },
            shading: { fill: 'F0F4F8' },
            borders: {
                top: { style: BorderStyle.NONE },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: NAVY },
                left: hasLeftBorder ? { style: BorderStyle.SINGLE, size: 1, color: 'E0E0E0' } : { style: BorderStyle.NONE },
                right: { style: BorderStyle.NONE }
            },
            children: [new Paragraph({ alignment: text === 'Est. Value' ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { before: 40, after: 40 }, children: [
                new TextRun({ text, bold: true, size: 15, font: 'Calibri', color: NAVY })
            ]})]
        });

        const LINE_BDR = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E0E0E0' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };

        const itemEntries = Object.values(items);
        const roiRows = [
            new TableRow({
                children: [
                    liHeaderCell('Savings Category', 35, false),
                    liHeaderCell('Est. Value', 15, false),
                    liHeaderCell('Savings Category', 35, true),
                    liHeaderCell('Est. Value', 15, false)
                ]
            })
        ];

        for (let i = 0; i < itemEntries.length; i += 2) {
            const left = itemEntries[i];
            const right = itemEntries[i + 1];
            const rowBg = Math.floor(i / 2) % 2 === 1 ? 'FAFAFA' : undefined;

            roiRows.push(new TableRow({
                children: [
                    new TableCell({
                        width: { size: 35, type: WidthType.PERCENTAGE },
                        shading: rowBg ? { fill: rowBg } : undefined,
                        borders: LINE_BDR,
                        children: [
                            new Paragraph({ spacing: { before: 50, after: 10 }, children: [
                                new TextRun({ text: left.label, bold: true, size: 16, font: 'Calibri', color: NAVY })
                            ]}),
                            new Paragraph({ spacing: { after: 50 }, children: [
                                new TextRun({ text: left.description, size: 13, font: 'Calibri', color: GRAY_TEXT })
                            ]})
                        ]
                    }),
                    new TableCell({
                        width: { size: 15, type: WidthType.PERCENTAGE },
                        shading: rowBg ? { fill: rowBg } : undefined,
                        borders: LINE_BDR,
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 50, after: 50 }, children: [
                            new TextRun({ text: fmt(left.value), bold: true, size: 18, font: 'Calibri', color: GREEN })
                        ]})]
                    }),
                    new TableCell({
                        width: { size: 35, type: WidthType.PERCENTAGE },
                        shading: rowBg ? { fill: rowBg } : undefined,
                        borders: { ...LINE_BDR, left: { style: BorderStyle.SINGLE, size: 1, color: 'E0E0E0' } },
                        children: right ? [
                            new Paragraph({ spacing: { before: 50, after: 10 }, children: [
                                new TextRun({ text: right.label, bold: true, size: 16, font: 'Calibri', color: NAVY })
                            ]}),
                            new Paragraph({ spacing: { after: 50 }, children: [
                                new TextRun({ text: right.description, size: 13, font: 'Calibri', color: GRAY_TEXT })
                            ]})
                        ] : [new Paragraph({})]
                    }),
                    new TableCell({
                        width: { size: 15, type: WidthType.PERCENTAGE },
                        shading: rowBg ? { fill: rowBg } : undefined,
                        borders: LINE_BDR,
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 50, after: 50 }, children: right ? [
                            new TextRun({ text: fmt(right.value), bold: true, size: 18, font: 'Calibri', color: GREEN })
                        ] : [] })]
                    })
                ]
            }));
        }

        sections.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: roiRows
        }));

        // Sources
        sections.push(new Paragraph({
            spacing: { before: 120 },
            children: [
                new TextRun({ text: 'Sources: ', bold: true, color: GRAY_TEXT, size: 14, font: 'Calibri', italics: true }),
                new TextRun({ text: [...sources].join(' · '), color: GRAY_TEXT, size: 14, font: 'Calibri', italics: true })
            ]
        }));

        // Disclaimer
        sections.push(new Paragraph({
            spacing: { before: 60 },
            children: [new TextRun({
                text: 'ROI estimates are based on industry benchmarks and conservative assumptions. Actual results may vary based on dealership operations and market conditions.',
                color: 'AAAAAA', size: 13, font: 'Calibri', italics: true
            })]
        }));
    }

    // ── Overage disclosure ──
    let pullTypePhrase;
    if (showHardPulls && showSoftPulls) {
        pullTypePhrase = 'hard pulls and soft pulls';
    } else if (showHardPulls) {
        pullTypePhrase = 'hard pulls';
    } else {
        pullTypePhrase = 'soft pulls';
    }

    sections.push(new Paragraph({
        spacing: { before: 300, after: 100 },
        children: [new TextRun({
            text: `Pricing reflects your monthly allotment of ${pullTypePhrase} shown above. Unused pulls may be banked up to 20% of your allotment and applied in subsequent periods. Usage beyond your allotment after banking is billed at the current per-pull rate per your service agreement.`,
            color: GRAY_TEXT, size: 16, font: 'Calibri', italics: true
        })]
    }));

    // Implementation disclaimer (mandatory)
    sections.push(new Paragraph({
        spacing: { before: 80 },
        children: [new TextRun({
            text: '*Implementation fees are charged separately per rooftop.',
            color: GRAY_TEXT, size: 16, font: 'Calibri'
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
                        left: convertInchesToTwip(0.75),
                        right: convertInchesToTwip(0.75)
                    }
                }
            },
            headers: docHeaders,
            footers: {
                default: new Footer({
                    children: [new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [new TextRun({
                            text: `Prepared for ${displayContact}, ${displayName}  |  ${monthYear}`,
                            color: GRAY_TEXT, size: 16, font: 'Calibri', italics: true
                        })]
                    })]
                })
            },
            children: sections
        }]
    });
}

// ── Handler ──
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
        loadLogo();
        const data = JSON.parse(event.body);

        if (!data.customer_name || !data.tier_pricing || !data.selected_tier) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'customer_name, tier_pricing, and selected_tier are required' }) };
        }

        const doc = buildRepriceDoc(data);
        const buffer = await Packer.toBuffer(doc);
        const base64 = buffer.toString('base64');

        const filename = `${data.group_name || data.customer_name} - Pricing Review.docx`;

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
        console.error('Reprice doc generation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Document generation failed: ' + error.message })
        };
    }
}

// Phase 2B-3: Audit log wrapper
export async function handler(event) {
  const response = await _handler(event);
  logRequest(event, response);
  return response;
}
