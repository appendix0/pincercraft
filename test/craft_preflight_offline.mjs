// Offline checks for the P1 deterministic craft preflight — the "verify ground
// truth before acting" layer over the LLM. An over-specified / unaffordable
// craft (diamond_axe with 0 diamonds, picked from chat momentum) must be bounced
// with a structured corrective naming the shortfall + the cheapest tool the bot
// CAN make, instead of being attempted and failing. Runs against REAL mcdata.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/craft_preflight_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
mc.ensureMcData('1.21.11'); // YOON server version; offline mc_version isn't set until login
import { InventoryManager } from '../src/agent/inventory_manager.js';

const im = new InventoryManager({ bot: null });
let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. The incident verbatim: diamond_axe with 12 planks + 0 diamonds → blocked,
//    corrective names the missing diamonds AND points at the wooden_axe it can make.
{
    const pf = im.craftPreflight('diamond_axe', 1, { oak_planks: 12 });
    assert.strictEqual(pf.ok, false);
    assert.ok(/3 diamond/.test(pf.corrective), pf.corrective);
    assert.ok(/wooden_axe/.test(pf.corrective), pf.corrective);
    ok('diamond_axe w/ 0 diamonds → blocked; corrective names diamonds + suggests wooden_axe (the incident)');
}

// 2. NO false block on the legit cheap craft: wooden_axe from planks is craftable.
{
    const pf = im.craftPreflight('wooden_axe', 1, { oak_planks: 12 });
    assert.strictEqual(pf.ok, true);
    ok('wooden_axe w/ planks → ok (no false block on an affordable craft)');
}

// 3. diamond_axe WITH the materials → ok (the gate only blocks real shortfalls).
{
    const pf = im.craftPreflight('diamond_axe', 1, { diamond: 3, stick: 2 });
    assert.strictEqual(pf.ok, true);
    ok('diamond_axe w/ materials → ok');
}

// 4. No materials at all for any tier → blocked, and honestly says none is craftable.
{
    const pf = im.craftPreflight('iron_pickaxe', 1, {});
    assert.strictEqual(pf.ok, false);
    assert.ok(/No pickaxe is craftable/.test(pf.corrective), pf.corrective);
    ok('iron_pickaxe w/ empty inventory → blocked; "no pickaxe craftable" (gather first)');
}

// 5. The tier oracle picks the cheapest affordable tier; null when none.
{
    assert.strictEqual(im.cheapestCraftableTool('axe', { oak_planks: 12 }), 'wooden_axe');
    assert.strictEqual(im.cheapestCraftableTool('pickaxe', { oak_planks: 12 }), 'wooden_pickaxe');
    assert.strictEqual(im.cheapestCraftableTool('axe', {}), null);
    ok('cheapestCraftableTool → cheapest affordable tier, null when none');
}

console.log(`\nALL PASS (${pass} checks)`);
