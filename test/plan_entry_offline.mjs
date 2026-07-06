// Offline contract for task-request decomposition + plan-mode entry.
// The LLM difficulty rating (1-10, plan when >7) was REMOVED 2026-07-06: it
// routed everything scoring ≤7 into ONE monolithic auto-minted task, bypassing
// the per-step deterministic stack (torch episode #285). The contract now:
//   - EVERY actionable ask (looksActionable) gets TASK_REQUEST_NUDGE → the LLM
//     decomposes into per-step !addTask calls with observable end_factors.
//   - Only explicit planning language (detectPlanRequest) enters approval-wait
//     plan mode.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/plan_entry_offline.mjs
import assert from 'node:assert';
import {
    detectPlanRequest,
    looksActionable,
    nudgesForUserMessage,
    TASK_REQUEST_NUDGE,
} from '../src/agent/classify_and_gate.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. Explicit planning language → deterministic plan-mode fast-path.
for (const m of ['make a plan to build a base', 'do it step by step', 'first get wood then build a hut']) {
    assert.strictEqual(detectPlanRequest(m), true, m);
}
// ...and ordinary work orders do NOT enter approval-wait plan mode.
for (const m of ['build a watch tower', 'get 64 logs', 'mine 20 diamonds', 'make me 16 torches']) {
    assert.strictEqual(detectPlanRequest(m), false, m);
}
ok('detectPlanRequest = explicit-plan language only (work orders decompose + execute)');

// 2. looksActionable gates the decomposition nudge: any action verb counts,
//    including casual single-item asks; chit-chat never nudges.
for (const m of ['build a watch tower', 'make a sky fortress', 'get 64 logs', 'give me dirt', 'set up an iron farm', 'craft me a diamond axe', 'make me 16 torches']) {
    assert.strictEqual(looksActionable(m), true, m);
}
for (const m of ['lol nice', 'good job', 'how are you', 'thanks!']) {
    assert.strictEqual(looksActionable(m), false, m);
}
ok('looksActionable: all actionable asks in (incl. casual crafts); chit-chat out');

// 3. nudgesForUserMessage injects the decomposition nudge for every actionable
//    ask — the torch-episode regression: "make me 16 torches" MUST decompose.
assert.ok(nudgesForUserMessage('make me 16 torches').includes(TASK_REQUEST_NUDGE));
assert.ok(nudgesForUserMessage('craft me a diamond axe').includes(TASK_REQUEST_NUDGE));
assert.ok(nudgesForUserMessage('give me dirt').includes(TASK_REQUEST_NUDGE));
assert.ok(!nudgesForUserMessage('good job').includes(TASK_REQUEST_NUDGE));
ok('nudgesForUserMessage: TASK_REQUEST_NUDGE on every actionable ask');

// 4. Self-prompts / other bots carry no player intent → no nudges.
assert.deepStrictEqual(nudgesForUserMessage('make me 16 torches', { self_prompt: true }), []);
assert.deepStrictEqual(nudgesForUserMessage('make me 16 torches', { from_other_bot: true }), []);
ok('self-prompt / other-bot messages never nudge');

// 5. The nudge itself pins the decomposition contract the deterministic stack
//    needs: per-ingredient acquisition steps, observable "+N item" end_factors,
//    objective imperative descriptions (not the player's words).
assert.ok(TASK_REQUEST_NUDGE.includes('!addTask'), 'demands !addTask');
assert.ok(TASK_REQUEST_NUDGE.includes('one acquisition task per missing ingredient'), 'ingredient decomposition');
assert.ok(TASK_REQUEST_NUDGE.includes('+N item'), 'canonical countable end_factors');
assert.ok(TASK_REQUEST_NUDGE.includes('never the player'), 'objective descriptions, not verbatim echo');
ok('TASK_REQUEST_NUDGE pins ingredient-level decomposition + observable end_factors');

console.log(`\nALL PASS (${pass} checks)`);
