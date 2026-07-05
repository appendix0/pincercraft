// Offline checks for targeted idle item-collecting — the fix for the
// 2026-07-05 reflex ping-pong (gold row #7): item_collecting picked up the
// owner's mined dirt, tidyJunk tossed it, the toss was a fresh entity, loop.
// Owner rule: only collect drops the active task is FOR, not every nearby
// drop. taskCollectTargets shares parseEndFactorCriterion with the finish
// gate; droppedItemName guards version-dependent entity metadata.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/item_collect_targets_offline.mjs
import assert from 'node:assert';
import { taskCollectTargets } from '../src/agent/verify.js';
import { droppedItemName } from '../src/agent/library/world.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. No task → no targets → mode stays hands-off (the dirt-loop scenario).
{
    assert.deepStrictEqual(taskCollectTargets(null), []);
    assert.deepStrictEqual(taskCollectTargets(undefined), []);
    ok('no task → [] (idle bot ignores nearby drops)');
}

// 2. Delta end_factor targets its item.
{
    assert.deepStrictEqual(taskCollectTargets({ endFactor: '+10 cobblestone' }), ['cobblestone']);
    ok('delta "+10 cobblestone" → [cobblestone]');
}

// 3. Absolute end_factor targets its item.
{
    assert.deepStrictEqual(taskCollectTargets({ endFactor: 'at least 5 oak_log in inventory' }), ['oak_log']);
    ok('absolute "at least 5 oak_log in inventory" → [oak_log]');
}

// 4. Multi criterion targets every listed item.
{
    assert.deepStrictEqual(taskCollectTargets({ endFactor: 'bucket and iron_pickaxe in inventory' }), ['bucket', 'iron_pickaxe']);
    ok('multi "bucket and iron_pickaxe" → both targeted');
}

// 5. Unmeasurable criterion (goto/chat shapes) → no targets, honest hands-off.
{
    assert.deepStrictEqual(taskCollectTargets({ endFactor: 'bot within 3 of p1' }), []);
    assert.deepStrictEqual(taskCollectTargets({ endFactor: '' }), []);
    ok('non-item criterion → [] (same shapes the referee marks honor_system)');
}

// 6. droppedItemName: reads the item name, null for non-items, never throws.
{
    assert.strictEqual(droppedItemName({ getDroppedItem: () => ({ name: 'dirt' }) }), 'dirt');
    assert.strictEqual(droppedItemName({ getDroppedItem: () => null }), null);
    assert.strictEqual(droppedItemName({ getDroppedItem: () => { throw new Error('partial metadata'); } }), null);
    assert.strictEqual(droppedItemName(null), null);
    ok('droppedItemName: name | null, throw-safe on partial metadata');
}

// 7. The incident end-to-end at predicate level: active task "+30 raw_iron",
//    owner mines dirt nearby → dirt drop filtered out, raw_iron drop accepted.
{
    const targets = taskCollectTargets({ endFactor: '+30 raw_iron' });
    const dirtDrop = { name: 'item', getDroppedItem: () => ({ name: 'dirt' }) };
    const ironDrop = { name: 'item', getDroppedItem: () => ({ name: 'raw_iron' }) };
    assert.strictEqual(targets.includes(droppedItemName(dirtDrop)), false);
    assert.strictEqual(targets.includes(droppedItemName(ironDrop)), true);
    ok('predicate: dirt drop ignored, raw_iron drop collected during "+30 raw_iron"');
}

console.log(`\nitem_collect_targets_offline: ${pass} checks passed`);
