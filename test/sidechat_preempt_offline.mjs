// Offline checks for the P0 say-do fix. A body-touching command in a mid-task
// side-chat reply means the player gave a TASK-RELATED directive — user intent
// outranks the running task, so it must PREEMPT, not get deferred while the bot
// narrates an action it won't take (the "said it'd go to the chest but kept
// mining" bug). This asserts classifySideChatReply against the REAL command
// parser + concurrency-safe classifier (no mocks).
// Run: ~/.nvm/versions/node/v20.20.2/bin/node test/sidechat_preempt_offline.mjs
import assert from 'node:assert';
import { classifySideChatReply } from '../src/agent/classify_and_gate.js';
import { findAllCommandSpans, getCommand } from '../src/agent/commands/index.js';
import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';

const deps = { findAllCommandSpans, getCommand };
let pass = 0;
const ok = (label) => { console.log('  ok -', label); pass++; };

// 1. The reported bug verbatim: "heading to the chest" prose + a body command.
{
    const res = 'Heading to base to grab the 3 diamonds you put in the chest, then I\'ll craft the axe! !goToCoordinates(643,71,324,3)';
    const d = classifySideChatReply(res, deps);
    assert.strictEqual(d.preempt, true);
    assert.ok(d.body.includes('!goToCoordinates'));
    ok('body command (!goToCoordinates) in a mid-task reply → preempt (the reported bug)');
}

// 2. The incident's other reply — !goToRememberedPlace → also a directive.
{
    const res = 'Let me go to the base chest to grab the diamonds. !goToRememberedPlace("lospollos929-base")';
    assert.strictEqual(classifySideChatReply(res, deps).preempt, true);
    ok('!goToRememberedPlace → preempt');
}

// 3. Pure chit-chat → no commands, no preempt (task left undisturbed).
{
    const d = classifySideChatReply('haha nice, good work out there!', deps);
    assert.strictEqual(d.hasCommands, false);
    assert.strictEqual(d.preempt, false);
    ok('pure chit-chat → no preempt (task undisturbed)');
}

// 4. A concurrency-safe command (!rememberHere) alone → run in place, no preempt.
{
    const d = classifySideChatReply('Saving this spot. !rememberHere("home")', deps);
    assert.strictEqual(d.preempt, false);
    assert.ok(d.safe.includes('!rememberHere'));
    ok('safe command (!rememberHere) → no preempt, executes in place');
}

// 5. Mixed safe + body → the body command wins (a directive is present).
{
    const res = '!rememberHere("here") and then !goToCoordinates(1,2,3)';
    const d = classifySideChatReply(res, deps);
    assert.strictEqual(d.preempt, true);
    assert.ok(d.body.includes('!goToCoordinates'));
    assert.ok(d.safe.includes('!rememberHere'));
    ok('mixed safe + body command → preempt (body wins)');
}

// 6. Orchestrator guard: a user_message arriving mid-invoke queues AND requests
//    a body interrupt (so the running task action stops and the message drains
//    next). Non-user events (checkpoint) queue WITHOUT interrupting.
{
    const calls = { interrupt: 0 };
    const agent = { bot: {}, last_sender: 'P', requestInterrupt: () => { calls.interrupt++; } };
    const orch = new OrchestratorV2(agent, { promptWithTools: async () => ({}), getSystemPrompt: async () => '' });
    orch.invoking = true; // simulate an in-flight task action

    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'go to the chest' });
    assert.strictEqual(calls.interrupt, 1);
    assert.strictEqual(orch.pendingEvents.length, 1);
    ok('mid-invoke user_message → queued + body interrupt requested');

    await orch.handleEvent({ type: 'checkpoint', content: 'tick' });
    assert.strictEqual(calls.interrupt, 1); // unchanged — checkpoints don't preempt
    assert.strictEqual(orch.pendingEvents.length, 2);
    ok('mid-invoke checkpoint → queued, no interrupt (only user intent preempts)');
}

console.log(`\nALL PASS (${pass} checks)`);
