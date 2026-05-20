// v2 Step 6 — Unit tests for subagent_v2 helpers.
// Run: node scripts/test_subagent_v2.js. Uses real profiles/roles/miner.json.

import {
    matchesToolFilter,
    filterDescriptorsByRole,
    loadRoleProfile,
    createChildSubagentContext,
    finalizeChildSubagent,
    _resetRoleCache,
} from '../src/agent/subagent_v2.js';

let failures = 0;
function assert(cond, label, info) {
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label}`, info ?? ''); failures++; }
}

// 1. matchesToolFilter — patterns
console.log('test_matches_tool_filter');
assert(matchesToolFilter('inventory', null) === true, 'null filter = match all');
assert(matchesToolFilter('inventory', []) === true, 'empty filter = match all');
assert(matchesToolFilter('inventory', ['inventory']) === true, 'exact match');
assert(matchesToolFilter('inventory', ['stats']) === false, 'non-match');
assert(matchesToolFilter('goToPlayer', ['goTo*']) === true, 'prefix match');
assert(matchesToolFilter('goToPlayer', ['go*']) === true, 'short prefix match');
assert(matchesToolFilter('inventory', ['*']) === true, 'star matches anything');
assert(matchesToolFilter('mineBlocks', ['stats', 'mine*', 'finishTask']) === true, 'multi-pattern OR');
assert(matchesToolFilter('attack', ['mine*', 'goTo*']) === false, 'multi-pattern no match');

// 2. filterDescriptorsByRole
console.log('test_filter_descriptors_by_role');
const descs = [
    { name: 'mineBlocks', isLongRunning: true },
    { name: 'goToPlayer', isLongRunning: true },
    { name: 'inventory', isReadOnly: true },
    { name: 'attack', isLongRunning: true },
    { name: 'finishTask', isConcurrencySafe: true },
];
const minerRole = { tools_filter: ['mine*', 'goTo*', 'inventory*', 'finishTask'] };
const filtered = filterDescriptorsByRole(descs, minerRole);
const filteredNames = filtered.map(d => d.name);
assert(filteredNames.includes('mineBlocks'), 'miner sees mineBlocks');
assert(filteredNames.includes('goToPlayer'), 'miner sees goToPlayer');
assert(filteredNames.includes('inventory'), 'miner sees inventory');
assert(filteredNames.includes('finishTask'), 'miner sees finishTask');
assert(!filteredNames.includes('attack'), 'miner does NOT see attack');
assert(filterDescriptorsByRole(descs, {}).length === descs.length, 'no filter = pass through');
assert(filterDescriptorsByRole(descs, null).length === descs.length, 'null role = pass through');

// 3. loadRoleProfile reads real miner.json
console.log('test_load_role_profile');
_resetRoleCache();
let miner;
try { miner = loadRoleProfile('miner'); } catch (e) { console.log('  ✗ loadRoleProfile threw:', e.message); failures++; }
assert(miner?.role === 'miner', 'role field correct');
assert(typeof miner?.system_prompt === 'string' && miner.system_prompt.length > 0, 'system_prompt present');
assert(loadRoleProfile('miner') === miner, 'cached on second load');

// 4. loadRoleProfile rejects unknown role
console.log('test_load_role_unknown');
let threw = false;
try { loadRoleProfile('not-a-real-role-' + Date.now()); } catch { threw = true; }
assert(threw, 'unknown role throws');

// 5. createChildSubagentContext — ephemeral queue, no disk
console.log('test_create_child_context');
const mockAgent = {
    name: 'TestBot',
    bot: { inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] }, entity: { position: { x: 10, y: 64, z: -20 } } },
};
const ctx = createChildSubagentContext(mockAgent, 'miner', 'mine 3 iron_ore', '3 iron_ore in inventory');
assert(ctx.role === 'miner', 'role set');
assert(ctx.taskQueue !== undefined, 'taskQueue created');
assert(ctx.taskQueue.persist === false, 'taskQueue is ephemeral (persist=false)');
assert(ctx.taskQueue.tasks.length === 1, 'root task seeded');
assert(ctx.taskQueue.tasks[0].description === 'mine 3 iron_ore', 'task description');
assert(ctx.taskQueue.tasks[0].endFactor === '3 iron_ore in inventory', 'end factor');
assert(ctx.taskQueue.tasks[0].status === 'in_progress', 'auto-promoted to in_progress (no plan mode in child)');
assert(Array.isArray(ctx.history) && ctx.history.length === 1, 'fresh history with one seed message');
assert(ctx.history[0].role === 'user', 'seed message role');
assert(ctx.history[0].content.includes('mine 3 iron_ore'), 'seed message references task');
assert(ctx.inventorySnapshot.iron_pickaxe === 1, 'inventory snapshot taken');
assert(ctx.positionSnapshot?.x === 10, 'position snapshot taken');
assert(ctx.dispatchedAt > 0, 'dispatchedAt set');

// 6. createChildSubagentContext rejects missing args
console.log('test_create_child_validation');
let threw1 = false, threw2 = false, threw3 = false;
try { createChildSubagentContext(mockAgent, '', 'd', 'e'); } catch { threw1 = true; }
try { createChildSubagentContext(mockAgent, 'miner', '', 'e'); } catch { threw2 = true; }
try { createChildSubagentContext(mockAgent, 'miner', 'd', ''); } catch { threw3 = true; }
assert(threw1, 'empty role rejected');
assert(threw2, 'empty description rejected');
assert(threw3, 'empty end_factor rejected');

// 7. finalizeChildSubagent rolls up state
console.log('test_finalize');
// Simulate the subagent mining 3 iron_ore — change the mock inventory
mockAgent.bot.inventory.items = () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_ore', count: 3 }];
mockAgent.bot.entity.position = { x: 100, y: 60, z: -30 };
// Mark the child task done first
ctx.taskQueue.tasks[0].status = 'done';
const fin = finalizeChildSubagent(mockAgent, ctx, { result: 'success', summary: 'Got 3 iron_ore at y=60' });
assert(fin !== null, 'finalize returns object');
assert(fin.content.includes('subagent miner success'), 'content header correct');
assert(fin.content.includes('+3 iron_ore'), 'inventory delta surfaced');
assert(fin.content.includes('child_tasks=1 done'), 'child task counts surfaced');
assert(fin.content.includes('Got 3 iron_ore at y=60'), 'summary surfaced');
assert(fin.elapsedSec >= 0, 'elapsed time computed');
assert(fin.position?.x === 100, 'final position captured');
assert(fin.inventoryDelta.find(d => d.name === 'iron_ore')?.delta === 3, 'delta detail');

// 8. finalizeChildSubagent handles missing context gracefully
console.log('test_finalize_null');
assert(finalizeChildSubagent(mockAgent, null) === null, 'null ctx returns null');

if (failures > 0) {
    console.log(`\nFAIL — ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nPASS — all subagent_v2 tests green');
process.exit(0);
