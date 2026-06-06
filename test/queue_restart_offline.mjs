// C1 (2026-06-06): offline checks for pruneQueueOnStart — the restart prune that
// spares the interrupted in_progress task instead of wiping the whole queue.
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/queue_restart_offline.mjs
import assert from 'node:assert';
import { pruneQueueOnStart } from '../src/agent/task_queue.js';

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

const mixed = JSON.stringify({
    nextId: 256,
    tasks: [
        { id: 253, status: 'done', description: 'craft pickaxe' },
        { id: 254, status: 'pending', description: 'tell player' },
        { id: 255, status: 'in_progress', description: 'Mine 10 diamonds', endFactor: '10 or more diamond in inventory' },
        { id: 250, status: 'pending', description: 'old stale task' },
    ],
});

// The core fix: only the in_progress task survives a restart.
let r = pruneQueueOnStart(mixed);
assert.strictEqual(r.tasks.length, 1);
assert.strictEqual(r.tasks[0].id, 255);
assert.strictEqual(r.tasks[0].status, 'in_progress');
ok('keeps only the in_progress task, drops pending + done');

// nextId stays monotonic so IDs never collide across sessions in queue.log.
assert.strictEqual(r.nextId, 256);
ok('preserves nextId (monotonic IDs across sessions)');

// A delta-style task carries its start snapshot — must survive the restart so
// verifyEndFactor still measures the gain from the original run, not from reboot.
r = pruneQueueOnStart(JSON.stringify({ nextId: 10, tasks: [
    { id: 9, status: 'in_progress', description: 'mine cobble', endFactor: '+10 cobblestone in inventory', startItemCount: 4 },
] }));
assert.strictEqual(r.tasks[0].startItemCount, 4);
ok('keeps startItemCount on the resumed task (delta verification survives)');

// Opt-out restores the old full-wipe behavior.
r = pruneQueueOnStart(mixed, { keepInProgress: false });
assert.strictEqual(r.tasks.length, 0);
assert.strictEqual(r.nextId, 256);
ok('keepInProgress:false → full wipe (old behavior), nextId still kept');

// No in_progress task → nothing to resume, queue empties cleanly.
r = pruneQueueOnStart(JSON.stringify({ nextId: 5, tasks: [
    { id: 4, status: 'pending', description: 'x' },
] }));
assert.strictEqual(r.tasks.length, 0);
assert.strictEqual(r.nextId, 5);
ok('no in_progress task → empty queue, nextId kept');

// Unreadable / empty input → safe fresh start, never throws.
assert.deepStrictEqual(pruneQueueOnStart('not json{'), { nextId: 1, tasks: [] });
assert.deepStrictEqual(pruneQueueOnStart(null), { nextId: 1, tasks: [] });
assert.deepStrictEqual(pruneQueueOnStart('{}'), { nextId: 1, tasks: [] });
ok('unreadable/empty/missing input → fresh {nextId:1, tasks:[]}, no throw');

console.log(`\nALL PASS (${pass} checks)`);
