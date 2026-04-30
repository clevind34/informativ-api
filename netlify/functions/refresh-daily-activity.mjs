// /api/refresh/daily-activity — recomputes daily activity metrics against latest gateway data
// April 30, 2026 — Node.js port of compute_daily_activity.py (subset)
//
// Triggered by a "Refresh" button on the Daily Activity Discipline section in PIE Dashboard.
// Reads sfdc-rep-summary.json and pie-feedback-log.json (both published to gateway data/ dir),
// recomputes per-rep today/yesterday/week/month totals + grades, writes daily-activity-metrics.json
// back to the gateway repo via GitHub API.

import { handleCors, corsHeaders } from './cors.mjs';
import { authenticateRequest } from './auth.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DAILY_TARGET = 50;
const GH_OWNER = 'clevind34';
const GH_REPO  = 'informativ-api';
const GH_DAILY_PATH = 'data/daily-activity-metrics.json';

function _grade(pct) {
    if (pct >= 80) return 'A';
    if (pct >= 60) return 'B';
    if (pct >= 40) return 'C';
    return 'D';
}
function _gradeColor(g) {
    return ({ A: '#10B981', B: '#3B82F6', C: '#F59E0B', D: '#DC2626' })[g] || '#94A3B8';
}
function _todayIso() {
    return new Date().toISOString().slice(0, 10);
}
function _dateOnly(s) { return s ? String(s).slice(0, 10) : ''; }

function _readDataFile(name) {
    // Files in /var/task/data when bundled via included_files
    const candidates = [
        join('/var/task/data', name),
        join(process.cwd(), 'data', name),
    ];
    for (const p of candidates) {
        try { return JSON.parse(readFileSync(p, 'utf-8')); } catch (e) {}
    }
    return null;
}

function _countDispositionsByRep(feedbackLog, targetDate) {
    const out = {};
    if (!Array.isArray(feedbackLog)) return out;
    for (const e of feedbackLog) {
        const rep = e.assigned_rep || e.rep;
        const d   = _dateOnly(e.date);
        if (rep && d === targetDate) out[rep] = (out[rep] || 0) + 1;
    }
    return out;
}

function _computeRep(repName, sfdcSummary, pieToday, pieYest) {
    const sfdc       = sfdcSummary[repName] || {};
    const activity   = sfdc.activity || {};
    const sfdcToday  = (activity.tasks_today || 0)     + (activity.events_today || 0);
    const pieT       = pieToday[repName] || 0;
    const todayTotal = sfdcToday + pieT;

    const sfdcYest   = (activity.tasks_yesterday || 0) + (activity.events_yesterday || 0);
    const pieY       = pieYest[repName] || 0;
    const yestTotal  = sfdcYest + pieY;

    const weekTotal  = (activity.tasks_week || 0)  + (activity.events_week || 0);
    const monthTotal = (activity.tasks_month || 0) + (activity.events_month || 0);

    const todayPct  = Math.min(100, Math.round((todayTotal  / DAILY_TARGET) * 1000) / 10);
    const yestPct   = Math.min(100, Math.round((yestTotal   / DAILY_TARGET) * 1000) / 10);
    const sevenPct  = Math.min(100, Math.round(((weekTotal  / 7)  / DAILY_TARGET) * 1000) / 10);
    const thirtyPct = Math.min(100, Math.round(((monthTotal / 30) / DAILY_TARGET) * 1000) / 10);

    const grade  = _grade(todayPct);
    const gradeW = _grade(sevenPct);

    const trend = todayPct > sevenPct + 5 ? 'up' : todayPct < sevenPct - 5 ? 'down' : 'stable';

    return {
        rep:    repName,
        today: {
            tasks:        activity.tasks_today  || 0,
            events:       activity.events_today || 0,
            dispositions: pieT,
            total:        todayTotal,
            target:       DAILY_TARGET,
            pct:          todayPct,
            grade:        grade,
            grade_color:  _gradeColor(grade),
        },
        yesterday: {
            tasks:        activity.tasks_yesterday  || 0,
            events:       activity.events_yesterday || 0,
            dispositions: pieY,
            total:        yestTotal,
            target:       DAILY_TARGET,
            pct:          yestPct,
            grade:        _grade(yestPct),
        },
        week: {
            total:        weekTotal,
            avg_per_day:  Math.round((weekTotal / 7) * 10) / 10,
            avg_pct:      sevenPct,
            grade:        gradeW,
            grade_color:  _gradeColor(gradeW),
        },
        month: {
            total:        monthTotal,
            avg_per_day:  Math.round((monthTotal / 30) * 10) / 10,
            avg_pct:      thirtyPct,
            grade:        _grade(thirtyPct),
        },
        trend:        trend,
        pattern:      sfdc.pattern,
        hygiene_flag: sfdc.hygiene_flag,
    };
}

async function _writeToGitHub(content) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not set');
    // Get existing SHA
    const getRes = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DAILY_PATH}`, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    });
    let sha = null;
    if (getRes.ok) sha = (await getRes.json()).sha;
    // Encode + commit
    const body = {
        message: `Refresh daily-activity-metrics (manual trigger ${new Date().toISOString()})`,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    };
    if (sha) body.sha = sha;
    const putRes = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_DAILY_PATH}`, {
        method: 'PUT',
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!putRes.ok) {
        const txt = await putRes.text();
        throw new Error(`GitHub PUT failed: ${putRes.status} ${txt}`);
    }
    return await putRes.json();
}

export const handler = async (event) => {
    const corsCheck = handleCors(event);
    if (corsCheck) return corsCheck;
    const authCheck = authenticateRequest(event);
    if (authCheck) return authCheck;
    const _cors = corsHeaders((event.headers || {}).origin || '');

    try {
        const sfdcSummaryFile = _readDataFile('sfdc-rep-summary.json');
        const feedbackLog     = _readDataFile('pie-feedback-log.json') || [];
        if (!sfdcSummaryFile) {
            return { statusCode: 500, headers: _cors, body: JSON.stringify({ error: 'sfdc-rep-summary.json not available on gateway' }) };
        }

        // Build by-rep dict from rep_summaries array
        const byRepSrc = {};
        for (const r of (sfdcSummaryFile.rep_summaries || [])) byRepSrc[r.rep] = r;

        const today = _todayIso();
        const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const pieToday = _countDispositionsByRep(feedbackLog, today);
        const pieYest  = _countDispositionsByRep(feedbackLog, yest);

        const byRep = {};
        for (const repName of Object.keys(byRepSrc)) {
            byRep[repName] = _computeRep(repName, byRepSrc, pieToday, pieYest);
        }

        const sortedToday = Object.values(byRep).sort((a, b) => b.today.pct - a.today.pct);
        const top3 = sortedToday.slice(0, 3).filter(r => r.today.pct > 0).map(r => r.rep);
        const behind = sortedToday.filter(r => r.today.pct < 40).slice(-3).map(r => r.rep);

        const orgTotal = Object.values(byRep).reduce((s, r) => s + r.today.total, 0);
        const orgPct   = Object.values(byRep).reduce((s, r) => s + r.today.pct, 0) / Math.max(Object.keys(byRep).length, 1);

        const result = {
            computed_at: new Date().toISOString(),
            today: today,
            triggered_by: 'manual_refresh',
            config: { daily_target: DAILY_TARGET, grade_thresholds: { A: 80, B: 60, C: 40, D: 0 } },
            org_summary: {
                rep_count: Object.keys(byRep).length,
                today_total_actions: orgTotal,
                today_avg_pct: Math.round(orgPct * 10) / 10,
                top_3: top3,
                behind_today: behind,
            },
            by_rep: byRep,
        };

        await _writeToGitHub(result);

        return {
            statusCode: 200,
            headers: { ..._cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                computed_at: result.computed_at,
                rep_count: Object.keys(byRep).length,
                org_today_pct: result.org_summary.today_avg_pct,
                org_today_total: orgTotal,
                top_3: top3,
                behind_today: behind,
            }),
        };
    } catch (e) {
        console.error('refresh-daily-activity error:', e);
        return {
            statusCode: 500,
            headers: { ..._cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: e.message }),
        };
    }
};
