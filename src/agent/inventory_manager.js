import * as world from './library/world.js';
import * as skills from './library/skills.js';

// Tool/weapon/armor suffixes — never auto-discarded.
const TOOL_SUFFIXES = ['pickaxe', 'axe', 'sword', 'shovel', 'hoe', 'shears', 'shield',
    'bow', 'crossbow', 'trident', 'elytra', 'helmet', 'chestplate', 'leggings', 'boots'];

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
    async ensureSpace({ threshold = 1 } = {}) {
        if (this.emptySlots() >= threshold) return true;

        const chest = world.getNearestBlock(this.bot, 'chest', 32);
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
}
