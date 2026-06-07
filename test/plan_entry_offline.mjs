// Offline contract for LLM-judged plan-mode entry (P1 decomposition half).
// "Is this hard enough to need a decomposed plan?" is a JUDGMENT, so the LLM
// rates difficulty 1-10 and CODE owns the threshold (>7 → plan). This locks the
// deterministic pieces around that call: the explicit fast-path, the cheap
// "worth rating?" pre-filter, the score parser, and the threshold gate. The LLM
// rating itself is live-only. Per feedback_pincercraft_llm_led_smarts.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/plan_entry_offline.mjs
import assert from 'node:assert';
import {
    detectPlanRequest,
    looksActionable,
    parseDifficultyScore,
    PLAN_MODE_DIFFICULTY_THRESHOLD,
} from '../src/agent/classify_and_gate.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };
const shouldPlan = (score) => score !== null && score > PLAN_MODE_DIFFICULTY_THRESHOLD;

// 1. Explicit planning language → deterministic fast-path (plan without rating).
for (const m of ['make a plan to build a base', 'do it step by step', 'first get wood then build a hut']) {
    assert.strictEqual(detectPlanRequest(m), true, m);
}
// ...and routine/build requests are NOT the explicit fast-path (they go to the rater).
for (const m of ['build a watch tower', 'get 64 logs', 'mine 20 diamonds']) {
    assert.strictEqual(detectPlanRequest(m), false, m);
}
ok('detectPlanRequest = explicit-plan fast-path only (builds/gathers go to the LLM rater)');

// 2. The "worth rating?" pre-filter: actionable requests (incl. builds the old
//    regex missed, like "make a sky fortress") get rated; pure chat does not.
for (const m of ['build a watch tower', 'make a sky fortress', 'get 64 logs', 'give me dirt', 'set up an iron farm']) {
    assert.strictEqual(looksActionable(m), true, m);
}
for (const m of ['lol nice', 'good job', 'how are you', 'thanks!']) {
    assert.strictEqual(looksActionable(m), false, m);
}
ok('looksActionable: actionable requests rated (inc. "make a sky fortress"); chit-chat skipped');

// 3. Score parser: pulls 1-10 from varied replies; null on garbage / out of range.
assert.strictEqual(parseDifficultyScore('8'), 8);
assert.strictEqual(parseDifficultyScore('Difficulty: 9/10'), 9);
assert.strictEqual(parseDifficultyScore('I rate this a 3.'), 3);
assert.strictEqual(parseDifficultyScore('10'), 10);
assert.strictEqual(parseDifficultyScore('nonsense'), null);
assert.strictEqual(parseDifficultyScore(''), null);
assert.strictEqual(parseDifficultyScore(null), null);
ok('parseDifficultyScore: extracts 1-10 from varied replies, null on garbage');

// 4. Threshold gate (code owns >7): an 8 plans, a 7 does not, null does not.
assert.strictEqual(PLAN_MODE_DIFFICULTY_THRESHOLD, 7);
assert.strictEqual(shouldPlan(8), true);   // "build a watch tower" range
assert.strictEqual(shouldPlan(7), false);  // borderline → execute
assert.strictEqual(shouldPlan(2), false);  // "mine 64 logs" range
assert.strictEqual(shouldPlan(null), false); // rating failed → fail safe to execute
ok('threshold gate: score>7 plans (8 yes, 7 no, routine no, null fails safe)');

console.log(`\nALL PASS (${pass} checks)`);
