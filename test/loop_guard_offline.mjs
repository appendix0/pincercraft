// Offline checks for the inventory-loop fix (layers B/C/D). No live bot.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/loop_guard_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
import { InventoryManager } from '../src/agent/inventory_manager.js';
import { findRedundantFetchInPrompt } from '../src/agent/classify_and_gate.js';
import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';

mc.ensureMcData('1.21.11');

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// --- C: redundantAcquire is tool-only (resources keep delta semantics) ---
{
    const im = new InventoryManager({ bot: null });
    assert(im.isToolLike('iron_pickaxe') && im.isToolLike('diamond_sword') && im.isToolLike('flint_and_steel'));
    assert(!im.isToolLike('iron_ingot') && !im.isToolLike('cobblestone') && !im.isToolLike('oak_log'));
    ok('isToolLike: tools yes, resources no');

    assert(im.redundantAcquire('iron_pickaxe', { iron_pickaxe: 1 }) === true);
    assert(im.redundantAcquire('iron_pickaxe', {}) === false);
    ok('redundantAcquire(iron_pickaxe) → true when held, false when not');

    // The regression guard: resources must NEVER be flagged redundant, even
    // when you already hold a pile — "get 64 more cobblestone" stays legal.
    assert(im.redundantAcquire('cobblestone', { cobblestone: 64 }) === false);
    assert(im.redundantAcquire('iron_ingot', { iron_ingot: 5 }) === false);
    ok('redundantAcquire(resource) → false even when holding many (no "get more" regression)');
}

// --- B: findRedundantFetchInPrompt catches the exact bug prompt ---
{
    const heldPick = [{ name: 'iron_pickaxe', count: 1 }];

    const bug = findRedundantFetchInPrompt('Go to my personal chest and get an iron pickaxe', heldPick);
    assert(bug.includes('iron_pickaxe'), `bug prompt should flag iron_pickaxe, got ${JSON.stringify(bug)}`);
    ok('newAction "get an iron pickaxe from my chest" → flagged (held)');

    const craft = findRedundantFetchInPrompt('craft an iron_pickaxe then mine', heldPick);
    assert(craft.includes('iron_pickaxe'), `craft-when-held should flag, got ${JSON.stringify(craft)}`);
    ok('newAction "craft an iron_pickaxe" while holding one → flagged');

    // Using a held tool is NOT fetching it — must not trip.
    const using = findRedundantFetchInPrompt('Mine diamonds with my iron_pickaxe', heldPick);
    assert(using.length === 0, `"mine with pickaxe" must not trip, got ${JSON.stringify(using)}`);
    ok('newAction "mine diamonds with my iron_pickaxe" → NOT flagged (using, not fetching)');

    // Don't have it → fetching is legitimate.
    const dontHave = findRedundantFetchInPrompt('get an iron pickaxe from the chest', []);
    assert(dontHave.length === 0, `must not flag a tool you don't hold, got ${JSON.stringify(dontHave)}`);
    ok('newAction fetch when NOT held → NOT flagged');
}

// --- D: orchestrator loop-breaker blocks no-progress acquisition repeats ---
{
    // Mutable inventory the mock bot reports; world.getInventoryCounts reads
    // bot.inventory.slots. Getter so reassigning invItems is seen. Keeping it
    // fixed simulates "action changed nothing".
    let invItems = [{ name: 'iron_pickaxe', count: 1 }];
    const bot = { inventory: { get slots() { return invItems; } } };
    const agent = { bot, last_sender: 'system' };
    const orch = new OrchestratorV2(agent, { promptWithTools: async () => ({}), getSystemPrompt: async () => '' });

    const mineNoop = { name: '!findAndMine', params: { type: {}, num: {} }, perform: async () => 'Could not find any iron_ore.' };
    const tc = (args) => ({ id: Math.random().toString(36).slice(2), name: 'findAndMine', args });

    const r1 = await orch._executeOne(tc({ type: 'iron_ore', num: 1 }), mineNoop);
    assert(!r1.isError, `1st findAndMine should run, got ${JSON.stringify(r1)}`);
    const r2 = await orch._executeOne(tc({ type: 'iron_ore', num: 1 }), mineNoop);
    assert(r2.isError && /loop guard/.test(r2.content), `identical no-progress repeat must block, got ${JSON.stringify(r2)}`);
    ok('D: identical findAndMine with no inventory change → blocked on 2nd call');

    // Varied args, still no progress → blocked by the streak on the 3rd.
    const orch2 = new OrchestratorV2(agent, { promptWithTools: async () => ({}), getSystemPrompt: async () => '' });
    const a = await orch2._executeOne(tc({ type: 'iron_ore', num: 1 }), mineNoop);
    const b = await orch2._executeOne(tc({ type: 'iron_ore', num: 2 }), mineNoop);
    const c = await orch2._executeOne(tc({ type: 'iron_ore', num: 3 }), mineNoop);
    assert(!a.isError && !b.isError, 'first two varied calls run');
    assert(c.isError && /loop guard/.test(c.content), `3rd no-progress (varied) must block, got ${JSON.stringify(c)}`);
    ok('D: 3 no-progress acquisitions in a row (varied args) → 3rd blocked by streak');

    // Progress (inventory changes) resets the streak — legit "get more" survives.
    const orch3 = new OrchestratorV2(agent, { promptWithTools: async () => ({}), getSystemPrompt: async () => '' });
    invItems = [{ name: 'iron_pickaxe', count: 1 }];
    const mineProgress = {
        name: '!findAndMine', params: { type: {}, num: {} },
        perform: async () => { invItems = [...invItems, { name: 'raw_iron', count: invItems.length }]; return 'mined 1'; },
    };
    const p1 = await orch3._executeOne(tc({ type: 'iron_ore', num: 1 }), mineProgress);
    const p2 = await orch3._executeOne(tc({ type: 'iron_ore', num: 1 }), mineProgress);
    const p3 = await orch3._executeOne(tc({ type: 'iron_ore', num: 1 }), mineProgress);
    assert(!p1.isError && !p2.isError && !p3.isError, `progressing mines must never block, got ${JSON.stringify([p1, p2, p3].map(r => r.isError))}`);
    ok('D: repeated mining that DOES change inventory → never blocked (no regression)');

    // Movement is not acquisition-class → never loop-guarded even if identical.
    const orch4 = new OrchestratorV2(agent, { promptWithTools: async () => ({}), getSystemPrompt: async () => '' });
    const goNoop = { name: '!goToPlayer', params: { name: {} }, perform: async () => 'arrived' };
    const g1 = await orch4._executeOne({ id: '1', name: 'goToPlayer', args: { name: 'p1' } }, goNoop);
    const g2 = await orch4._executeOne({ id: '2', name: 'goToPlayer', args: { name: 'p1' } }, goNoop);
    const g3 = await orch4._executeOne({ id: '3', name: 'goToPlayer', args: { name: 'p1' } }, goNoop);
    assert(!g1.isError && !g2.isError && !g3.isError, 'movement must never be loop-guarded');
    ok('D: repeated identical !goToPlayer → never blocked (movement exempt)');
}

console.log(`\nALL PASS (${pass} checks)`);
