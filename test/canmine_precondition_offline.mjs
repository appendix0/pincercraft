// Offline checks for the H2 canMine precondition data — the deterministic
// verdicts mineBlockAt/breakBlockAt gate on BEFORE pathing to a block.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/canmine_precondition_offline.mjs
import assert from 'node:assert';
import { ensureMcData } from '../src/utils/mcdata.js';
import { InventoryManager } from '../src/agent/inventory_manager.js';

ensureMcData('1.21.11'); // YOON server version; offline mc_version isn't set until bot login

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

const im = new InventoryManager({});
const can = (block, inv) => im.canMine(block, inv).ok;

// The exact failure taxonomy from bot.log: "Cannot break stone/deepslate/... with
// current tools". Empty-handed, the gate MUST refuse these (no pickaxe).
for (const block of ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite']) {
    assert.strictEqual(can(block, {}), false, `empty-handed should refuse ${block}`);
}
ok('refuses stone/deepslate/cobblestone family with no pickaxe (the taxonomy)');

// A wooden pickaxe unlocks the stone family — gate must allow.
for (const block of ['stone', 'cobblestone', 'deepslate', 'andesite']) {
    assert.strictEqual(can(block, { wooden_pickaxe: 1 }), true, `wooden pickaxe should mine ${block}`);
}
ok('allows stone family once a wooden_pickaxe is held');

// Tier gating: ore needs the right tier. canMine accepts ANY sufficient tier.
assert.strictEqual(can('iron_ore', { wooden_pickaxe: 1 }), false, 'wooden too weak for iron_ore');
assert.strictEqual(can('iron_ore', { stone_pickaxe: 1 }), true, 'stone pickaxe mines iron_ore');
assert.strictEqual(can('diamond_ore', { stone_pickaxe: 1 }), false, 'stone too weak for diamond_ore');
assert.strictEqual(can('diamond_ore', { iron_pickaxe: 1 }), true, 'iron pickaxe mines diamond_ore');
assert.strictEqual(can('diamond_ore', { netherite_pickaxe: 1 }), true, 'netherite (higher tier) mines diamond_ore');
ok('tier gating: any sufficient pickaxe tier passes, weaker fails');

// Hand-mineable blocks (no harvestTools) are ALWAYS ok — the gate must never
// block dirt/log/sand gathering for lack of a tool.
for (const block of ['dirt', 'oak_log', 'sand', 'gravel', 'grass_block']) {
    assert.strictEqual(can(block, {}), true, `${block} is hand-mineable, must pass`);
}
ok('never blocks hand-mineable blocks (dirt/log/sand)');

// The reason string is actionable (names the tool) so the planner re-grounds.
const m = im.canMine('stone', {});
assert(/pickaxe/.test(m.reason), `reason should name a pickaxe, got: ${m.reason}`);
ok('refusal reason names the missing tool');

console.log(`\nALL PASS (${pass} checks)`);
