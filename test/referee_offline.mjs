// Offline check for the eval referee (eval/referee.mjs) — the independent
// success verdict that replaced `success = (queue said done)` in loop.sh.
// The original bug: the eval label trusted the bot's self-reported finish, so
// an honor-system false-done (task #224/#225/#264 family) was recorded as
// success=1. The referee shares the end_factor grammar with the bot-side gate
// (src/agent/verify.js parseEndFactorCriterion) but measures against its OWN
// pre/post inventory snapshots. This pins the grammar, the queue.log ef=
// extraction, and the verdict math — no MCP or live bot needed.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/referee_offline.mjs
import assert from 'node:assert';
import { parseEndFactorCriterion } from '../src/agent/verify.js';
import { extractTaskFromLog, evaluateCriterion } from '../eval/referee.mjs';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. Criterion grammar — delta vs absolute vs multi, and the shapes that must
//    stay unparseable (referee falls back to honor_system, never guesses).
{
    assert.deepStrictEqual(parseEndFactorCriterion('+6 cobblestone'),
        { kind: 'delta', item: 'cobblestone', count: 6 });
    assert.deepStrictEqual(parseEndFactorCriterion('cobblestone count has increased by at least 10'),
        { kind: 'delta', item: 'cobblestone', count: 10 });
    assert.deepStrictEqual(parseEndFactorCriterion('at least 5 new oak_log collected this run'),
        { kind: 'delta', item: 'oak_log', count: 5 });
    assert.deepStrictEqual(parseEndFactorCriterion('at least 20 iron_ore in inventory'),
        { kind: 'absolute', item: 'iron_ore', count: 20 });
    assert.deepStrictEqual(parseEndFactorCriterion('iron_pickaxe in inventory'),
        { kind: 'absolute', item: 'iron_pickaxe', count: 1 });
    assert.deepStrictEqual(parseEndFactorCriterion('bucket and lava_bucket in inventory'),
        { kind: 'multi', items: ['bucket', 'lava_bucket'] });
    assert.strictEqual(parseEndFactorCriterion('bot within 3 blocks of p1'), null);
    assert.strictEqual(parseEndFactorCriterion('greeting said in chat'), null);
    ok('criterion grammar: delta / absolute / multi / unparseable');
}

// 2. queue.log ef= extraction — with and without the trailing field, and with
//    escaped quotes inside the description.
{
    const log = [
        '2026-07-04T00:00:00.000Z [Daedelus404] add+start #301 in_progress "Mine 6 cobblestone" ef="+6 cobblestone"',
        '2026-07-04T00:00:01.000Z [Daedelus404] add #302 pending "Say \\"hi\\" to LosPollos929" ef="greeting said in chat"',
        '2026-07-04T00:00:02.000Z [Daedelus404] add+start #303 in_progress "Legacy line without ef field"',
        '2026-07-04T00:00:03.000Z [Daedelus404] finish #301 done "Mine 6 cobblestone" ef="+6 cobblestone"',
    ].join('\n');
    assert.deepStrictEqual(extractTaskFromLog(log, 301),
        { description: 'Mine 6 cobblestone', end_factor: '+6 cobblestone' });
    assert.deepStrictEqual(extractTaskFromLog(log, 302),
        { description: 'Say "hi" to LosPollos929', end_factor: 'greeting said in chat' });
    assert.deepStrictEqual(extractTaskFromLog(log, 303),
        { description: 'Legacy line without ef field', end_factor: null });
    assert.strictEqual(extractTaskFromLog(log, 999), null);
    ok('queue.log extraction: ef= field, escaped quotes, legacy lines');
}

// 3. Verdict math — the false-done case the referee exists to catch: bot
//    started with stock, mined NOTHING, queue said done. An absolute check
//    would false-pass on the pre-existing 20; the delta check fails it.
{
    const c = parseEndFactorCriterion('+6 cobblestone');
    const v = evaluateCriterion(c, { cobblestone: 20 }, { cobblestone: 20 });
    assert.strictEqual(v.verified, false);
    assert.match(v.observed, /cobblestone\+0/);
    ok('delta: false-done caught (stock unchanged, queue said done)');
}
{
    const c = parseEndFactorCriterion('+6 cobblestone');
    assert.strictEqual(evaluateCriterion(c, { cobblestone: 20 }, { cobblestone: 26 }).verified, true);
    assert.strictEqual(evaluateCriterion(c, {}, { cobblestone: 5 }).verified, false);
    assert.strictEqual(evaluateCriterion(c, {}, { cobblestone: 6 }).verified, true);
    ok('delta: gain measured against snapshot, absent items count as 0');
}
{
    const c = parseEndFactorCriterion('at least 3 iron_ingot in inventory');
    assert.strictEqual(evaluateCriterion(c, {}, { iron_ingot: 3 }).verified, true);
    assert.strictEqual(evaluateCriterion(c, {}, { iron_ingot: 1 }).verified, false);
    assert.strictEqual(evaluateCriterion(c, {}, {}).verified, false);
    ok('absolute: current count vs target');
}
{
    const c = parseEndFactorCriterion('bucket and lava_bucket in inventory');
    assert.strictEqual(evaluateCriterion(c, {}, { bucket: 1, lava_bucket: 1 }).verified, true);
    const miss = evaluateCriterion(c, {}, { bucket: 1 });
    assert.strictEqual(miss.verified, false);
    assert.match(miss.observed, /lava_bucket/);
    ok('multi: every listed item must be present');
}

// 4. Death-wipe direction check: inventory LOST since snapshot → negative
//    delta stays a fail (ground truth: the task's end state is not met).
{
    const c = parseEndFactorCriterion('+6 cobblestone');
    assert.strictEqual(evaluateCriterion(c, { cobblestone: 20 }, {}).verified, false);
    ok('delta: death/loss (negative gain) is a fail, not a crash');
}

console.log(`\nreferee_offline: ${pass} checks passed`);
