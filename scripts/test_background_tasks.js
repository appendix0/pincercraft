// v2 Step 5 — Unit tests for BackgroundTasks.
// Run: node scripts/test_background_tasks.js. No real bot.

import { BackgroundTasks } from '../src/agent/background_tasks.js';

let failures = 0;
function assert(cond, label, info) {
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label}`, info ?? ''); failures++; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 1. spawn returns handle synchronously
console.log('test_spawn_returns_immediately');
{
    const bg = new BackgroundTasks();
    const t0 = Date.now();
    const { status, handle } = bg.spawn({
        toolName: 'slow',
        args: {},
        run: async () => { await sleep(100); return 'done'; },
        onComplete: () => {},
    });
    const dt = Date.now() - t0;
    assert(status === 'started', 'status started');
    assert(handle === 'bg-1', `handle = bg-1 (got ${handle})`);
    assert(dt < 20, `spawn returned <20ms (got ${dt})`);
}

// 2. onComplete fires with result after run resolves
console.log('test_oncomplete_success');
{
    const bg = new BackgroundTasks();
    let completion = null;
    bg.spawn({
        toolName: 'fast',
        args: { x: 1 },
        run: async () => 'value-42',
        onComplete: (p) => { completion = p; },
    });
    await sleep(30);
    assert(completion !== null, 'onComplete fired');
    assert(completion.result === 'value-42', 'result delivered');
    assert(completion.toolName === 'fast', 'toolName delivered');
    assert(completion.cancelled === undefined, 'not cancelled');
    assert(completion.error === undefined, 'no error');
    assert(bg.handles.size === 0, 'handle cleaned up after completion');
}

// 3. run() throws → onComplete fires with error
console.log('test_oncomplete_error');
{
    const bg = new BackgroundTasks();
    let completion = null;
    bg.spawn({
        toolName: 'boom',
        args: {},
        run: async () => { throw new Error('kaboom'); },
        onComplete: (p) => { completion = p; },
    });
    await sleep(30);
    assert(completion?.error === 'kaboom', 'error message captured');
    assert(completion.result === undefined, 'no result on error');
}

// 4. cancel() triggers AbortController; run respects signal; completion fires as cancelled
console.log('test_cancel_aborts_signal');
{
    const bg = new BackgroundTasks();
    let completion = null;
    let sawAbort = false;
    const { handle } = bg.spawn({
        toolName: 'cancellable',
        args: {},
        run: async (signal) => {
            // Simulate a long-running tool that polls the abort signal.
            for (let i = 0; i < 100; i++) {
                if (signal.aborted) { sawAbort = true; throw new Error('aborted'); }
                await sleep(10);
            }
            return 'finished';
        },
        onComplete: (p) => { completion = p; },
    });
    await sleep(30);
    const cancel = bg.cancel(handle);
    assert(cancel.ok, 'cancel returns ok');
    await sleep(50);
    assert(sawAbort, 'run() saw aborted signal');
    assert(completion?.cancelled === true, 'completion reports cancelled');
    assert(completion.error === undefined, 'cancelled does NOT report as error');
    assert(bg.handles.size === 0, 'handle cleaned up after cancel');
}

// 5. cancel of unknown handle returns ok:false, doesn't throw
console.log('test_cancel_unknown');
{
    const bg = new BackgroundTasks();
    const out = bg.cancel('bg-999');
    assert(out.ok === false, 'ok=false');
    assert(out.message.includes('bg-999'), 'message names the handle');
}

// 6. Concurrent spawns get unique handles
console.log('test_concurrent_handles');
{
    const bg = new BackgroundTasks();
    const completions = [];
    bg.spawn({ toolName: 'a', args: {}, run: async () => { await sleep(20); return 'A'; }, onComplete: (p) => completions.push(p) });
    bg.spawn({ toolName: 'b', args: {}, run: async () => { await sleep(20); return 'B'; }, onComplete: (p) => completions.push(p) });
    bg.spawn({ toolName: 'c', args: {}, run: async () => { await sleep(20); return 'C'; }, onComplete: (p) => completions.push(p) });
    assert(bg.handles.size === 3, '3 handles in flight');
    const snapshot = bg.list();
    const handleSet = new Set(snapshot.map(h => h.handle));
    assert(handleSet.size === 3, '3 unique handles');
    await sleep(60);
    assert(completions.length === 3, 'all 3 completed');
    assert(bg.handles.size === 0, 'all handles cleaned up');
}

// 7. drain() awaits all in-flight, returns count
console.log('test_drain');
{
    const bg = new BackgroundTasks();
    bg.spawn({ toolName: 'a', args: {}, run: async () => { await sleep(20); }, onComplete: () => {} });
    bg.spawn({ toolName: 'b', args: {}, run: async () => { await sleep(20); }, onComplete: () => {} });
    const t0 = Date.now();
    const r = await bg.drain(1000);
    const dt = Date.now() - t0;
    assert(r.drained === 2, 'drained reports 2');
    assert(dt >= 20 && dt < 200, `drain awaited ~20ms (was ${dt})`);
}

// 8. cancelAll() cancels everything then drains
console.log('test_cancel_all');
{
    const bg = new BackgroundTasks();
    let cancelledCount = 0;
    bg.spawn({
        toolName: 'a', args: {},
        run: async (signal) => { for (;;) { if (signal.aborted) throw new Error('abort'); await sleep(10); } },
        onComplete: (p) => { if (p.cancelled) cancelledCount++; },
    });
    bg.spawn({
        toolName: 'b', args: {},
        run: async (signal) => { for (;;) { if (signal.aborted) throw new Error('abort'); await sleep(10); } },
        onComplete: (p) => { if (p.cancelled) cancelledCount++; },
    });
    await sleep(20);
    const r = await bg.cancelAll();
    assert(r.drained === 2, '2 drained after cancelAll');
    assert(cancelledCount === 2, 'both reported cancelled');
    assert(bg.handles.size === 0, 'handles empty');
}

if (failures > 0) {
    console.log(`\nFAIL — ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nPASS — all background_tasks tests green');
process.exit(0);
