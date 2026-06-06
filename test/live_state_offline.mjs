// Offline checks for the deterministic state authority (no live bot).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/live_state_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
import { InventoryManager } from '../src/agent/inventory_manager.js';

mc.ensureMcData('1.21.11'); // YOON server version; offline mc_version isn't set until bot login

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// --- craftGap: iron_pickaxe from nothing vs partial inventory.
// The recursive planner reduces ingredients to BASE materials: sticks bottom
// out at oak_log (wood→planks→sticks lives in steps), so `missing` lists the
// raw things to gather — 3 iron_ingot + 1 oak_log — which is what we want. ---
{
    const gap0 = mc.getCraftingGap('iron_pickaxe', 1, {});
    const names0 = gap0.missing.map(m => `${m.count} ${m.item}`);
    assert(gap0.missing.some(m => m.item === 'iron_ingot' && m.count === 3),
        `expected 3 iron_ingot missing, got ${JSON.stringify(names0)}`);
    assert(gap0.missing.some(m => /log/.test(m.item)),
        `expected raw wood (log) missing from empty inv, got ${JSON.stringify(names0)}`);
    assert(gap0.steps.some(s => /stick/.test(s)),
        `expected a stick craft step, got ${JSON.stringify(gap0.steps)}`);
    ok(`craftGap(iron_pickaxe, {}) MISSING ${names0.join(', ')} | steps: ${gap0.steps.join(' | ')}`);

    const gap1 = mc.getCraftingGap('iron_pickaxe', 1, { stick: 2 });
    assert(!gap1.missing.some(m => /log/.test(m.item)),
        `holding sticks should drop the wood requirement, got ${JSON.stringify(gap1.missing)}`);
    assert(gap1.missing.some(m => m.item === 'iron_ingot' && m.count === 3));
    ok(`craftGap(iron_pickaxe, {stick:2}) drops wood from MISSING`);

    const gap2 = mc.getCraftingGap('iron_pickaxe', 1, { iron_ingot: 3, stick: 2 });
    assert(gap2.missing.length === 0, `full materials → no missing, got ${JSON.stringify(gap2.missing)}`);
    ok(`craftGap(iron_pickaxe, full) → have all materials`);
}

// --- canMine via InventoryManager (pass inv explicitly; no bot needed) ---
{
    const im = new InventoryManager({ bot: null });

    const stoneNoTool = im.canMine('stone', {});
    assert(stoneNoTool.ok === false && /pickaxe/.test(stoneNoTool.reason),
        `stone w/o pickaxe should fail, got ${JSON.stringify(stoneNoTool)}`);
    ok(`canMine(stone, {}) → NO (${stoneNoTool.reason})`);

    const stoneWithBetter = im.canMine('stone', { stone_pickaxe: 1 });
    assert(stoneWithBetter.ok === true, `stone_pickaxe should satisfy stone, got ${JSON.stringify(stoneWithBetter)}`);
    ok(`canMine(stone, {stone_pickaxe:1}) → YES (any sufficient tier)`);

    const dirt = im.canMine('dirt', {});
    assert(dirt.ok === true, `dirt is hand-mineable, got ${JSON.stringify(dirt)}`);
    ok(`canMine(dirt, {}) → YES (hand-mineable)`);

    const ironOreNoTool = im.canMine('iron_ore', {});
    assert(ironOreNoTool.ok === false, `iron_ore needs a pickaxe, got ${JSON.stringify(ironOreNoTool)}`);
    ok(`canMine(iron_ore, {}) → NO (${ironOreNoTool.reason})`);
}

// --- acquisition-hint premises: the iron chain is derivable from existing tables ---
{
    assert(mc.getItemSmeltingIngredient('iron_ingot') === 'raw_iron', 'iron_ingot smelts from raw_iron');
    assert(mc.getItemBlockSources('raw_iron').includes('iron_ore'), 'raw_iron is mined from iron_ore');
    ok('iron_ingot ← smelt raw_iron ← mine iron_ore (chain derivable)');
}

console.log(`\nALL PASS (${pass} checks)`);
