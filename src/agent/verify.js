// Phase H verify meta-skill (Blueprint §H, §7 row F).
//
// Pre-finishTask gate that catches the obvious honor-system bugs: tasks the
// LLM declares done with measurable end_factors that aren't actually met
// ("3 iron_ingot in inventory" when inventory shows 1). When the criterion is
// measurable and clearly unmet, finishTask is blocked with a message that
// tells the LLM what's missing so it can resume or cancel.
//
// Scope: programmatic-only. Fuzzy criteria ("crafting plan retrieved",
// "player picked up the pickaxe") are pass-through — we'd rather miss a
// dishonest finish than block a legitimate one on language we can't parse.

import { parseRelativeQuantity } from './classify_and_gate.js';

// Strip a leading article and trailing period/space so end_factor matching
// is forgiving on the LLM's casual phrasing.
function normalize(s) {
    return String(s || '').trim().replace(/[.!]+$/, '').trim().toLowerCase();
}

// Sum stack counts for an item name in the bot's inventory.
function inventoryCount(bot, itemName) {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return 0;
    return bot.inventory.items()
        .filter(i => i.name === itemName)
        .reduce((sum, i) => sum + (i.count || 0), 0);
}

// Match "N item_name in inventory" → returns { count, item } or null.
function matchCountInInventory(text) {
    // Tolerate the quantity phrasings the planner actually generates: "20+",
    // "at least 20", "20 or more" — not just a bare "20". A "20+ iron_ore in
    // inventory" that didn't parse here is what fell through to honor-system and
    // false-passed task #224 (have 0, marked done).
    const m = text.match(/^(?:at\s+least\s+)?(\d+)\+?(?:\s+or\s+more)?\s+([a-z][a-z0-9_]*)\s+in\s+inv(?:entory)?$/);
    if (!m) return null;
    return { count: parseInt(m[1], 10), item: m[2] };
}

// Match "item_name in inventory" (count implied ≥1) → returns { item } or null.
function matchSingleInInventory(text) {
    const m = text.match(/^([a-z][a-z0-9_]*)\s+in\s+inv(?:entory)?$/);
    if (!m) return null;
    return { item: m[1] };
}

// Match "item_a, item_b, item_c in inventory" (each implied ≥1) → array or null.
// Requires underscore-form item names; conversational "diamond helmet" is not
// matched because there's no reliable way to map back to diamond_helmet.
function matchMultiInInventory(text) {
    const m = text.match(/^((?:[a-z][a-z0-9_]*)(?:\s*(?:,|and)\s*[a-z][a-z0-9_]*)+)\s+in\s+inv(?:entory)?$/);
    if (!m) return null;
    const items = m[1].split(/\s*(?:,|and)\s*/).map(s => s.trim()).filter(Boolean);
    if (items.length < 2) return null;
    return items;
}

// Match delta-style "fresh production this run" criteria the task-giver phrases
// as a gain rather than an absolute count:
//   "cobblestone count has increased by at least 10"
//   "cobblestone increased by 10"
//   "≥10 new cobblestone mined and collected this run"
//   "at least 10 new cobblestone collected this run"
// Returns { item, delta } or null. Verified against task.startItemCount (the
// inventory snapshot taken at task start) so the gain must come from THIS run,
// not pre-existing stock — an absolute check would false-pass a bot that
// already held enough and mined nothing.
function matchCountIncrease(text) {
    // "<item> [count] [has] increased by [at least|≥] N"
    let m = text.match(/^([a-z][a-z0-9_]*)\s+(?:count\s+)?(?:has\s+)?increased\s+by\s+(?:at\s+least\s+|≥\s*)?(\d+)\b/);
    if (m) return { item: m[1], delta: parseInt(m[2], 10) };
    // "[at least|≥] N new <item> ..." in a gather context (mine/collect/etc.).
    m = text.match(/(?:at\s+least\s+|≥\s*)?(\d+)\s+new\s+([a-z][a-z0-9_]*)\b/);
    if (m && /\b(?:min|collect|gather|obtain|produc|dug|dig)/.test(text)) {
        return { item: m[2], delta: parseInt(m[1], 10) };
    }
    // "[net] +N <item> ..." — the task-giver's "net +6 cobblestone in inventory"
    // gain phrasing. The leading "+" denotes a delta, so it's checked against the
    // start-of-task snapshot, not as an absolute count. It fell through every
    // matcher to honor-system and false-passed task #225 (mined nothing, done).
    m = text.match(/^(?:net\s+)?\+\s*(\d+)\s+([a-z][a-z0-9_]*)\b/);
    if (m) return { item: m[2], delta: parseInt(m[1], 10) };
    return null;
}

// Tolerant item extractor for a VERBOSE end_factor the strict matchers can't
// parse (e.g. "at least 30 raw_iron in inventory (currently have 19, need 30
// more so total 49+)"). Finds the item token the LLM named — preferring the one
// sitting right after the delta count ("30 raw_iron"), else the first plausible
// "<n> <item>" pair — skipping quantity words. Underscored names only (what the
// planner emits), so the result is countable by inventoryCount.
const QTY_STOPWORDS = new Set(['more', 'additional', 'extra', 'total', 'blocks', 'block',
    'items', 'item', 'of', 'in', 'inventory', 'so', 'need', 'currently', 'have']);
function extractItemForDelta(endFactor, delta) {
    const text = normalize(endFactor);
    let m;
    const near = new RegExp(`\\b${delta}\\+?\\s+([a-z][a-z0-9_]*)`, 'g');
    while ((m = near.exec(text))) { if (!QTY_STOPWORDS.has(m[1])) return m[1]; }
    const any = /\b\d+\+?\s+([a-z][a-z0-9_]*)/g;
    while ((m = any.exec(text))) { if (!QTY_STOPWORDS.has(m[1])) return m[1]; }
    return null;
}

// Deterministic metric-target normalizer. When the player asked for "N MORE" (a
// delta) but the end_factor was encoded otherwise, rewrite it to the "+N item"
// delta form — which verifyEndFactor checks against the task-start snapshot. So
// "get 30 more raw_iron" finishes at +30 from where the bot started, not 30
// total, AND becomes machine-measurable (the verbose form falls through every
// strict matcher to an honor-system finish — the #264 false-done). No-op when
// the player gave no relative cue, it's already a delta, or the LLM already did
// the absolute math (a clean count that differs from N, e.g. "had 3 → 33").
export function normalizeQuantityEndFactor(endFactor, playerMessage) {
    if (!endFactor) return endFactor;
    const rel = parseRelativeQuantity(playerMessage);
    if (!rel) return endFactor;
    if (/^\s*\+|increased|\bnew\b/i.test(endFactor)) return endFactor; // already a delta
    const target = parseEndFactorTarget({ endFactor });
    if (target) {
        // Strict parse worked: rewrite only when it's the SAME N. A different
        // clean count means the LLM already computed the absolute target — keep it.
        if (target.count === rel.delta) return `+${target.count} ${target.item}`;
        return endFactor;
    }
    // Strict parse FAILED — verbose, unmeasurable end_factor. The player's "N
    // more" is the ground-truth intent, so canonicalize to "+N item" using the
    // item the LLM named. This keeps the metric in CODE's hands rather than
    // letting it fall through to an honor-system finish.
    const item = extractItemForDelta(endFactor, rel.delta);
    if (!item) return endFactor;
    return `+${rel.delta} ${item}`;
}

// Structured criterion from an end_factor string, preserving the delta-vs-
// absolute distinction the matchers detect. Used by the eval referee
// (eval/referee.mjs), which measures against its OWN inventory snapshots —
// shared grammar, independent measurement. Returns one of:
//   { kind: 'delta',    item, count }  — gain of `count` since task start
//   { kind: 'absolute', item, count }  — current inventory holds ≥ count
//   { kind: 'multi',    items }        — each listed item present (≥1)
//   null — not an item-count shape (e.g. "bot within 3 of p1")
export function parseEndFactorCriterion(endFactor) {
    if (!endFactor) return null;
    const text = normalize(endFactor);
    const inc = matchCountIncrease(text);
    if (inc) return { kind: 'delta', item: inc.item, count: inc.delta };
    const cnt = matchCountInInventory(text);
    if (cnt) return { kind: 'absolute', item: cnt.item, count: cnt.count };
    const one = matchSingleInInventory(text);
    if (one) return { kind: 'absolute', item: one.item, count: 1 };
    const multi = matchMultiInInventory(text);
    if (multi) return { kind: 'multi', items: multi };
    return null;
}

// Best-effort PRIMARY goal item + count from a task's end_factor, reusing the
// same matchers verifyEndFactor uses — so the live-state CAPABILITIES line and
// the finish gate read the criterion identically (one parser, no drift).
// Returns { item, count } or null when the criterion isn't an item-count shape
// (e.g. "bot within 3 of p1", "greeting said in chat") — caller omits CAPABILITIES.
export function parseEndFactorTarget(task) {
    if (!task || !task.endFactor) return null;
    const c = parseEndFactorCriterion(task.endFactor);
    if (!c) return null;
    if (c.kind === 'multi') return { item: c.items[0], count: 1 }; // primary = first listed
    return { item: c.item, count: c.count };
}

// Snapshot the baseline count for a delta-style end_factor at task start, so
// verifyEndFactor can later confirm the gain is from THIS run. No-op for
// non-delta criteria. Called from the queue 'start' hook (agent._onQueueChange).
export function snapshotStartCounts(agent, task) {
    if (!task || !task.endFactor) return;
    const bot = agent?.bot;
    if (!bot) return;
    const inc = matchCountIncrease(normalize(task.endFactor));
    if (inc) task.startItemCount = inventoryCount(bot, inc.item);
}

// Public API. Returns:
//   { programmatic: false } — couldn't parse the end_factor; caller should
//     allow the finishTask through unchanged.
//   { programmatic: true, verified: true } — criterion checked and satisfied.
//   { programmatic: true, verified: false, reason: string } — criterion
//     checked and NOT satisfied; caller should block and surface `reason`.
export function verifyEndFactor(agent, task) {
    if (!task || !task.endFactor) return { programmatic: false };
    const bot = agent?.bot;
    if (!bot) return { programmatic: false };
    const text = normalize(task.endFactor);

    const inc = matchCountIncrease(text);
    if (inc) {
        const have = inventoryCount(bot, inc.item);
        const base = typeof task.startItemCount === 'number' ? task.startItemCount : 0;
        const gained = have - base;
        if (gained >= inc.delta) return { programmatic: true, verified: true, observed: `${inc.item}+${gained}` };
        return {
            programmatic: true,
            verified: false,
            reason: `End factor "${task.endFactor}" not met — ${inc.item} rose by ${gained} this task (have ${have}, started with ${base}), need +${inc.delta}.`,
        };
    }

    const single = matchCountInInventory(text);
    if (single) {
        const have = inventoryCount(bot, single.item);
        if (have >= single.count) return { programmatic: true, verified: true, observed: `${single.item}=${have}` };
        return {
            programmatic: true,
            verified: false,
            reason: `End factor "${task.endFactor}" not met — inventory has ${have} ${single.item}, need ${single.count}.`,
        };
    }

    const one = matchSingleInInventory(text);
    if (one) {
        const have = inventoryCount(bot, one.item);
        if (have >= 1) return { programmatic: true, verified: true, observed: `${one.item}=${have}` };
        return {
            programmatic: true,
            verified: false,
            reason: `End factor "${task.endFactor}" not met — inventory has 0 ${one.item}.`,
        };
    }

    const many = matchMultiInInventory(text);
    if (many) {
        const missing = many.filter(item => inventoryCount(bot, item) < 1);
        if (missing.length === 0) return { programmatic: true, verified: true, observed: many.map(item => `${item}=${inventoryCount(bot, item)}`).join(',') };
        return {
            programmatic: true,
            verified: false,
            reason: `End factor "${task.endFactor}" not met — missing from inventory: ${missing.join(', ')}.`,
        };
    }

    return { programmatic: false };
}
