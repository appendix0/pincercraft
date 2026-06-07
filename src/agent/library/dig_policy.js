import * as mc from "../../utils/mcdata.js";

// ----------------------------------------------------------------------------
// P1 navigation root-cause: policy for the destructive (dig-as-last-resort)
// pathfinder fallback in goToGoal. Two deterministic rules restrict which
// blocks the bot is allowed to break while pathing:
//
//   1. CoC-gate — never break base / utility / build blocks (beds, chests,
//      doors, glass, furnaces, signs, …). The Code of Conduct forbids digging
//      through or griefing builds; enforcing it at the Movements layer means the
//      last-resort tunnel can't violate it even if the planner asks.
//   2. Tool-aware — never plan to tunnel through a block whose drop we can't
//      harvest (stone/ore/deepslate with no adequate pickaxe). The pathfinder
//      would otherwise commit to a route that aborts mid-dig with "Cannot break
//      X with current tools" (the dominant nav failure). Excluding those blocks
//      makes A* route AROUND them — or fail honestly with NoPath, which
//      re-grounds the planner to craft a pickaxe instead of wedging.
//
// Natural terrain (dirt, logs, sand, leaves, hand-mineable blocks) is never
// touched by either rule, so this only removes griefing and doomed tunnels —
// not legitimate digging.
// ----------------------------------------------------------------------------

// Crafted base/utility/build blocks. Patterns cover every colour/wood variant
// (all bed colours, stained glass, sign types, …) without enumerating each id.
export const PROTECTED_BLOCK_PATTERNS = [
    /_bed$/, /(^|_)chest$/, /^barrel$/, /shulker_box$/,
    /_door$/, /_trapdoor$/, /_fence$/, /_fence_gate$/,
    /(^|_)glass$/, /glass_pane$/, /(^|_)sign$/,
    /^crafting_table$/, /furnace$/, /^smoker$/,
    /^anvil$/, /^chipped_anvil$/, /^damaged_anvil$/,
    /^enchanting_table$/, /^brewing_stand$/, /^lectern$/, /bookshelf$/,
    /^beacon$/, /^respawn_anchor$/, /^loom$/, /^smithing_table$/,
    /^stonecutter$/, /^grindstone$/, /^cartography_table$/, /^composter$/,
    /^bell$/, /^campfire$/, /^soul_campfire$/, /^lantern$/, /^soul_lantern$/,
    /^conduit$/, /^lodestone$/, /^jukebox$/, /^note_block$/, /^flower_pot$/,
];

export function isProtectedBlockName(name) {
    if (!name || typeof name !== 'string') return false;
    return PROTECTED_BLOCK_PATTERNS.some(re => re.test(name));
}

// Pure: of the given block names, which the destructive pathfinder must NOT
// break — the CoC-protected set plus, when a canMine(name)->{ok} predicate is
// supplied, the blocks whose drop we can't currently harvest.
export function blockedDigBlockNames(blockNames, canMine = null) {
    const out = [];
    for (const name of blockNames) {
        if (isProtectedBlockName(name) || (canMine && !canMine(name).ok)) out.push(name);
    }
    return out;
}

// Static CoC-protected ids never change; cache them after first build.
let _protectedIds = null;
function protectedBlockIds() {
    if (_protectedIds) return _protectedIds;
    _protectedIds = [];
    for (const b of mc.getAllBlocks()) {
        if (isProtectedBlockName(b.name)) _protectedIds.push(b.id);
    }
    return _protectedIds;
}

// Integration: restrict a Movements object in place before goToGoal commits to
// digging. Safe to call without an inventory_manager — the tool-aware half is
// simply skipped, leaving the CoC-gate in force.
export function applyDigPolicy(bot, movements) {
    if (!movements || !movements.blocksCantBreak) return movements;
    for (const id of protectedBlockIds()) movements.blocksCantBreak.add(id);

    const im = bot?.inventory_manager;
    if (im) {
        for (const b of mc.getAllBlocks()) {
            if (!im.canMine(b.name).ok) movements.blocksCantBreak.add(b.id);
        }
    }
    return movements;
}
