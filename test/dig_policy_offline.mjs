// Offline checks for the P1 destructive-dig policy (dig_policy.js).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/dig_policy_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
import { InventoryManager } from '../src/agent/inventory_manager.js';
import { isProtectedBlockName, blockedDigBlockNames, applyDigPolicy } from '../src/agent/library/dig_policy.js';

mc.ensureMcData('1.21.11'); // YOON server version; offline mc_version isn't set until bot login

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// --- 1. CoC: protected base/utility/build blocks are recognised by pattern ---
for (const name of ['white_bed', 'chest', 'trapped_chest', 'oak_door', 'iron_trapdoor',
    'oak_fence', 'spruce_fence_gate', 'glass', 'white_stained_glass', 'glass_pane',
    'oak_sign', 'crafting_table', 'furnace', 'blast_furnace', 'enchanting_table',
    'lectern', 'smithing_table', 'barrel', 'red_shulker_box', 'campfire']) {
    assert.strictEqual(isProtectedBlockName(name), true, `expected protected: ${name}`);
}
ok('CoC: beds/chests/doors/glass/utility blocks flagged protected');

// --- 2. Natural terrain is NEVER protected (would block legitimate digging) ---
for (const name of ['stone', 'dirt', 'oak_log', 'iron_ore', 'deepslate', 'gravel',
    'sand', 'cobblestone', 'andesite', 'grass_block']) {
    assert.strictEqual(isProtectedBlockName(name), false, `expected NOT protected: ${name}`);
}
ok('terrain (stone/dirt/log/ore) never flagged protected');

// --- 3. blockedDigBlockNames: protected ∪ unmineable, pure ---
const canMineStub = (name) => ({ ok: !(name === 'stone' || name === 'deepslate') });
const names = ['stone', 'dirt', 'oak_log', 'white_bed', 'deepslate'];
assert.deepStrictEqual(
    blockedDigBlockNames(names, canMineStub).sort(),
    ['deepslate', 'stone', 'white_bed'].sort());
ok('blockedDigBlockNames = protected ∪ unmineable');

// Without a canMine predicate, only the CoC-protected set is blocked.
assert.deepStrictEqual(blockedDigBlockNames(names, null), ['white_bed']);
ok('no canMine → CoC-only (tool-aware half skipped)');

// --- 4. applyDigPolicy integration with REAL mcdata + real canMine ---
const realIm = new InventoryManager({});
const fakeIm = (inv) => ({ canMine: (n) => realIm.canMine(n, inv) });
const idOf = (n) => mc.getBlockId(n);

// 4a. No inventory_manager → CoC-gate only: protected blocked, stone NOT.
let mv = { blocksCantBreak: new Set() };
applyDigPolicy({}, mv);
assert(mv.blocksCantBreak.has(idOf('white_bed')), 'bed blocked (CoC)');
assert(!mv.blocksCantBreak.has(idOf('stone')), 'stone NOT blocked without im');
ok('applyDigPolicy: no im → CoC-gate only');

// 4b. Empty-handed → can't harvest stone/deepslate, so they're blocked too;
//     hand-mineable dirt stays diggable.
mv = { blocksCantBreak: new Set() };
applyDigPolicy({ inventory_manager: fakeIm({}) }, mv);
assert(mv.blocksCantBreak.has(idOf('stone')), 'stone blocked (no pickaxe)');
assert(mv.blocksCantBreak.has(idOf('deepslate')), 'deepslate blocked (no pickaxe)');
assert(mv.blocksCantBreak.has(idOf('white_bed')), 'bed still blocked (CoC)');
assert(!mv.blocksCantBreak.has(idOf('dirt')), 'dirt diggable (hand-mineable)');
ok('applyDigPolicy: empty-handed → stone/deepslate blocked, dirt free');

// 4c. Holding a netherite pickaxe → stone is harvestable, so NOT blocked; the
//     CoC-protected bed is blocked regardless of tools.
mv = { blocksCantBreak: new Set() };
applyDigPolicy({ inventory_manager: fakeIm({ netherite_pickaxe: 1 }) }, mv);
assert(!mv.blocksCantBreak.has(idOf('stone')), 'stone diggable with pickaxe');
assert(mv.blocksCantBreak.has(idOf('white_bed')), 'bed blocked even with pickaxe (CoC)');
ok('applyDigPolicy: with pickaxe → stone free, CoC still enforced');

console.log(`\nALL PASS (${pass} checks)`);
