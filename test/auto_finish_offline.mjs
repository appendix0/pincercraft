// Offline checks for the deterministic task-end reflex (drive-loop auto-finish).
// The bot held 20 diamonds but wandered for minutes before the LLM noticed and
// called !finishTask. Now the drive loop finishes a task in CODE the moment its
// countable end_factor is satisfied. This mirrors that exact decision +
// finish, asserting it against the real verifyEndFactor + TaskQueue.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/auto_finish_offline.mjs
import assert from 'node:assert';
import { TaskQueue } from '../src/agent/task_queue.js';
import { verifyEndFactor } from '../src/agent/verify.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// Fake bot whose inventory holds the given { name: count } stacks.
const botWith = (counts) => ({
    inventory: { items: () => Object.entries(counts).map(([name, count]) => ({ name, count })) },
});
const newQueue = () => new TaskQueue('Test', null, () => false, { persist: false });

// The exact decision the drive loop makes, extracted verbatim.
function driveAutoFinish(agent, queue) {
    const active = queue.tasks.find(t => t.status === 'in_progress');
    if (!active) return false;
    const ef = verifyEndFactor(agent, active);
    if (ef.programmatic && ef.verified) { queue.finishTask(active.id); return true; }
    return false;
}

// 1. The reported bug: 20 diamonds in inventory, count end_factor met → finish.
{
    const q = newQueue();
    q.addTask('Mine 20 diamonds', '20 or more diamond in inventory');
    const finished = driveAutoFinish({ bot: botWith({ diamond: 20 }) }, q);
    assert.strictEqual(finished, true);
    assert.strictEqual(q.tasks.find(t => t.id === 1).status, 'done');
    ok('20/20 diamonds → task auto-finished deterministically (the reported bug)');
}

// 2. Under target → NOT finished; stays in_progress for the LLM to keep working.
{
    const q = newQueue();
    q.addTask('Mine 20 diamonds', '20 or more diamond in inventory');
    const finished = driveAutoFinish({ bot: botWith({ diamond: 19 }) }, q);
    assert.strictEqual(finished, false);
    assert.strictEqual(q.tasks[0].status, 'in_progress');
    ok('19/20 → not finished (no premature close)');
}

// 3. Non-countable end_factor → programmatic:false → never auto-finished (left
//    to the LLM/judgment, e.g. "tell the player").
{
    const q = newQueue();
    q.addTask('Tell the player it is done', 'player notified');
    const finished = driveAutoFinish({ bot: botWith({ diamond: 99 }) }, q);
    assert.strictEqual(finished, false);
    assert.strictEqual(q.tasks[0].status, 'in_progress');
    ok('non-countable end_factor → left to the LLM (not auto-finished)');
}

// 4. Auto-finish advances the queue: finishing the met task auto-starts the
//    next pending one, so a multi-step plan keeps moving without the LLM.
{
    const q = newQueue();
    q.addTask('Mine 10 diamonds', '10 or more diamond in inventory'); // in_progress
    q.addTask('Tell player the diamonds are ready', 'player notified'); // pending
    const finished = driveAutoFinish({ bot: botWith({ diamond: 12 }) }, q);
    assert.strictEqual(finished, true);
    assert.strictEqual(q.tasks.find(t => t.description.startsWith('Mine')).status, 'done');
    assert.strictEqual(q.tasks.find(t => t.description.startsWith('Tell')).status, 'in_progress');
    ok('finishing a met task auto-starts the next pending task');
}

// 5. Delta-style end_factor ("+N this run") verifies against the start snapshot,
//    so it auto-finishes only on a real gain — not pre-existing stock.
{
    const q = newQueue();
    q.addTask('Mine cobblestone', '+10 cobblestone in inventory');
    q.tasks[0].startItemCount = 4;            // snapshot taken at task start
    // Pre-existing 4, now 14 → gained 10 → met.
    assert.strictEqual(driveAutoFinish({ bot: botWith({ cobblestone: 14 }) }, q), true);
    ok('delta end_factor (+10) auto-finishes on a real gain from the snapshot');

    const q2 = newQueue();
    q2.addTask('Mine cobblestone', '+10 cobblestone in inventory');
    q2.tasks[0].startItemCount = 14;          // already had 14 at start
    // Still 14 → gained 0 → NOT met (would-be false-finish on pre-existing stock).
    assert.strictEqual(driveAutoFinish({ bot: botWith({ cobblestone: 14 }) }, q2), false);
    ok('delta end_factor does NOT finish on pre-existing stock (no gain)');
}

console.log(`\nALL PASS (${pass} checks)`);
