// Offline checks for the !newAction missing-tool gate craft-target exemption:
// a tool named as the thing being CRAFTED must not be rejected as a missing
// tool (live 2026-07-11: "craft a fishing_rod" bounced 4× as "missing:
// fishing_rod" while the bot stood at the crafting table with all materials).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/tool_gate_offline.mjs
import assert from 'node:assert';
import { findMissingToolsInPrompt } from '../src/agent/classify_and_gate.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

const inv = (...names) => names.map(n => ({ name: n, count: 1 }));

// The live prompt shape: craft target named, materials held, no rod yet.
assert.deepStrictEqual(
    findMissingToolsInPrompt('I am standing next to a crafting table at (631, 63, 158). Craft a fishing_rod using 3 sticks and 2 string.', inv('stick', 'string')),
    [], 'craft target must be exempt');
ok('"craft a fishing_rod ..." → not missing (the live 4× bounce)');

assert.deepStrictEqual(findMissingToolsInPrompt('make a fishing rod from sticks and string', inv('stick', 'string')),
    [], 'spaced "fishing rod" craft target exempt');
ok('spaced "make a fishing rod" → not missing');

// Use-intent is still gated: naming a tool you'd swing without holding it.
assert.deepStrictEqual(findMissingToolsInPrompt('mine the diamond_ore with your iron_pickaxe', inv('stone_pickaxe')),
    ['iron_pickaxe'], 'use-intent without the tool must still bounce');
ok('"mine with your iron_pickaxe" (not held) → still missing');

// Craft one tool, use another: only the used-not-held one is missing.
assert.deepStrictEqual(
    findMissingToolsInPrompt('craft a wooden_pickaxe, then dig the shaft using the stone_pickaxe', inv('oak_planks', 'stick')),
    ['stone_pickaxe'], 'craft target exempt, used tool still gated');
ok('craft wooden_pickaxe + use stone_pickaxe → only stone_pickaxe missing');

// Held tools are never missing (unchanged behavior).
assert.deepStrictEqual(findMissingToolsInPrompt('chop logs with the iron_axe', inv('iron_axe')), [], 'held tool passes');
ok('held tool named in prompt → not missing');

console.log(`\ntool_gate_offline: ${pass} checks passed`);
