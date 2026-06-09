// Offline checks for the deterministic metric TARGET (P1-metric). "Get 30 more"
// is a +30 DELTA, but the LLM encoded it as an absolute "30 raw_iron in
// inventory" → the bot stopped at 30 total (delivered 27 more, not 30). Now code
// rewrites it to the "+30" delta the verify gate already checks against the
// task-start snapshot. The TARGET, not just the count, is deterministic.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/metric_target_offline.mjs
import assert from 'node:assert';
import { normalizeQuantityEndFactor, verifyEndFactor } from '../src/agent/verify.js';
import { parseRelativeQuantity } from '../src/agent/classify_and_gate.js';

const botWith = (counts) => ({ bot: { inventory: { items: () => Object.entries(counts).map(([name, count]) => ({ name, count })) } } });
let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. parseRelativeQuantity detects relative phrasing, null on absolute.
assert.deepStrictEqual(parseRelativeQuantity('Get 30 more, then tell me'), { delta: 30 });
assert.deepStrictEqual(parseRelativeQuantity('mine another 10 diamonds'), { delta: 10 });
assert.deepStrictEqual(parseRelativeQuantity('grab 5 additional logs'), { delta: 5 });
assert.strictEqual(parseRelativeQuantity('get 30 raw iron'), null);
assert.strictEqual(parseRelativeQuantity('build a tower'), null);
ok('parseRelativeQuantity: "N more/additional/extra", "another N" → delta; absolute → null');

// 2. The incident verbatim: "Get 30 more" + absolute end_factor → "+30" delta.
assert.strictEqual(
    normalizeQuantityEndFactor('30 raw_iron in inventory', 'Get 30 more, then tell me'),
    '+30 raw_iron');
ok('"Get 30 more" + "30 raw_iron in inventory" → "+30 raw_iron" (the incident)');

// 3. No relative cue → absolute end_factor left untouched.
assert.strictEqual(
    normalizeQuantityEndFactor('30 raw_iron in inventory', 'get 30 raw iron'),
    '30 raw_iron in inventory');
ok('no "more" cue → absolute target unchanged');

// 4. LLM already did the math (target 33 ≠ delta 30) → left as-is (no clobber).
assert.strictEqual(
    normalizeQuantityEndFactor('33 raw_iron in inventory', 'Get 30 more'),
    '33 raw_iron in inventory');
ok('LLM already computed absolute target (33 ≠ 30) → not rewritten');

// 5. Already a delta → unchanged (no double-rewrite).
assert.strictEqual(normalizeQuantityEndFactor('+30 raw_iron', 'Get 30 more'), '+30 raw_iron');
ok('already-delta end_factor → unchanged');

// 6. End-to-end: the rewritten "+30" needs +30 from the start snapshot (3 → 33),
//    NOT 30 total. So 19 held is NOT done; 33 held IS — the actual bug fixed.
{
    const ef = normalizeQuantityEndFactor('30 raw_iron in inventory', 'Get 30 more');
    const task = { endFactor: ef, startItemCount: 3 }; // snapshot taken when task started (had 3)
    assert.strictEqual(verifyEndFactor(botWith({ raw_iron: 19 }), task).verified, false); // 19−3=16 < 30
    assert.strictEqual(verifyEndFactor(botWith({ raw_iron: 33 }), task).verified, true);  // 33−3=30 ✓
    ok('end-to-end: "+30" delta finishes at +30 from start (3→33), not at 30 total');
}

console.log(`\nALL PASS (${pass} checks)`);
