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
    const m = text.match(/^(\d+)\s+([a-z][a-z0-9_]*)\s+in\s+inv(?:entory)?$/);
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
