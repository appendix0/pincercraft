#!/usr/bin/env node
// eval/referee.mjs — independent success verdict for eval cycles.
//
// The eval loop used to label success = "did `finish #ID done` appear in
// queue.log" — i.e. the bot's own self-report. The bot-side finish gate
// (src/agent/verify.js) made that report much more honest, but the referee
// must not take the player's word: it shares the end_factor GRAMMAR with the
// bot (same parser, no drift) while doing its OWN measurement — its own
// inventory snapshot at task start, its own re-read and verdict at the end,
// over the bot's MCP. No LLM involved; costs zero tokens.
//
// Usage (from repo root, wired into eval/loop.sh):
//   node eval/referee.mjs snapshot <taskid>            → writes eval/.referee/<id>.json
//   node eval/referee.mjs judge    <taskid> <outcome>  → one-line JSON verdict on stdout
//
// Verdict shape:
//   { parseable, success, label_source: 'referee'|'honor_system',
//     expected, observed, referee_failure_mode|null, note? }
// When the end_factor doesn't parse to an inventory shape (build/goto/chat
// criteria) the label falls back to the queue outcome, marked honor_system so
// those rows are visibly second-class in the DB.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEndFactorCriterion } from '../src/agent/verify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QLOG = path.join(ROOT, 'queue.log');
const STATE_DIR = path.join(ROOT, 'eval', '.referee');
const MCP_URL = 'http://127.0.0.1:8765/mcp';

// ── pure helpers (exported for test/referee_offline.mjs) ────────────────────

// Find the add/add+start line for task #id and pull description + end_factor.
// Both are JSON-encoded strings; ef= trails the description (task_queue._log).
export function extractTaskFromLog(logText, id) {
    const re = new RegExp(`\\[[^\\]]+\\] (?:add|add\\+start) #${id} \\S+ (".*?(?<!\\\\)")(?: ef=(".*"))?\\s*$`);
    for (const line of logText.split('\n')) {
        const m = line.match(re);
        if (!m) continue;
        try {
            return { description: JSON.parse(m[1]), end_factor: m[2] ? JSON.parse(m[2]) : null };
        } catch { return null; }
    }
    return null;
}

// Verdict from a parsed criterion + two inventory maps ({name: count}).
export function evaluateCriterion(criterion, snapInv, nowInv) {
    const at = (inv, item) => (inv && inv[item]) || 0;
    if (criterion.kind === 'delta') {
        const gained = at(nowInv, criterion.item) - at(snapInv, criterion.item);
        return {
            verified: gained >= criterion.count,
            expected: `+${criterion.count} ${criterion.item}`,
            observed: `${criterion.item}+${gained} (have ${at(nowInv, criterion.item)}, started ${at(snapInv, criterion.item)})`,
        };
    }
    if (criterion.kind === 'absolute') {
        const have = at(nowInv, criterion.item);
        return {
            verified: have >= criterion.count,
            expected: `${criterion.count} ${criterion.item} in inventory`,
            observed: `${criterion.item}=${have}`,
        };
    }
    if (criterion.kind === 'multi') {
        const missing = criterion.items.filter(i => at(nowInv, i) < 1);
        return {
            verified: missing.length === 0,
            expected: `${criterion.items.join(', ')} in inventory`,
            observed: missing.length ? `missing: ${missing.join(', ')}` : 'all present',
        };
    }
    return null;
}

// ── MCP inventory read ──────────────────────────────────────────────────────

async function readInventoryJson() {
    const token = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8')).mcp_token;
    const res = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'read_inventory_json', arguments: {} },
        }),
        signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json();
    if (body.error) throw new Error(`MCP error: ${body.error.message}`);
    return JSON.parse(body.result.content[0].text);
}

// ── subcommands ──────────────────────────────────────────────────────────────

async function snapshot(id) {
    const task = extractTaskFromLog(fs.readFileSync(QLOG, 'utf8'), id);
    if (!task) throw new Error(`no add line for task #${id} in queue.log`);
    const inventory = await readInventoryJson();
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const rec = { task_id: id, ...task, inventory, ts: new Date().toISOString() };
    fs.writeFileSync(path.join(STATE_DIR, `${id}.json`), JSON.stringify(rec, null, 2));
    // Echo essentials so loop.sh can capture description/end_factor from here.
    process.stdout.write(JSON.stringify({ description: task.description, end_factor: task.end_factor }) + '\n');
}

async function judge(id, outcome) {
    const honorSystem = (note) => ({
        parseable: false, success: outcome === 'done', label_source: 'honor_system',
        expected: null, observed: null, referee_failure_mode: null, ...(note ? { note } : {}),
    });
    let snap;
    try { snap = JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${id}.json`), 'utf8')); }
    catch { return honorSystem('no snapshot for this task'); }
    const criterion = parseEndFactorCriterion(snap.end_factor);
    if (!criterion) return honorSystem('end_factor not an inventory-count shape');
    let nowInv;
    try { nowInv = await readInventoryJson(); }
    catch (e) { return honorSystem(`inventory read failed: ${e.message}`); }
    const v = evaluateCriterion(criterion, snap.inventory, nowInv);
    let referee_failure_mode = null;
    if (outcome === 'done' && !v.verified) referee_failure_mode = 'false_done_referee';
    if (outcome !== 'done' && v.verified) referee_failure_mode = 'queue_never_finished';
    return {
        parseable: true, success: v.verified, label_source: 'referee',
        expected: v.expected, observed: v.observed, referee_failure_mode,
    };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const [cmd, id, outcome] = process.argv.slice(2);
if (cmd === 'snapshot' && id) {
    snapshot(id).catch(e => { console.error(`referee snapshot failed: ${e.message}`); process.exit(1); });
} else if (cmd === 'judge' && id && outcome) {
    judge(id, outcome).then(v => process.stdout.write(JSON.stringify(v) + '\n'))
        .catch(e => { console.error(`referee judge failed: ${e.message}`); process.exit(1); });
} else if (cmd) {
    console.error('usage: referee.mjs snapshot <taskid> | judge <taskid> <outcome>');
    process.exit(2);
}
