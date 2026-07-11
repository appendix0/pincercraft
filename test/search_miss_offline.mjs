// Offline checks for the "not found nearby" reflex: with a task in progress,
// an empty search below 256 gets a corrective (one wide search, then stop);
// an empty search at >=256 parks the task + invoke in code and asks the
// player (live: "no spider in 128 blocks" on a peaceful world was shrugged
// off into a 24-round sword yak-shave).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/search_miss_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';

mc.ensureMcData('1.21.11');

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

const mkAgent = () => {
    const said = [];
    const agent = {
        bot: { inventory: { items: () => [], get slots() { return []; } } },
        last_sender: 'system',
        task_queue: {
            tasks: [{ id: 299, description: 'Get 2 string by killing spiders', endFactor: '2 string in inventory', status: 'in_progress' }],
            demoteActive() {
                const t = this.tasks.find(x => x.status === 'in_progress');
                if (!t) return null;
                t.status = 'pending';
                return t;
            },
        },
        openChat: (msg) => said.push(msg),
    };
    return { agent, said };
};

const mkOrch = (agent, registry) => new OrchestratorV2(agent, {
    promptWithTools: async () => ({ text: null, toolCalls: [{ id: 't' + Math.random(), name: 'searchForEntity', args: { type: 'spider', search_range: 256 } }] }),
    getSystemPrompt: async () => '',
    registry,
});

// --- integration: wide miss parks task + invoke, asks the player ---
{
    const { agent, said } = mkAgent();
    let prompts = 0;
    const cmd = {
        name: '!searchForEntity',
        params: { type: {}, search_range: {} },
        perform: async () => 'Action output:\nCould not find any spider in 256 blocks.\n',
    };
    const registry = {
        byName: (n) => (n === '!searchForEntity' || n === 'searchForEntity') ? cmd : null,
        forLLM: () => [],
        forPlanMode: () => [],
        toolDescriptorsForLLM: () => [],
    };
    const orch = new OrchestratorV2(agent, {
        promptWithTools: async () => { prompts++; return { text: null, toolCalls: [{ id: 't' + prompts, name: 'searchForEntity', args: { type: 'spider', search_range: 256 } }] }; },
        getSystemPrompt: async () => '',
        registry,
    });

    await orch.handleEvent({ type: 'user_message', source: 'p1', content: 'get string' });
    assert(prompts === 1, `wide miss must park the invoke after round 1, got ${prompts} prompts`);
    assert(agent.task_queue.tasks[0].status === 'pending', 'task must be demoted to pending (drive goes silent)');
    assert(said.length === 1 && said[0].includes('spider') && said[0].includes('exploring'), `player must be asked, got ${JSON.stringify(said)}`);
    const lastResult = orch.history.findLast(h => h.role === 'tool_result');
    assert(lastResult.toolResults[0].content.includes('[search miss]') && lastResult.toolResults[0].content.includes('!startTask(299)'),
        'tool result must carry the wait-for-answer instruction');
    ok('256-block miss with a task → task parked, invoke parked, player asked');
}

// --- unit: sub-256 miss appends corrective only ---
{
    const { agent, said } = mkAgent();
    const orch = mkOrch(agent, { byName: () => null });
    const res = { id: 'x', name: 'searchForEntity', isError: false, content: 'Action output:\nCould not find any spider in 128 blocks.\n' };
    orch._searchMissReflex(res);
    assert(res.content.includes('[search miss]') && res.content.includes('search ONCE at 256'), 'corrective must steer to one wide search');
    assert(agent.task_queue.tasks[0].status === 'in_progress', 'sub-256 miss must not demote the task');
    assert(orch._parkRequested === null && said.length === 0, 'sub-256 miss must not park or chat');
    ok('sub-256 miss → corrective appended, no park, no ask');
}

// --- unit: "within N blocks." variant triggers too ---
{
    const { agent } = mkAgent();
    const orch = mkOrch(agent, { byName: () => null });
    const res = { id: 'x', name: 'findAndMine', isError: false, content: 'Could not find any cobweb within 256 blocks.' };
    orch._searchMissReflex(res);
    assert(agent.task_queue.tasks[0].status === 'pending' && orch._parkRequested, '"within" phrasing must trigger the wide-miss reflex');
    ok('"within N blocks." phrasing triggers the reflex');
}

// --- unit: water-search fallback continuation must NOT trigger ---
{
    const { agent, said } = mkAgent();
    const orch = mkOrch(agent, { byName: () => null });
    const res = { id: 'x', name: 'newAction', isError: false, content: 'Could not find any water in 256 blocks, looking for uncollectable flowing instead...' };
    orch._searchMissReflex(res);
    assert(!res.content.includes('[search miss]') && orch._parkRequested === null && said.length === 0,
        'non-terminal fallback line must be ignored');
    ok('water-fallback "blocks, looking for..." line does not trigger');
}

// --- unit: no active task → untouched ---
{
    const { agent, said } = mkAgent();
    agent.task_queue.tasks = [];
    const orch = mkOrch(agent, { byName: () => null });
    const res = { id: 'x', name: 'searchForEntity', isError: false, content: 'Could not find any spider in 256 blocks.' };
    const before = res.content;
    orch._searchMissReflex(res);
    assert(res.content === before && orch._parkRequested === null && said.length === 0, 'no task → reflex is a no-op');
    ok('miss with no active task → no-op (ad-hoc player question stays plain)');
}

console.log(`\nsearch_miss_offline: ${pass} checks passed`);
