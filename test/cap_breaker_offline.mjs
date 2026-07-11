// Offline checks for the HARD_CAP circuit-breaker: two consecutive capped
// invokes on the same task with no end-factor movement must cancel the task
// in code and tell the owner (live: "get 2 string by killing spiders" in a
// peaceful world — the drive re-nudged it forever, 12 rounds per nudge).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/cap_breaker_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';

mc.ensureMcData('1.21.11');

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// items: mutable array backing bot.inventory.items() so tests can fake progress.
const mkAgent = (items = []) => {
    const cancelled = [];
    const said = [];
    const noted = [];
    const agent = {
        bot: { inventory: { items: () => items, get slots() { return items; } } },
        last_sender: 'system',
        task_queue: {
            tasks: [{ id: 299, description: 'Get 2 string by killing spiders', endFactor: '2 string in inventory', status: 'in_progress' }],
            cancelTask(id) {
                cancelled.push(id);
                this.tasks = this.tasks.filter(t => t.id !== Number(id));
                return { ok: true, message: `Cancelled task #${id}` };
            },
        },
        history: { add: (_role, msg) => noted.push(msg) },
        openChat: (msg) => said.push(msg),
    };
    return { agent, cancelled, said, noted };
};

// Endless-toolCalls mock: every handleEvent runs a full invoke to HARD_CAP.
const mkCappingOrch = (agent) => new OrchestratorV2(agent, {
    promptWithTools: async () => ({ text: null, toolCalls: [{ id: 't' + Math.random(), name: 'fakeMove', args: {} }] }),
    getSystemPrompt: async () => '',
});

// --- one cap = strike, two caps with no progress = cancel + say + history note ---
{
    const { agent, cancelled, said, noted } = mkAgent([]);
    const orch = mkCappingOrch(agent);

    await orch.handleEvent({ type: 'user_message', source: 'system', content: '[drive] nudge' });
    assert(cancelled.length === 0, 'first cap must only strike, not cancel');
    assert(orch._capStrikes?.taskId === 299 && orch._capStrikes?.count === 1, 'strike 1 recorded');
    ok('first HARD_CAP on a task → strike, no cancel');

    await orch.handleEvent({ type: 'user_message', source: 'system', content: '[drive] nudge' });
    assert.deepStrictEqual(cancelled, [299], `second no-progress cap must cancel #299, got ${JSON.stringify(cancelled)}`);
    assert(said.length === 1 && said[0].includes('Get 2 string'), 'owner is told in chat');
    // The note must land in the ORCHESTRATOR's own history (what the LLM
    // reads next invoke) — agent.history is archival and never prompted.
    assert(orch.history.some(h => h.role === 'user' && String(h.content).includes('[cap-breaker]')),
        'LLM-visible history gets the cap-breaker note');
    assert(noted.length === 0, 'archival agent.history is not used for the note');
    assert(orch._capStrikes === null, 'strikes reset after the break');
    ok('second no-progress HARD_CAP → task cancelled in code + owner told');
}

// --- progress between caps resets the strike (no cancel) ---
{
    const items = [];
    const { agent, cancelled } = mkAgent(items);
    const orch = mkCappingOrch(agent);

    await orch.handleEvent({ type: 'user_message', source: 'system', content: '[drive] nudge' });
    items.push({ name: 'string', count: 1 }); // partial progress: 1/2 string
    await orch.handleEvent({ type: 'user_message', source: 'system', content: '[drive] nudge' });
    assert(cancelled.length === 0, 'progress between caps must not cancel');
    assert(orch._capStrikes?.count === 1, `fingerprint moved → back to strike 1, got ${orch._capStrikes?.count}`);
    ok('end-factor movement between caps resets the strike');
}

// --- a different task between caps resets the strike ---
{
    const { agent, cancelled } = mkAgent([]);
    const orch = mkCappingOrch(agent);

    await orch.handleEvent({ type: 'user_message', source: 'system', content: '[drive] nudge' });
    agent.task_queue.tasks = [{ id: 300, description: 'Craft a fishing rod', endFactor: 'fishing_rod in inventory', status: 'in_progress' }];
    await orch.handleEvent({ type: 'user_message', source: 'system', content: '[drive] nudge' });
    assert(cancelled.length === 0, 'task switch between caps must not cancel');
    assert(orch._capStrikes?.taskId === 300 && orch._capStrikes?.count === 1, 'strikes rekeyed to the new task');
    ok('different active task between caps → strikes rekeyed, no cancel');
}

// --- no active task at cap time → no crash, strikes cleared ---
{
    const { agent, cancelled } = mkAgent([]);
    agent.task_queue.tasks = [];
    const orch = mkCappingOrch(agent);
    orch._capStrikes = { taskId: 299, fingerprint: 'stale', count: 1 };
    await orch.handleEvent({ type: 'user_message', source: 'system', content: 'hi' });
    assert(cancelled.length === 0 && orch._capStrikes === null, 'no active task → strikes cleared, nothing cancelled');
    ok('cap with no active task clears stale strikes safely');
}

console.log(`\ncap_breaker_offline: ${pass} checks passed`);
