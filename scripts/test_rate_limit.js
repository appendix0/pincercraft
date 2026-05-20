// v2 Step 1 — Standalone unit test for RateLimitedClient.
//
// Run: `node scripts/test_rate_limit.js`. Exits non-zero on any failure.
// No mocha/jest — keeps zero dev-dep impact. Each block self-asserts.

import { RateLimitedClient } from '../src/models/rate_limited_client.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function assert(cond, label) {
    if (cond) {
        console.log(`  ✓ ${label}`);
    } else {
        console.log(`  ✗ ${label}`);
        failures++;
    }
}

function makeErr({ status, retryAfter } = {}) {
    const e = new Error(`HTTP ${status}`);
    e.status = status;
    if (retryAfter !== undefined) {
        e.headers = { 'retry-after': String(retryAfter) };
    }
    return e;
}

// 1. Happy path — single successful call passes through, throttle adds no real delay
async function test_happy_path() {
    console.log('test_happy_path');
    const c = new RateLimitedClient({ provider: 'test', rpm: 60, log: () => {} });
    const t0 = Date.now();
    const out = await c.send(async () => 'ok');
    const dt = Date.now() - t0;
    assert(out === 'ok', 'send returns inner result');
    assert(dt < 100, `no measurable delay (was ${dt}ms)`);
}

// 2. 429 retry with Retry-After header
async function test_retry_after_header() {
    console.log('test_retry_after_header');
    let n = 0;
    const c = new RateLimitedClient({ provider: 'test', rpm: 60, log: () => {} });
    const t0 = Date.now();
    const out = await c.send(async () => {
        n++;
        if (n === 1) throw makeErr({ status: 429, retryAfter: 1 }); // 1 second
        return 'ok';
    });
    const dt = Date.now() - t0;
    assert(out === 'ok', 'eventually succeeds');
    assert(n === 2, `called twice (was ${n})`);
    assert(dt >= 900 && dt < 2000, `~1s wait per Retry-After (was ${dt}ms)`);
}

// 3. 429 retry with exponential backoff (no header)
async function test_exp_backoff() {
    console.log('test_exp_backoff');
    let n = 0;
    const c = new RateLimitedClient({ provider: 'test', rpm: 60, retryMaxAttempts: 3, log: () => {} });
    const t0 = Date.now();
    const out = await c.send(async () => {
        n++;
        if (n < 3) throw makeErr({ status: 429 });
        return 'ok';
    });
    const dt = Date.now() - t0;
    assert(out === 'ok', 'succeeds on 3rd attempt');
    assert(n === 3, `called 3 times (was ${n})`);
    // 2 backoffs: ~500ms then ~1s, with ±20% jitter. Floor ~1100ms.
    assert(dt >= 1000 && dt < 4000, `backoff totalled ~1.5s (was ${dt}ms)`);
}

// 4. Retries exhausted → original error re-thrown
async function test_retries_exhausted() {
    console.log('test_retries_exhausted');
    let n = 0;
    const c = new RateLimitedClient({ provider: 'test', rpm: 60, retryMaxAttempts: 2, log: () => {} });
    let caught = null;
    try {
        await c.send(async () => {
            n++;
            throw makeErr({ status: 429 });
        });
    } catch (e) {
        caught = e;
    }
    assert(caught !== null, 'throws');
    assert(caught?.status === 429, '429 preserved');
    assert(n === 3, `3 attempts total (initial + 2 retries) (was ${n})`);
}

// 5. Non-429 errors are not retried
async function test_non_429_no_retry() {
    console.log('test_non_429_no_retry');
    let n = 0;
    const c = new RateLimitedClient({ provider: 'test', rpm: 60, log: () => {} });
    let caught = null;
    try {
        await c.send(async () => {
            n++;
            throw makeErr({ status: 500 });
        });
    } catch (e) {
        caught = e;
    }
    assert(caught?.status === 500, '500 thrown');
    assert(n === 1, `called once, not retried (was ${n})`);
}

// 6. Sliding window throttles bursts
async function test_sliding_window() {
    console.log('test_sliding_window');
    // rpm=4 means 5th call within 60s must wait. For test speed we use a tighter
    // window assertion: fire 5 calls back-to-back, expect the 5th to block briefly.
    const c = new RateLimitedClient({ provider: 'test', rpm: 4, log: () => {} });
    const calls = [];
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
        calls.push(c.send(async () => Date.now() - t0));
    }
    const first4 = await Promise.all(calls);
    const fast = first4.every(t => t < 100);
    assert(fast, `first 4 calls fast (${first4.map(t => t + 'ms').join(', ')})`);

    // The 5th would wait ~60s for the window to slide. To keep this test under
    // ten seconds, we verify the bucket logic by asserting the 5th call IS
    // pending (not resolved immediately) — start it and check after 200ms it
    // hasn't resolved.
    let resolved = false;
    const slow = c.send(async () => { resolved = true; return 'late'; });
    await sleep(200);
    assert(!resolved, '5th call blocked by window cap');
    // Don't await `slow` — it would block ~60s. Test harness exits before then.
    void slow;
}

// 7. Concurrent acquires serialize correctly
async function test_concurrent_acquire() {
    console.log('test_concurrent_acquire');
    const c = new RateLimitedClient({ provider: 'test', rpm: 1000, log: () => {} });
    const order = [];
    const tasks = [];
    for (let i = 0; i < 10; i++) {
        tasks.push(c.send(async () => { order.push(i); return i; }));
    }
    const out = await Promise.all(tasks);
    assert(out.length === 10, '10 results');
    assert(order.length === 10, '10 actually ran');
}

// 8. Disabled wrapper passes through with no throttle/retry
async function test_disabled_via_factory() {
    console.log('test_disabled_via_factory');
    // Direct construction with rpm:0 → no throttle but still retry on 429
    const c = new RateLimitedClient({ provider: 'test', rpm: 0, retryMaxAttempts: 1, log: () => {} });
    const t0 = Date.now();
    const out = await c.send(async () => 'ok');
    const dt = Date.now() - t0;
    assert(out === 'ok', 'rpm:0 still works');
    assert(dt < 50, `no throttle delay (was ${dt}ms)`);
}

const tests = [
    test_happy_path,
    test_retry_after_header,
    test_exp_backoff,
    test_retries_exhausted,
    test_non_429_no_retry,
    test_sliding_window,
    test_concurrent_acquire,
    test_disabled_via_factory,
];

for (const t of tests) {
    try {
        await t();
    } catch (e) {
        console.log(`  ✗ ${t.name} threw:`, e?.message || e);
        failures++;
    }
}

if (failures > 0) {
    console.log(`\nFAIL — ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nPASS — all tests green');
process.exit(0);
