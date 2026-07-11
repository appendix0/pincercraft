// Offline checks for deterministic orchestrator parking (say-do: "pausing
// what I'm on" / !stop must actually stop the invoke loop, not leave it
// issuing tools to HARD_CAP) + stop-lexicon additions (standby, told-you-to-stop).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/orch_park_offline.mjs
import assert from 'node:assert';
import * as mc from '../src/utils/mcdata.js';
import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';
import { classifyInput, stopIntentStrength } from '../src/agent/classify_and_gate.js';

mc.ensureMcData('1.21.11');

let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

const mkAgent = () => ({
    bot: { inventory: { get slots() { return [{ name: 'iron_pickaxe', count: 1 }]; } } },
    last_sender: 'system',
});

// --- park stops the invoke loop between LLM rounds ---
{
    let prompts = 0;
    let mode = 'tools';
    let orch;
    orch = new OrchestratorV2(mkAgent(), {
        promptWithTools: async () => {
            prompts++;
            if (mode === 'empty') return {};
            if (prompts === 2) orch.requestPark('test directive');
            return { text: null, toolCalls: [{ id: 't' + prompts, name: 'fakeMove', args: {} }] };
        },
        getSystemPrompt: async () => '',
    });

    await orch.handleEvent({ type: 'user_message', source: 'p1', content: 'go mine' });
    assert(prompts === 2, `park after round 2 must stop the loop at 2 prompts, got ${prompts}`);
    ok('requestPark mid-invoke → loop exits at next round, not HARD_CAP');

    // A fresh invoke must clear the stale flag and actually prompt again.
    mode = 'empty';
    await orch.handleEvent({ type: 'user_message', source: 'p1', content: 'status?' });
    assert(prompts === 3, `fresh invoke must prompt once (flag cleared), got ${prompts}`);
    ok('next invoke starts clean — stale park flag does not insta-park it');
}

// --- without a park, the same endless-toolCalls mock runs to HARD_CAP ---
// (guards the meaning of the test above: the early exit IS the park)
{
    let prompts = 0;
    const orch = new OrchestratorV2(mkAgent(), {
        promptWithTools: async () => {
            prompts++;
            return { text: null, toolCalls: [{ id: 't' + prompts, name: 'fakeMove', args: {} }] };
        },
        getSystemPrompt: async () => '',
    });
    await orch.handleEvent({ type: 'user_message', source: 'p1', content: 'go mine' });
    assert(prompts === 12, `unparked endless mock should hit HARD_CAP=12, got ${prompts}`);
    ok('control: without requestPark the loop runs to HARD_CAP');
}

// --- park between serial tool executions: later calls skipped, results paired ---
{
    let orch;
    const ran = [];
    const cmdA = { name: '!parkA', params: {}, perform: async () => { ran.push('a'); orch.requestPark('mid-batch stop'); return 'ok a'; } };
    const cmdB = { name: '!parkB', params: {}, perform: async () => { ran.push('b'); return 'ok b'; } };
    const registry = { byName: (n) => ({ '!parkA': cmdA, 'parkA': cmdA, '!parkB': cmdB, 'parkB': cmdB })[n] || null };
    orch = new OrchestratorV2(mkAgent(), { promptWithTools: async () => ({}), getSystemPrompt: async () => '', registry });

    const results = await orch.executeTools([
        { id: 'c1', name: 'parkA', args: {} },
        { id: 'c2', name: 'parkB', args: {} },
    ]);
    assert(ran.length === 1 && ran[0] === 'a', `only the first serial call may run, ran=${JSON.stringify(ran)}`);
    assert(results.length === 2 && results[1].id === 'c2', 'skipped call still gets a paired result');
    assert(results[1].isError && String(results[1].content).startsWith('[parked]'),
        `skipped result must be a [parked] error, got ${JSON.stringify(results[1])}`);
    ok('park set by tool #1 → tool #2 skipped with a paired [parked] result');
}

// --- lexicon: standby / stand down / told-you-to-stop ---
{
    assert(stopIntentStrength('standby for now bro') === 'soft', 'standby → soft');
    assert(stopIntentStrength('Great the guide loop worked. standby for now bro') === 'soft', 'standby mid-message → soft');
    assert(stopIntentStrength('stand down') === 'soft', 'stand down → soft');
    ok('standby / stand down → soft pause (the live "standing by" miss)');

    assert(stopIntentStrength('What the fuck I told you to stop') === 'hard', 'told you to stop → hard');
    assert(stopIntentStrength('I asked you to stop') === 'hard', 'asked you to stop → hard');
    ok('"told/asked you to stop" → hard stop (the live swearing miss)');

    // Position instructions and innocent phrasing must NOT trip the reflex.
    assert(stopIntentStrength('go stand by the chest') === null, 'stand by <place> is not a halt');
    assert(stopIntentStrength('stand by my base entrance') === null, 'stand by my X is not a halt');
    assert(stopIntentStrength('I stopped by the lake yesterday') === null, 'narrative "stopped by" is not a halt');
    assert(classifyInput({ kind: 'player_chat', message: 'go stand by the chest' }) === 'followup', 'stand by <place> classifies followup');
    assert(classifyInput({ kind: 'player_chat', message: 'standby for now bro' }) === 'interrupt', 'standby classifies interrupt');
    ok('"stand by the <place>" and narrative phrasing stay non-interrupt');
}

console.log(`\northo_park_offline: ${pass} checks passed`);
