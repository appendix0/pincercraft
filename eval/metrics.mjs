// eval/metrics.mjs — task metrics for Daedelus404 runs. No dependencies.
//
// Two metric tracks:
//   A) success/failure  — did the bot solve it, at what token cost (⋈ queue.log)
//   B) efficiency       — tokens per unit of WORK done (tokens / block op),
//                         plus compaction + cache signals. This is the metric
//                         that tells you whether a structure / pipeline /
//                         context-compaction change actually helped.
//
// Inputs come from the bot's stdout log:
//   cost lines:  [cost] kind=convo input=331 output=5 cache_read=6276 cache_creation=7129 | total_turns=1 ...
//   work lines (from src/agent/library/skills.js, anchored at col 0):
//     Placed <type> at (...)            → 1 block placed
//     Placed all <N> blocks.            → N placed   |  Placed <N>/<M> blocks   → N placed
//     Broke <name> at x:...             → 1 broken
//     Mined <name> at ... collected ... → 1 mined
//     Dug ...                           → 1 dug
//     Collected <N> <type>.             → N items gathered (not a block op)
//
// `total_*` on cost lines is one global counter that RESETS on restart
// (total_turns decreases). Per-line input/output/cache_* are what we sum in a
// window. A window is scoped either by exact bot.log line range (live loop,
// summarizeRange) or by the inline `task #N` marker (historical,
// perTaskFromMarkers).

import { readFileSync } from 'node:fs';

// Approx Anthropic pricing, USD/1M tokens. Override via PINCER_PRICE_* env.
// Bot mixes Haiku planner + Sonnet coder, so $ is an estimate; trust tokens.
const PRICE = {
    input:          Number(process.env.PINCER_PRICE_INPUT          ?? 3.00),
    output:         Number(process.env.PINCER_PRICE_OUTPUT         ?? 15.00),
    cache_read:     Number(process.env.PINCER_PRICE_CACHE_READ     ?? 0.30),
    cache_creation: Number(process.env.PINCER_PRICE_CACHE_CREATION ?? 3.75),
};

const COST_RE  = /^\[cost\] kind=(\w+) input=(\d+) output=(\d+) cache_read=(\d+) cache_creation=(\d+) \| total_turns=(\d+)/;
const TASK_RE  = /task #(\d+)/;
const QUEUE_RE = /\] (\w+) #(\d+) (\w+)/;

// Work-event matchers. Order matters: batch "Placed" before single "Placed".
const WORK = [
    { type: 'place',   re: /^Placed all (\d+) blocks/,        count: m => +m[1] },
    { type: 'place',   re: /^Placed (\d+)\/\d+ blocks/,       count: m => +m[1] },
    { type: 'place',   re: /^Placed \w+ at /,                 count: () => 1 },
    { type: 'break',   re: /^Broke \w+ at /,                  count: () => 1 },
    { type: 'mine',    re: /^Mined \w+ at /,                  count: () => 1 },
    { type: 'dig',     re: /^Dug \w+ at /,                    count: () => 1 },
    { type: 'collect', re: /^Collected (\d+) \w+\./,          count: m => +m[1] },
];

// Single pass: cost records + work events, each tagged with line number and
// the most recent inline `task #N` marker above it.
export function parseLog(text) {
    const cost = [], work = [];
    let curTask = null;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const t = line.match(TASK_RE);
        if (t) curTask = Number(t[1]);

        const c = line.match(COST_RE);
        if (c) {
            cost.push({
                line: i + 1, kind: c[1],
                input: +c[2], output: +c[3], cache_read: +c[4], cache_creation: +c[5],
                total_turns: +c[6], task: curTask,
            });
            continue;
        }
        for (const w of WORK) {
            const m = line.match(w.re);
            if (m) { work.push({ line: i + 1, type: w.type, count: w.count(m), task: curTask }); break; }
        }
    }
    return { cost, work };
}

const estCostUSD = t =>
    (t.input * PRICE.input + t.output * PRICE.output
        + t.cache_read * PRICE.cache_read + t.cache_creation * PRICE.cache_creation) / 1e6;

// Roll up one window of cost + work records into both metric tracks.
export function summarize(costRecs, workRecs = []) {
    const tot = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    const byKind = {};
    for (const r of costRecs) {
        tot.input += r.input; tot.output += r.output;
        tot.cache_read += r.cache_read; tot.cache_creation += r.cache_creation;
        const k = (byKind[r.kind] ??= { input: 0, output: 0, cache_read: 0, cache_creation: 0, turns: 0 });
        k.input += r.input; k.output += r.output;
        k.cache_read += r.cache_read; k.cache_creation += r.cache_creation; k.turns++;
    }
    const turns = costRecs.length;
    const billable = tot.input + tot.output + tot.cache_creation; // cache_read ~free

    const w = { place: 0, break: 0, mine: 0, dig: 0, collect: 0 };
    for (const r of workRecs) w[r.type] += r.count;
    const block_ops = w.place + w.break + w.mine + w.dig;

    return {
        // shared
        turns,
        tokens: tot,
        billable_tokens: billable,
        est_cost_usd: +estCostUSD(tot).toFixed(4),
        by_kind: byKind,
        // Metric B — efficiency
        work: { ...w, block_ops },
        tokens_per_block_op: block_ops ? Math.round(billable / block_ops) : null,
        tokens_per_turn: turns ? Math.round(billable / turns) : null,
        avg_input_per_turn: turns ? Math.round((tot.input + tot.cache_read) / turns) : null, // prompt size → compaction signal
        cache_hit_ratio: (tot.cache_read + tot.input) ? +(tot.cache_read / (tot.cache_read + tot.input)).toFixed(3) : null,
    };
}

// Live-loop entry: metrics for one task given its exact bot.log line range.
export function summarizeRange(text, startLine, endLine, meta = {}) {
    const { cost, work } = parseLog(text);
    const inRange = r => r.line >= startLine && r.line <= endLine;
    return { ...meta, ...summarize(cost.filter(inRange), work.filter(inRange)) };
}

// Historical entry: bucket cost + work by inline `task #N` marker.
export function perTaskFromMarkers(text) {
    const { cost, work } = parseLog(text);
    const ids = new Set([...cost, ...work].map(r => r.task).filter(x => x != null));
    return [...ids].sort((a, b) => a - b).map(id => ({
        task: id,
        ...summarize(cost.filter(r => r.task === id), work.filter(r => r.task === id)),
    }));
}

export function parseQueueOutcomes(text) {
    const out = new Map();
    for (const line of text.split('\n')) {
        const m = line.match(QUEUE_RE);
        if (!m) continue;
        const [, verb, id, status] = m;
        if (verb === 'finish') out.set(+id, 'done');
        else if (verb === 'cancel') out.set(+id, 'cancelled');
        else if (!out.has(+id)) out.set(+id, 'open');
    }
    return out;
}

function lastSession(recs) {
    let start = 0;
    for (let i = 1; i < recs.length; i++) if (recs[i].total_turns < recs[i - 1].total_turns) start = i;
    return recs.slice(start);
}
const fmt = n => (n == null ? '—' : n.toLocaleString('en-US'));

function cli() {
    const [, , file, ...rest] = process.argv;
    if (!file) { console.error('usage: node eval/metrics.mjs <bot.log> [--range START END] [--queue PATH]'); process.exit(1); }
    const text = readFileSync(file, 'utf8');

    const ri = rest.indexOf('--range');
    if (ri !== -1) { console.log(JSON.stringify(summarizeRange(text, +rest[ri + 1], +rest[ri + 2]), null, 2)); return; }

    const { cost } = parseLog(text);
    const sess = summarize(lastSession(cost));
    console.log(`bot.log: ${cost.length} cost lines; last session = ${sess.turns} calls`);
    console.log(`last session: ${fmt(sess.billable_tokens)} billable tok  ~$${sess.est_cost_usd}  cache_hit=${sess.cache_hit_ratio}\n`);

    const qi = rest.indexOf('--queue');
    const queuePath = qi !== -1 ? rest[qi + 1] : file.replace(/bot\.log$/, 'queue.log');
    let outcomes = new Map();
    try { outcomes = parseQueueOutcomes(readFileSync(queuePath, 'utf8')); } catch { /* none */ }

    const perTask = perTaskFromMarkers(text).filter(t => t.turns > 0);
    if (!perTask.length) return;

    console.log('=== per task: A) outcome+cost   B) efficiency ===');
    console.log('  task    outcome    turns  block_ops   tok/op   tok/turn  in/turn   ~$');
    const agg = { done: { n: 0, tok: 0, usd: 0, ops: 0 }, cancelled: { n: 0, tok: 0, usd: 0, ops: 0 } };
    for (const t of perTask) {
        const oc = outcomes.get(t.task) ?? 'open';
        console.log(`  #${String(t.task).padEnd(5)} ${oc.padEnd(10)} ${String(t.turns).padStart(4)}  ${String(t.work.block_ops).padStart(7)}  ${String(fmt(t.tokens_per_block_op)).padStart(8)}  ${String(fmt(t.tokens_per_turn)).padStart(7)}  ${String(fmt(t.avg_input_per_turn)).padStart(7)}   ${t.est_cost_usd}`);
        if (agg[oc]) { agg[oc].n++; agg[oc].tok += t.billable_tokens; agg[oc].usd += t.est_cost_usd; agg[oc].ops += t.work.block_ops; }
    }

    const d = agg.done, c = agg.cancelled, total = d.n + c.n;
    console.log('\n=== Metric A: success/failure ===');
    if (total) console.log(`success rate: ${d.n}/${total} (${(100 * d.n / total).toFixed(0)}%)`);
    if (d.n)   console.log(`cost / success:  ${fmt(Math.round(d.tok / d.n))} tok  ~$${(d.usd / d.n).toFixed(3)}`);
    if (c.n)   console.log(`wasted / fails:  ${fmt(c.tok)} tok  ~$${c.usd.toFixed(2)}  across ${c.n} cancelled`);
    console.log('\n=== Metric B: efficiency (successful tasks only) ===');
    if (d.ops) console.log(`tokens / block op: ${fmt(Math.round(d.tok / d.ops))}  (${fmt(d.ops)} block ops across ${d.n} successes)`);
    else console.log('no block-op work recorded on successful tasks');
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
