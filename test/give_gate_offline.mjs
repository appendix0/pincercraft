// Offline checks for the deterministic proprioception gate (requireHeld) — the
// bot cannot give/stash/drop (or claim to) an item it does not hold. The
// diamond_sword incident: the bot believed it had a sword (it was wearing diamond
// armor), tried to !givePlayer AND !putInChest it, and nothing stopped the false
// move. The gate reads REAL inventory and bounces the action with a structured,
// verb-tailored corrective BEFORE the bot moves. Used by give / putInChest / discard.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/give_gate_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
mc.ensureMcData('1.21.11');
import { InventoryManager } from '../src/agent/inventory_manager.js';

const im = new InventoryManager({ bot: null });
let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. The incident verbatim: give diamond_sword while holding none (only diamond
//    ARMOR + logs) → blocked; corrective names the truth and forbids claiming it.
{
    const g = im.requireHeld('diamond_sword', 1, 'give', { diamond_helmet: 1, oak_log: 3 });
    assert.strictEqual(g.ok, false);
    assert.ok(/no diamond_sword/i.test(g.corrective), g.corrective);
    assert.ok(/do not claim/i.test(g.corrective), g.corrective);
    assert.ok(/give/i.test(g.corrective), g.corrective);
    ok('give diamond_sword w/ none held → blocked; corrective forbids claiming delivery (the incident)');
}

// 2. Same false belief via putInChest — verb tailors the corrective to "put in the chest".
{
    const g = im.requireHeld('diamond_sword', 1, 'put in the chest', { diamond_helmet: 1 });
    assert.strictEqual(g.ok, false);
    assert.ok(/put in the chest/i.test(g.corrective), g.corrective);
    ok('putInChest diamond_sword w/ none held → blocked; corrective says "put in the chest" (line 85470)');
}

// 3. Holding enough → ok (no false block on a real action).
{
    const g = im.requireHeld('iron_ingot', 2, 'give', { iron_ingot: 5 });
    assert.strictEqual(g.ok, true);
    ok('give 2 iron_ingot while holding 5 → ok (no false block on a real delivery)');
}

// 4. Holding some but not enough → blocked; corrective names the real count.
{
    const g = im.requireHeld('iron_ingot', 5, 'discard', { iron_ingot: 2 });
    assert.strictEqual(g.ok, false);
    assert.ok(/2 iron_ingot/.test(g.corrective), g.corrective);
    assert.ok(/do not claim/i.test(g.corrective), g.corrective);
    ok('discard 5 iron_ingot while holding 2 → blocked; corrective names the real count (2)');
}

// 5. Exact count held → ok (boundary).
{
    const g = im.requireHeld('diamond', 3, 'give', { diamond: 3 });
    assert.strictEqual(g.ok, true);
    ok('handle exactly what is held → ok (boundary, no off-by-one false block)');
}

// 6. Worn armor: bot is WEARING a diamond_helmet (equipment slot 5), none in bag.
//    Must NOT deny owning it — say it's equipped, take it off first (the inverse
//    of the original lie: now the bot can't falsely claim it lacks worn gear).
{
    const imArmor = new InventoryManager({ bot: { inventory: { slots: { 5: { name: 'diamond_helmet' } } } } });
    const g = imArmor.requireHeld('diamond_helmet', 1, 'give', { oak_log: 2 });
    assert.strictEqual(g.ok, false);
    assert.ok(/wearing|equipped/i.test(g.corrective), g.corrective);
    assert.ok(!/no diamond_helmet/i.test(g.corrective), `must NOT deny owning worn armor: ${g.corrective}`);
    ok('give worn diamond_helmet → blocked with "equipped, take it off first" (not "you have none")');
}

console.log(`\nALL PASS (${pass} checks)`);
