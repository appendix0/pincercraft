// Offline checks for execute-directly referee coverage. Casual asks ("go get
// me some diamonds", difficulty ≤7) used to run with NO task record — no
// end_factor, no verify gate, invisible to the referee and the DB (found live
// 2026-07-05). The difficulty rating call now also extracts a countable GOAL
// as the canonical "+N item" delta; agent.js mints a queue task from it so the
// whole measurement stack engages. Same single LLM round-trip.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/direct_exec_task_offline.mjs
import assert from 'node:assert';
import {
    buildDifficultyRatingPrompt,
    parseDifficultyAndGoal,
    parseDifficultyScore,
} from '../src/agent/classify_and_gate.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. The canonical two-line reply parses to score + canonical goal.
{
    const r = parseDifficultyAndGoal('DIFFICULTY: 3\nGOAL: +30 raw_iron');
    assert.deepStrictEqual(r, { score: 3, goal: '+30 raw_iron' });
    ok('two-line reply → { score: 3, goal: "+30 raw_iron" }');
}

// 2. GOAL: none → goal null (movement/combat/build/give asks stay unmeasured, honestly).
{
    assert.deepStrictEqual(parseDifficultyAndGoal('DIFFICULTY: 2\nGOAL: none'), { score: 2, goal: null });
    assert.deepStrictEqual(parseDifficultyAndGoal('DIFFICULTY: 9\nGOAL: none'), { score: 9, goal: null });
    ok('GOAL: none → goal null (score still parsed, plan-mode gate unaffected)');
}

// 3. Masquerade guard: a goal count must never be read as the difficulty score.
{
    const r = parseDifficultyAndGoal('GOAL: +10 diamond');
    assert.strictEqual(r.score, null);
    assert.strictEqual(r.goal, '+10 diamond');
    ok('missing DIFFICULTY line → score null, goal count not mistaken for score');
}

// 4. Old-style bare-integer reply still yields a score (model drift tolerance).
{
    assert.deepStrictEqual(parseDifficultyAndGoal('3'), { score: 3, goal: null });
    assert.deepStrictEqual(parseDifficultyAndGoal('Difficulty: 9/10'), { score: 9, goal: null });
    ok('legacy single-integer replies still parse (fail-safe compat)');
}

// 5. Garbage → both null → caller executes directly with no task, as before.
{
    assert.deepStrictEqual(parseDifficultyAndGoal('nonsense'), { score: null, goal: null });
    assert.deepStrictEqual(parseDifficultyAndGoal(''), { score: null, goal: null });
    assert.deepStrictEqual(parseDifficultyAndGoal(null), { score: null, goal: null });
    ok('garbage/empty/null → { null, null } (degrades to pre-goal behavior)');
}

// 6. Normalization: case folds, "+" optional, zero-count rejected.
{
    assert.strictEqual(parseDifficultyAndGoal('DIFFICULTY: 3\nGOAL: +5 Diamond').goal, '+5 diamond');
    assert.strictEqual(parseDifficultyAndGoal('DIFFICULTY: 3\nGOAL: 4 oak_log').goal, '+4 oak_log');
    assert.strictEqual(parseDifficultyAndGoal('DIFFICULTY: 3\nGOAL: +0 dirt').goal, null);
    ok('goal normalization: lowercase, + optional, +0 rejected');
}

// 7. The rating prompt actually asks for the two-line format.
{
    const p = buildDifficultyRatingPrompt('go get me some diamonds');
    assert.ok(p.includes('GOAL'), 'prompt mentions GOAL');
    assert.ok(p.includes('DIFFICULTY: <1-10>'), 'prompt pins the reply format');
    assert.ok(p.includes('go get me some diamonds'), 'request embedded');
    ok('rating prompt requests DIFFICULTY + GOAL two-line reply');
}

// 8. parseDifficultyScore itself is untouched (plan-entry test contract).
{
    assert.strictEqual(parseDifficultyScore('8'), 8);
    assert.strictEqual(parseDifficultyScore('nonsense'), null);
    ok('parseDifficultyScore unchanged');
}

console.log(`\ndirect_exec_task_offline: ${pass} checks passed`);
