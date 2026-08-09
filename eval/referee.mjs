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
import { execFileSync } from 'node:child_process';
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
    if (criterion.kind === 'loss') {
        const dropped = at(snapInv, criterion.item) - at(nowInv, criterion.item);
        return {
            verified: dropped >= criterion.count,
            expected: `-${criterion.count} ${criterion.item}`,
            observed: `${criterion.item}-${dropped} (have ${at(nowInv, criterion.item)}, started ${at(snapInv, criterion.item)})`,
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

// Bot position, parsed from !stats. Recorded alongside inventory so the world
// state in a receipt is not inventory-only: the 5x5 platform task cannot be
// judged after the fact precisely because no attempt recorded WHERE the bot
// was standing, which is also what a block-scan referee will need. Best-effort
// — a failed position read must never change a verdict, so it returns null.
async function readPosition() {
    try {
        const token = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8')).mcp_token;
        const res = await fetch(MCP_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 2, method: 'tools/call',
                params: { name: 'read_stats', arguments: {} },
            }),
            signal: AbortSignal.timeout(10_000),
        });
        const body = await res.json();
        if (body.error) return null;
        const text = body.result?.content?.[0]?.text ?? '';
        const m = text.match(/Position:\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+)/);
        return m ? { x: +m[1], y: +m[2], z: +m[3] } : null;
    } catch { return null; }
}

// Structure criteria — the shape the inventory parser cannot express. Matches
// "a 5x5 (25-block) cobblestone platform exists where the bot was standing".
// Returns { size, block } or null.
export function parseStructureCriterion(endFactor) {
    if (!endFactor) return null;
    const text = String(endFactor).toLowerCase();
    const dims = text.match(/(\d+)\s*[x×]\s*(\d+)/);
    if (!dims || dims[1] !== dims[2]) return null;   // square platforms only, for now
    const block = text.match(/\b([a-z_]+)\s+platform\b/);
    if (!block) return null;
    return { size: Number(dims[1]), block: block[1] };
}

// Delegate to the block scanner, which reads the SERVER's blocks over RCON.
// Returns a verdict in the same shape as the inventory path, or null when the
// scan cannot run — a scan that could not happen must fall back to the honor
// system, never invent a verdict.
function blockScanVerdict(structure, pos) {
    if (!pos) return null;
    try {
        const out = execFileSync('python3', [
            path.join(ROOT, 'eval', 'blockscan.py'),
            '--x', String(pos.x), '--y', String(pos.y), '--z', String(pos.z),
            '--size', String(structure.size), '--block', structure.block,
        ], { encoding: 'utf8', timeout: 120_000 });
        const v = JSON.parse(out.trim().split('\n').pop());
        return v && v.parseable ? v : null;
    } catch (e) {
        console.warn(`[referee] block scan failed: ${e.message}`);
        return null;
    }
}

// ── subcommands ──────────────────────────────────────────────────────────────

// Pre-add baseline: capture the inventory BEFORE the task-giver is invoked,
// so a task the bot can complete instantly (materials on hand) can't finish
// before the baseline exists. Field-trial run 3, task #341: +24 sticks crafted
// within ~4s of the add — the post-add snapshot already contained the result
// and the referee measured +0 on a genuinely completed task (false FAIL).
async function preinv() {
    const inventory = await readInventoryJson();
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'pre.json'), JSON.stringify({ inventory, ts: Date.now() }));
    process.stdout.write('ok\n');
}

async function snapshot(id) {
    const task = extractTaskFromLog(fs.readFileSync(QLOG, 'utf8'), id);
    if (!task) throw new Error(`no add line for task #${id} in queue.log`);
    let inventory = await readInventoryJson();
    let baseline = 'post-add';
    // Adopt a fresh pre-add read as the baseline when one exists (see preinv).
    // Staleness cap: a leftover pre.json from a crashed cycle must not become
    // some later task's baseline.
    const prePath = path.join(STATE_DIR, 'pre.json');
    try {
        const pre = JSON.parse(fs.readFileSync(prePath, 'utf8'));
        if (Date.now() - pre.ts < 120000) { inventory = pre.inventory; baseline = 'pre-add'; }
    } catch { /* no pre-read -> post-add baseline (biases toward false FAIL, never false pass) */ }
    fs.rmSync(prePath, { force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const position = await readPosition();
    const rec = { task_id: id, ...task, inventory, position, baseline, ts: new Date().toISOString() };
    fs.writeFileSync(path.join(STATE_DIR, `${id}.json`), JSON.stringify(rec, null, 2));
    // Echo essentials so loop.sh can capture description/end_factor from here.
    process.stdout.write(JSON.stringify({ description: task.description, end_factor: task.end_factor }) + '\n');
}

// Persist what the verdict was computed from. The verdict itself lives in the
// DB; this file is the ground truth a human labeller reads to judge the attempt
// independently (docs/paper/preregistration.md §5). Best-effort: a failed
// evidence write must never change a verdict.
function writeEvidence(id, snap, outcome, nowInv, verdict, nowPos) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(path.join(STATE_DIR, `${id}.evidence.json`), JSON.stringify({
            task_id: id,
            description: snap.description,
            end_factor: snap.end_factor,
            outcome,                       // the bot's own claim: done | cancel | timeout
            baseline: snap.baseline,
            ts_start: snap.ts,
            ts_judge: new Date().toISOString(),
            inv_start: snap.inventory,
            inv_end: nowInv,
            // World state is no longer inventory-only. Without these the 5x5
            // platform attempts could not be checked in-game afterwards — no
            // record of where to look — and a block-scan referee needs an
            // origin to scan around.
            pos_start: snap.position ?? null,
            pos_end: nowPos ?? null,
            verdict,                       // stripped before a card is rendered
        }, null, 2));
    } catch (e) { console.warn(`[referee] evidence write failed: ${e.message}`); }
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
    // Read the final inventory before branching on the criterion: the verdict
    // needs it only when the criterion parses, but the evidence file wants it
    // either way — an unparseable criterion (the 5x5 platform) is exactly the
    // case where a human most needs to see what actually changed.
    let nowInv = null, readErr = null;
    try { nowInv = await readInventoryJson(); }
    catch (e) { readErr = e.message; }
    const nowPos = await readPosition();
    const finish = (verdict) => { writeEvidence(id, snap, outcome, nowInv, verdict, nowPos); return verdict; };
    if (!criterion) {
        // Not inventory-shaped. Before conceding to the honor system — the bot's
        // own word, the one thing this campaign exists not to trust — try the
        // block scanner. This is the only path by which the 5x5 platform task
        // has ever been machine-scored; every earlier attempt at it was
        // honor-system, and the owner abstained on all three blind cards
        // because the evidence recorded inventory only.
        const structure = parseStructureCriterion(snap.end_factor);
        if (structure) {
            // Scan around where the bot ENDED: the criterion says the platform
            // exists where it was standing, and a bot that built and then
            // wandered is scored on the structure, not on where it started.
            const v = blockScanVerdict(structure, nowPos || snap.position);
            if (v) return finish(v);
            return finish(honorSystem(
                `structure criterion, but the block scan could not run `
                + `(position ${nowPos || snap.position ? 'known' : 'unavailable'})`));
        }
        return finish(honorSystem('end_factor not an inventory-count shape'));
    }
    if (!nowInv) return finish(honorSystem(`inventory read failed: ${readErr}`));
    const v = evaluateCriterion(criterion, snap.inventory, nowInv);
    let referee_failure_mode = null;
    if (outcome === 'done' && !v.verified) referee_failure_mode = 'false_done_referee';
    if (outcome !== 'done' && v.verified) referee_failure_mode = 'queue_never_finished';
    return finish({
        parseable: true, success: v.verified, label_source: 'referee',
        expected: v.expected, observed: v.observed, referee_failure_mode,
    });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const [cmd, id, outcome] = process.argv.slice(2);
if (cmd === 'preinv') {
    preinv().catch(e => { console.error(`referee preinv failed: ${e.message}`); process.exit(1); });
} else if (cmd === 'snapshot' && id) {
    snapshot(id).catch(e => { console.error(`referee snapshot failed: ${e.message}`); process.exit(1); });
} else if (cmd === 'judge' && id && outcome) {
    judge(id, outcome).then(v => process.stdout.write(JSON.stringify(v) + '\n'))
        .catch(e => { console.error(`referee judge failed: ${e.message}`); process.exit(1); });
} else if (cmd) {
    console.error('usage: referee.mjs preinv | snapshot <taskid> | judge <taskid> <outcome>');
    process.exit(2);
}
