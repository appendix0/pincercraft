import * as world from './library/world.js';
import * as skills from './library/skills.js';
import * as mc from '../utils/mcdata.js';

// Tool/weapon/armor suffixes — never auto-discarded.
const TOOL_SUFFIXES = ['pickaxe', 'axe', 'sword', 'shovel', 'hoe', 'shears', 'shield',
    'bow', 'crossbow', 'trident', 'elytra', 'helmet', 'chestplate', 'leggings', 'boots'];

// Unique tools whose names don't end in a TOOL_SUFFIX. Holding one makes a
// second pointless, same as a pickaxe — used by the redundant-acquire guard.
const UNIQUE_TOOLS = new Set(['flint_and_steel', 'fishing_rod', 'compass', 'clock', 'spyglass']);

// Tool tiers cheapest→dearest (gold omitted — valuable and rarely the "cheapest
// sufficient" answer) and the craftable tool categories. Used by the craft
// preflight to suggest the cheapest <category> the bot can actually make.
const CRAFT_TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
const TOOL_CATEGORIES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];

// '<material>_<category>' → category (e.g. diamond_axe → 'axe'), else null.
function toolCategory(name) {
    if (!name || typeof name !== 'string') return null;
    return TOOL_CATEGORIES.find(c => name.endsWith('_' + c)) || null;
}

// Utility items worth keeping regardless of space pressure.
const KEEP = new Set(['bucket', 'water_bucket', 'lava_bucket', 'torch', 'soul_torch',
    'ender_pearl', 'ender_eye', 'totem_of_undying', 'flint_and_steel', 'clock', 'compass',
    'map', 'fishing_rod', 'name_tag']);

const FOOD = new Set(['apple', 'golden_apple', 'enchanted_golden_apple', 'bread', 'carrot',
    'golden_carrot', 'potato', 'baked_potato', 'beetroot', 'beetroot_soup', 'mushroom_stew',
    'rabbit_stew', 'suspicious_stew', 'cooked_beef', 'beef', 'cooked_porkchop', 'porkchop',
    'cooked_chicken', 'chicken', 'cooked_mutton', 'mutton', 'cooked_rabbit', 'rabbit',
    'cooked_cod', 'cod', 'cooked_salmon', 'salmon', 'tropical_fish', 'pufferfish', 'cookie',
    'melon_slice', 'pumpkin_pie', 'dried_kelp', 'sweet_berries', 'glow_berries', 'honey_bottle',
    'chorus_fruit']);

// Discard priority — lower rank dropped first (least valuable). Only names here are
// ever auto-discarded; anything else is kept by default.
const JUNK_RANK = {
    rotten_flesh: 0, poisonous_potato: 0, spider_eye: 1, flint: 2,
    dirt: 3, coarse_dirt: 3, gravel: 3, sand: 3, red_sand: 3,
    granite: 4, diorite: 4, andesite: 4, tuff: 4,
    cobblestone: 5, cobbled_deepslate: 5, netherrack: 5,
    stone: 6, deepslate: 6, dripstone_block: 6,
};

export class InventoryManager {
    constructor(agent) {
        this.agent = agent;
    }

    get bot() { return this.agent.bot; }

    emptySlots() { return this.bot.inventory.emptySlotCount(); }
    usedSlots() { return 36 - this.emptySlots(); }
    isFull() { return this.emptySlots() === 0; }
    isNearFull(threshold = 2) { return this.emptySlots() <= threshold; }

    isProtected(name) {
        if (KEEP.has(name) || FOOD.has(name)) return true;
        if (TOOL_SUFFIXES.some(s => name.endsWith(s))) return true;
        if (/(diamond|netherite|emerald|ancient_debris|nether_star|_ingot|beacon|enchant)/.test(name)) return true;
        if (this.taskTargetItems().has(name)) return true;
        return false;
    }

    // Items named in the active task's end_factor that we currently hold — don't toss the
    // thing we're gathering. Best-effort; any shape mismatch yields an empty set.
    taskTargetItems() {
        try {
            const tasks = this.agent?.task_queue?.tasks || [];
            const active = tasks.find(t => String(t.status).includes('progress'));
            const ef = (active?.endFactor || '').toLowerCase();
            if (!ef) return new Set();
            const inv = world.getInventoryCounts(this.bot);
            return new Set(Object.keys(inv).filter(n => ef.includes(n)));
        } catch {
            return new Set();
        }
    }

    // Droppable stacks currently held, least-valuable first.
    _junkStacks() {
        const inv = world.getInventoryCounts(this.bot);
        return Object.keys(inv)
            .filter(n => !this.isProtected(n) && n in JUNK_RANK)
            .sort((a, b) => JUNK_RANK[a] - JUNK_RANK[b]);
    }

    // Free inventory until at least `threshold` slots are empty. Deposits junk to a nearby
    // chest if one exists (lossless), otherwise discards it. Returns true if space was freed.
    async ensureSpace({ threshold = 1, discardOnly = false } = {}) {
        if (this.emptySlots() >= threshold) return true;

        // discardOnly skips the lossless chest deposit (which navigates to a
        // chest) — used by the proactive drive-loop space reflex, where
        // wandering off could collide with a player command. In-action callers
        // keep the chest-deposit path.
        const chest = discardOnly ? null : world.getNearestBlock(this.bot, 'chest', 32);
        if (chest) {
            for (const name of this._junkStacks()) {
                if (this.emptySlots() >= threshold) break;
                await skills.putInChest(this.bot, name, -1);
            }
        }

        if (this.emptySlots() < threshold) {
            for (const name of this._junkStacks()) {
                if (this.emptySlots() >= threshold) break;
                await skills.discard(this.bot, name, -1);
            }
        }

        if (this.emptySlots() < threshold) {
            skills.log(this.bot, `Inventory full of essentials — can't free space.`);
            return false;
        }
        return true;
    }

    // One-line capacity summary for the $INVENTORY perception block.
    statusLine() {
        let s = `SLOTS: ${this.usedSlots()}/36 used (${this.emptySlots()} free)`;
        if (this.isNearFull()) s += ' — LOW SPACE';
        return s;
    }

    // --- Deterministic state queries (no LLM) ---
    // The state authority: counting items, "can I mine this", "what's the craft
    // gap" are facts, not judgment — code answers them so the LLM never guesses.
    // Each accepts an optional inventory snapshot; live_state.js takes ONE
    // getInventoryCounts() per turn and threads it through all of these so the
    // rendered INVENTORY and CAPABILITIES sections can never disagree.

    count(item, inv = world.getInventoryCounts(this.bot)) {
        return inv[item] || 0;
    }

    has(item, n = 1, inv = world.getInventoryCounts(this.bot)) {
        return this.count(item, inv) >= n;
    }

    // Can the bot mine `blockName` and get its drop right now? A block with no
    // harvestTools is hand-mineable (ok). Otherwise ok iff inventory holds any
    // tool in the block's harvest set (any sufficient tier, not just simplest).
    canMine(blockName, inv = world.getInventoryCounts(this.bot)) {
        const tools = mc.getBlockHarvestTools(blockName);
        if (!tools) return { ok: true };
        if (tools.some(t => (inv[t] || 0) > 0)) return { ok: true };
        return { ok: false, reason: `need ${mc.getBlockTool(blockName)}` };
    }

    // Recursive craft prereqs vs current inventory:
    // { craftable, base, missing:[{item,count}], steps:[] } or null for junk input.
    craftGap(item, count = 1, inv = world.getInventoryCounts(this.bot)) {
        return mc.getCraftingGap(item, count, inv);
    }

    // Tool/weapon/armor-class item: holding one makes acquiring a second
    // pointless. Resource items (logs, ore, ingots, food) are NOT tool-like —
    // "get 5 more" of those is legitimate, so they keep delta semantics.
    isToolLike(item) {
        if (!item || typeof item !== 'string') return false;
        if (TOOL_SUFFIXES.some(s => item.endsWith(s))) return true;
        return UNIQUE_TOOLS.has(item);
    }

    // The idempotency guard: true iff `item` is a tool/equipment the bot
    // ALREADY holds, so fetching/crafting another is a deterministic no-op.
    // This is the "code owns 'already have it'" reflex — it never fires for
    // stackable resources, so it can't block a real "gather more" request.
    redundantAcquire(item, inv = world.getInventoryCounts(this.bot)) {
        return this.isToolLike(item) && this.count(item, inv) >= 1;
    }

    // Cheapest tool of `category` the bot can craft from held materials right
    // now (cheapest tier first); null if none. The tier oracle behind the craft
    // preflight's "make a wooden_axe instead" suggestion — code owns "which tier
    // is enough and affordable", not the LLM.
    cheapestCraftableTool(category, inv = world.getInventoryCounts(this.bot)) {
        for (const tier of CRAFT_TIERS) {
            const gap = this.craftGap(`${tier}_${category}`, 1, inv);
            if (gap && gap.missing.length === 0) return `${tier}_${category}`;
        }
        return null;
    }

    // Deterministic craft preflight — the "verify ground truth before acting"
    // contract (Claude Code style). Reads real inventory, checks the recipe is
    // satisfiable, and on a shortfall returns a structured corrective naming the
    // exact missing materials + the cheapest tool the bot CAN make instead. So an
    // over-specified craft (diamond_axe with 0 diamonds, picked from chat
    // momentum) is bounced WITH a fix rather than attempted, failed, and retried.
    // { ok:true } when craftable now or the item is unknown (let the skill error).
    craftPreflight(item, num = 1, inv = world.getInventoryCounts(this.bot)) {
        const gap = this.craftGap(item, 1, inv);
        if (!gap || gap.missing.length === 0) return { ok: true };

        const missingStr = gap.missing.map(m => `${m.count} ${m.item}`).join(', ');
        let corrective = `Can't craft ${item} — short ${missingStr}.`;
        const cat = toolCategory(item);
        if (cat) {
            const alt = this.cheapestCraftableTool(cat, inv);
            corrective += alt
                ? ` A ${alt} is craftable from what you hold and does the same job — make that, or get ${missingStr} first.`
                : ` No ${cat} is craftable from current materials — gather ${gap.missing.map(m => m.item).join('/')} first.`;
        } else {
            corrective += ` Gather ${gap.missing.map(m => m.item).join('/')} first.`;
        }
        return { ok: false, corrective };
    }
}
