/**
 * External Price Sheet DOCX Generator — Netlify Function
 * Takes pricing data with rep tier selections, generates a customer-facing DOCX.
 * Returns base64-encoded DOCX for client-side download.
 */

import { handleCors, corsHeaders } from './cors.mjs';
import { validateApiKey } from './auth.mjs';
import {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, WidthType, AlignmentType, BorderStyle, HeadingLevel,
    PageOrientation, SectionType, convertInchesToTwip, Footer,
    Header, ImageRun
} from 'docx';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load logo image for header
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

function fmt(num) {
    return '$' + Math.round(num).toLocaleString('en-US');
}

function buildExternalDoc(data) {
    const { group_name, contact_name, stores } = data;
    const now = new Date();
    const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    let totalMonthly = 0;
    let totalVehicles = 0;
    let totalHardPulls = 0;
    let totalSoftPulls = 0;
    let totalImplFee = 0;
    const hasImplFees = stores.some(s => s.implementation_fee > 0);

    // Calculate totals — only count pulls actually included in each store's selected package
    // Protect/Enrich = hard-pull-only packages, Elevate = soft-pull-only, Control = both
    for (const store of stores) {
        const pkg = store.selected_package || store.recommended;
        totalMonthly += store.tiers[pkg].price;
        totalVehicles += store.vehicles_sold;
        // Only count pulls that are part of the selected package
        if (pkg === 'Protect' || pkg === 'Enrich' || pkg === 'Control') {
            totalHardPulls += store.hard_pulls || 0;
        }
        if (pkg === 'Elevate' || pkg === 'Control') {
            totalSoftPulls += store.soft_pulls || 0;
        }
        totalImplFee += store.implementation_fee || 0;
    }

    const totalAnnual = totalMonthly * 12;

    // Header cells helper
    const headerCell = (text, width) => new TableCell({
        width: { size: width, type: WidthType.PERCENTAGE },
        shading: { fill: NAVY },
        children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text, bold: true, color: WHITE, size: 18, font: 'Calibri' })]
        })]
    });

    // Data cells helper
    const dataCell = (text, width, opts = {}) => new TableCell({
        width: { size: width, type: WidthType.PERCENTAGE },
        shading: opts.shading ? { fill: opts.shading } : undefined,
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

    // Build pricing rows — only show pull types included in each store's selected package
    // Protect/Enrich = hard-pull-only (soft pulls show "—")
    // Elevate = soft-pull-only (hard pulls show "—")
    // Control = both
    const pricingRows = stores.map((store, i) => {
        const pkg = store.selected_package || store.recommended;
        const price = store.tiers[pkg].price;
        const bg = i % 2 === 1 ? GRAY_LIGHT : undefined;

        const showHardPulls = (pkg === 'Protect' || pkg === 'Enrich' || pkg === 'Control');
        const showSoftPulls = (pkg === 'Elevate' || pkg === 'Control');

        return new TableRow({
            children: [
                dataCell(store.dealership_name, 25, { align: AlignmentType.LEFT, bold: true, shading: bg }),
                dataCell(String(store.vehicles_sold), 13, { shading: bg }),
                dataCell(showHardPulls ? String(store.hard_pulls || 0) : '\u2014', 13, { shading: bg }),
                dataCell(showSoftPulls ? String(store.soft_pulls || 0) : '\u2014', 13, { shading: bg }),
                dataCell(pkg, 16, { bold: true, shading: bg }),
                dataCell(fmt(price), 20, { bold: true, shading: bg })
            ]
        });
    });

    // Total row — show totals only for pull types that have values (non-zero)
    const totalRow = new TableRow({
        children: [
            dataCell('TOTAL', 25, { bold: true, align: AlignmentType.LEFT }),
            dataCell(String(totalVehicles), 13, { bold: true }),
            dataCell(totalHardPulls > 0 ? String(totalHardPulls) : '\u2014', 13, { bold: true }),
            dataCell(totalSoftPulls > 0 ? String(totalSoftPulls) : '\u2014', 13, { bold: true }),
            dataCell('', 16),
            dataCell(fmt(totalMonthly), 20, { bold: true, color: NAVY })
        ]
    });

    const sections = [];

    // Title
    sections.push(new Paragraph({
        spacing: { after: 100 },
        children: [
            new TextRun({ text: group_name.toUpperCase(), bold: true, color: NAVY, size: 32, font: 'Calibri' }),
            new TextRun({ text: `   Custom Pricing for ${contact_name}`, color: GRAY_TEXT, size: 24, font: 'Calibri' })
        ]
    }));

    // Divider line
    sections.push(new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } } }));

    // Annual Investment
    sections.push(new Paragraph({
        spacing: { after: 80 },
        children: [
            new TextRun({ text: 'Annual Investment: ', color: GRAY_TEXT, size: 22, font: 'Calibri' }),
            new TextRun({ text: fmt(totalAnnual), bold: true, color: NAVY, size: 32, font: 'Calibri' })
        ]
    }));

    // Summary stats — only include pull types that are present in the selected packages
    const statParts = [`${stores.length} Dealerships`, `${totalVehicles} Vehicles/Mo`];
    if (totalHardPulls > 0) statParts.push(`${totalHardPulls} Hard Pulls`);
    if (totalSoftPulls > 0) statParts.push(`${totalSoftPulls} Soft Pulls`);

    sections.push(new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({
            text: statParts.join('  |  '),
            color: GRAY_TEXT, size: 18, font: 'Calibri'
        })]
    }));

    // Subtext
    sections.push(new Paragraph({
        spacing: { after: 300 },
        children: [new TextRun({
            text: `All prices are monthly flat rates  |  ${monthYear}  |  Confidential`,
            color: GRAY_TEXT, size: 16, font: 'Calibri'
        })]
    }));

    // Pricing table
    const pricingTable = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
            new TableRow({
                children: [
                    headerCell('Dealership', 25),
                    headerCell('Vehicles / Mo', 13),
                    headerCell('Hard Pulls', 13),
                    headerCell('Soft Pulls', 13),
                    headerCell('Package', 16),
                    headerCell('Monthly Investment', 20)
                ]
            }),
            ...pricingRows,
            totalRow
        ]
    });

    sections.push(pricingTable);

    // Implementation fees section
    if (hasImplFees) {
        sections.push(new Paragraph({ spacing: { before: 300, after: 100 }, children: [
            new TextRun({ text: 'Implementation Fees', bold: true, color: NAVY, size: 22, font: 'Calibri' })
        ]}));

        const implRows = stores.filter(s => s.implementation_fee > 0).map(store =>
            new TableRow({ children: [
                dataCell(store.dealership_name, 60, { align: AlignmentType.LEFT }),
                dataCell(fmt(store.implementation_fee), 40, { bold: true })
            ]})
        );

        implRows.push(new TableRow({ children: [
            dataCell('Total Implementation', 60, { bold: true, align: AlignmentType.LEFT }),
            dataCell(fmt(totalImplFee), 40, { bold: true, color: NAVY })
        ]}));

        sections.push(new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
                new TableRow({ children: [
                    headerCell('Dealership', 60),
                    headerCell('Implementation Fee', 40)
                ]}),
                ...implRows
            ]
        }));
    }

    // Overage disclosure — adjust wording based on which pull types are present
    let pullTypePhrase;
    if (totalHardPulls > 0 && totalSoftPulls > 0) {
        pullTypePhrase = 'hard pulls and soft pulls';
    } else if (totalHardPulls > 0) {
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

    sections.push(new Paragraph({
        spacing: { before: 80 },
        children: [new TextRun({
            text: '*Implementation fees are charged separately per rooftop.',
            color: GRAY_TEXT, size: 16, font: 'Calibri'
        })]
    }));

    // ── ROI Section (if included and roi data present) ──
    if (data.include_roi !== false && data.roi) {
        const roi = data.roi;
        const t = roi.totals;
        const items = roi.line_items;

        // Collect sources for footnotes
        const sources = new Set();
        Object.values(items).forEach(li => { if (li.source) sources.add(li.source); });

        // ROI header
        sections.push(new Paragraph({
            spacing: { before: 400, after: 60 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
            children: [new TextRun({
                text: 'ESTIMATED RETURN ON INVESTMENT',
                bold: true, color: NAVY, size: 22, font: 'Calibri'
            })]
        }));

        // KPI summary row — centered numbers on navy band
        const GREEN = '1B7A3D';
        const NAVY_LIGHT = '2A3F6B';
        const noBdr = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };

        const kpiCell = (value, label, valueColor) => new TableCell({
            width: { size: 25, type: WidthType.PERCENTAGE },
            shading: { fill: NAVY },
            borders: noBdr,
            verticalAlign: 'center',
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

        // Spacer
        sections.push(new Paragraph({ spacing: { after: 120 } }));

        // Line items table — header row + 2-column paired layout with alternating shading
        const itemEntries = Object.values(items);
        const LINE_BDR_BOTTOM = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E0E0E0' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } };

        // Header row for line items
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
            const rowIdx = Math.floor(i / 2);
            const rowBg = rowIdx % 2 === 1 ? 'FAFAFA' : undefined;

            roiRows.push(new TableRow({
                children: [
                    new TableCell({
                        width: { size: 35, type: WidthType.PERCENTAGE },
                        shading: rowBg ? { fill: rowBg } : undefined,
                        borders: LINE_BDR_BOTTOM,
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
                        borders: LINE_BDR_BOTTOM,
                        verticalAlign: 'center',
                        children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 50, after: 50 }, children: [
                            new TextRun({ text: fmt(left.value), bold: true, size: 18, font: 'Calibri', color: GREEN })
                        ]})]
                    }),
                    new TableCell({
                        width: { size: 35, type: WidthType.PERCENTAGE },
                        shading: rowBg ? { fill: rowBg } : undefined,
                        borders: { ...LINE_BDR_BOTTOM, left: { style: BorderStyle.SINGLE, size: 1, color: 'E0E0E0' } },
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
                        borders: LINE_BDR_BOTTOM,
                        verticalAlign: 'center',
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

        // Sources footnote
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

    // Build header with logo if available
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
                            text: `Prepared for ${contact_name}, ${group_name}`,
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

        if (!data.stores || data.stores.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'No store data' }) };
        }

        const doc = buildExternalDoc(data);
        const buffer = await Packer.toBuffer(doc);
        const base64 = buffer.toString('base64');

        return {
            statusCode: 200,
            headers: {
                ...headers,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filename: `${data.group_name} - External Price Sheet.docx`,
                data: base64,
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            })
        };

    } catch (error) {
        console.error('Doc generation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Document generation failed: ' + error.message })
        };
    }
}
