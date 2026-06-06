// C4 (2026-06-06): offline checks for taskProgressLine — the deterministic,
// authoritative "have N / need M" progress line for the active task's target.
// Closes the drift where the LLM eyeballs a gather count (claimed "have 7"
// diamonds when the deterministic count was 2) and plans off the wrong number.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/task_progress_offline.mjs
import assert from 'node:assert';
import { taskProgressLine } from '../src/agent/live_state.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

const agentWith = (...tasks) => ({ task_queue: { tasks } });
const inProgress = (endFactor, id = 255) => ({ id, status: 'in_progress', endFactor });

// Gather target, unmet: the count is authoritative and finishTask is blocked.
let line = taskProgressLine(agentWith(inProgress('10 or more diamond in inventory')), { diamond: 2 });
assert.match(line, /TASK PROGRESS #255 diamond: 2\/10/);
assert.match(line, /8 more to go/);
assert.match(line, /do NOT !finishTask until it reaches 10/);
ok('gather target unmet → authoritative N/M + "do NOT finishTask"');

// Target met: tell the model to finish, not gather more.
line = taskProgressLine(agentWith(inProgress('10 or more diamond in inventory')), { diamond: 12 });
assert.match(line, /TASK PROGRESS #255 diamond: 12\/10 — TARGET MET\. Call !finishTask/);
ok('target met → "TARGET MET. Call !finishTask"');

// Item absent from inventory reads as 0 (not undefined / not crash).
line = taskProgressLine(agentWith(inProgress('iron_pickaxe in inventory')), {});
assert.match(line, /iron_pickaxe: 0\/1 — 1 more to go/);
ok('missing item → 0/target, no crash');

// No active task → no line.
assert.strictEqual(taskProgressLine(agentWith({ id: 1, status: 'pending', endFactor: '3 iron in inventory' }), {}), null);
ok('no in_progress task → null');

// Unparseable end_factor (not an item-count shape) → no line, defers to prose.
assert.strictEqual(taskProgressLine(agentWith(inProgress('player notified')), { diamond: 2 }), null);
ok('unparseable end_factor → null (no false progress line)');

// Defensive: missing agent / queue never throws.
assert.strictEqual(taskProgressLine(undefined, {}), null);
assert.strictEqual(taskProgressLine({}, {}), null);
ok('missing agent/queue → null, no throw');

console.log(`\nALL PASS (${pass} checks)`);
