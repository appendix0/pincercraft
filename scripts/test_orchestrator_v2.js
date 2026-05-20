// v2 Step 4 — Unit tests for OrchestratorV2. Mock LLM + mock registry,
// no real bot / Mineflayer. Run: node scripts/test_orchestrator_v2.js.

import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';

let failures = 0;
function assert(cond, label, info) {
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label}`, info ?? ''); failures++; }
}

// Mock registry. Exposes the same surface OrchestratorV2 uses:
// byName, forLLM, forPlanMode, toolDescriptorsForLLM.
function makeMockRegistry(cmds) {
    const byName = new Map();
    for (const c of cmds) {
        byName.set(c.name, c);
        byName.set(c.name.startsWith('!') ? c.name.slice(1) : c.name, c);
    }
    return {
        byName: (n) => byName.get(n),
        forLLM: () => cmds,
        forPlanMode: () => cmds.filter(c => c.isReadOnly || c.isConcurrencySafe),
        toolDescriptorsForLLM: () => cmds.map(c => ({
            name: c.name.startsWith('!') ? c.name.slice(1) : c.name,
            description: c.description || '',
            input_schema: { type: 'object', properties: c.params || {}, required: Object.keys(c.params || {}) },
            isReadOnly: !!c.isReadOnly,
            isConcurrencySafe: !!c.isConcurrencySafe,
            isLongRunning: !!c.isLongRunning,
            _raw: c,
        })),
    };
}

function makeMockAgent() {
    const calls = [];
    return {
        blocked_actions: [],
        last_sender: 'TestPlayer',
        routeResponse: (to, msg) => { calls.push({ to, msg }); },
        _calls: calls,
        planMode: false,
    };
}

// Helper: build a scripted prompter that returns each scripted resp in order.
function scriptedPrompter(scripts) {
    let idx = 0;
    const callLog = [];
    const fn = async (history, system, tools) => {
        callLog.push({ history: history.length, toolCount: tools.length });
        if (idx >= scripts.length) {
            return { text: null, toolCalls: [], stopReason: 'end_turn' };
        }
        return scripts[idx++];
    };
    fn._log = callLog;
    return fn;
}

// ─────────────────────────────────────────────────────────────────────────

// 1. Empty response → parks immediately
console.log('test_park_on_empty');
{
    const agent = makeMockAgent();
    const reg = makeMockRegistry([]);
    const prompter = scriptedPrompter([
        { text: 'hello there', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'hi' });
    assert(prompter._log.length === 1, 'one LLM call');
    assert(agent._calls.length === 1, 'one chat sent');
    assert(agent._calls[0].msg === 'hello there', 'chat msg correct');
}

// 2. Single tool call → executes → re-invokes → parks
console.log('test_single_tool_call');
{
    const agent = makeMockAgent();
    let calledWith = null;
    const reg = makeMockRegistry([
        { name: '!testTool', isConcurrencySafe: true, params: { x: { type: 'int' } },
          perform: async (a, x) => { calledWith = x; return 'tool result x=' + x; } },
    ]);
    const prompter = scriptedPrompter([
        { text: null, toolCalls: [{ id: 't1', name: 'testTool', args: { x: 42 } }], stopReason: 'tool_use' },
        { text: 'done', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'do it' });
    assert(prompter._log.length === 2, 'two LLM calls (tool then park)');
    assert(calledWith === 42, 'perform received correct arg');
    assert(orch.history.some(h => h.role === 'tool_result' && h.toolResults?.[0]?.content?.includes('x=42')), 'tool result in history');
    assert(agent._calls.length === 1 && agent._calls[0].msg === 'done', 'final park chats text');
}

// 3. Multiple tool calls, mix of safe and unsafe — partition + ordered results
console.log('test_parallel_partition');
{
    const agent = makeMockAgent();
    const execOrder = [];
    const reg = makeMockRegistry([
        { name: '!a', isConcurrencySafe: true, params: {},
          perform: async () => { execOrder.push('a-start'); await new Promise(r => setTimeout(r, 20)); execOrder.push('a-end'); return 'A'; } },
        { name: '!b', isConcurrencySafe: false, params: {},
          perform: async () => { execOrder.push('b-start'); await new Promise(r => setTimeout(r, 20)); execOrder.push('b-end'); return 'B'; } },
        { name: '!c', isConcurrencySafe: true, params: {},
          perform: async () => { execOrder.push('c-start'); await new Promise(r => setTimeout(r, 20)); execOrder.push('c-end'); return 'C'; } },
    ]);
    const prompter = scriptedPrompter([
        { text: null, toolCalls: [
            { id: '1', name: 'a', args: {} },
            { id: '2', name: 'b', args: {} },
            { id: '3', name: 'c', args: {} },
        ], stopReason: 'tool_use' },
        { text: 'done', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'go' });
    // a and c are concurrency-safe → run in parallel (a-start before a-end interleave with c-start)
    const aStart = execOrder.indexOf('a-start');
    const cStart = execOrder.indexOf('c-start');
    const aEnd = execOrder.indexOf('a-end');
    assert(cStart < aEnd, 'c started before a ended (parallel)');
    // results back in call order
    const tr = orch.history.find(h => h.role === 'tool_result');
    assert(tr.toolResults[0].content === 'A', 'result[0] = A (order preserved)');
    assert(tr.toolResults[1].content === 'B', 'result[1] = B');
    assert(tr.toolResults[2].content === 'C', 'result[2] = C');
}

// 4. Unknown tool returns isError tool_result; loop still progresses
console.log('test_unknown_tool');
{
    const agent = makeMockAgent();
    const reg = makeMockRegistry([]);
    const prompter = scriptedPrompter([
        { text: null, toolCalls: [{ id: 't1', name: 'doesnotexist', args: {} }], stopReason: 'tool_use' },
        { text: 'sorry', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'go' });
    const tr = orch.history.find(h => h.role === 'tool_result');
    assert(tr.toolResults[0].isError === true, 'unknown tool flagged isError');
    assert(tr.toolResults[0].content.includes('doesnotexist'), 'error message names the tool');
    assert(prompter._log.length === 2, 'loop continues past unknown tool');
}

// 5. HARD_CAP safety net — LLM keeps emitting tool calls forever
console.log('test_hard_cap');
{
    const agent = makeMockAgent();
    const reg = makeMockRegistry([
        { name: '!noop', isConcurrencySafe: true, params: {}, perform: async () => 'ok' },
    ]);
    const prompter = scriptedPrompter(
        // 20 turns of emitting one tool call each; HARD_CAP=12 stops it
        Array.from({ length: 20 }, () => ({ text: null, toolCalls: [{ id: 'x', name: 'noop', args: {} }], stopReason: 'tool_use' })),
    );
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'go' });
    assert(prompter._log.length === 12, `bounded at HARD_CAP=12 (was ${prompter._log.length})`);
}

// 6. Plan-mode filter
console.log('test_plan_mode_filter');
{
    const agent = makeMockAgent();
    agent.planMode = true;
    const reg = makeMockRegistry([
        { name: '!read', isReadOnly: true, params: {}, perform: async () => 'r' },
        { name: '!safe', isConcurrencySafe: true, params: {}, perform: async () => 's' },
        { name: '!body', params: {}, perform: async () => 'b' },  // neither readOnly nor concurrency-safe
    ]);
    const prompter = scriptedPrompter([
        { text: 'parked', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'plan' });
    const advertised = prompter._log[0].toolCount;
    assert(advertised === 2, `plan mode advertises 2 tools (read+safe), got ${advertised}`);
}

// 7. bg_complete event injects a tool_result and triggers invoke
console.log('test_bg_complete_event');
{
    const agent = makeMockAgent();
    const reg = makeMockRegistry([]);
    const prompter = scriptedPrompter([
        { text: 'thanks for the bg result', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    await orch.handleEvent({ type: 'bg_complete', handle: 'bg-7', toolName: 'collectBlocks', result: 'got 5 iron_ore' });
    assert(orch.history[0].role === 'tool_result', 'first history entry is tool_result');
    assert(orch.history[0].toolResults[0].content.includes('got 5 iron_ore'), 'bg result content propagated');
    assert(prompter._log.length === 1, 'one LLM invocation after bg complete');
}

// 8. Mid-invoke user_message queues to pendingEvents and runs after
console.log('test_pending_events');
{
    const agent = makeMockAgent();
    let secondPromptCount = 0;
    const reg = makeMockRegistry([
        { name: '!slow', params: {},
          perform: async () => { await new Promise(r => setTimeout(r, 30)); return 'slow ok'; } },
    ]);
    const prompter = scriptedPrompter([
        { text: null, toolCalls: [{ id: 's', name: 'slow', args: {} }], stopReason: 'tool_use' },
        { text: 'done first', toolCalls: [], stopReason: 'end_turn' },
        { text: 'answering followup', toolCalls: [], stopReason: 'end_turn' },
    ]);
    const orch = new OrchestratorV2(agent, { promptWithTools: prompter, getSystemPrompt: () => '', registry: reg });
    const p1 = orch.handleEvent({ type: 'user_message', source: 'P', content: 'do slow thing' });
    // Fire a second event while first is mid-flight (slow tool running)
    await new Promise(r => setTimeout(r, 10));
    const p2 = orch.handleEvent({ type: 'user_message', source: 'P', content: 'how are you?' });
    await Promise.all([p1, p2]);
    assert(prompter._log.length === 3, `three LLM invocations (initial→tool, park, followup); got ${prompter._log.length}`);
    assert(agent._calls.length === 2, 'two chat responses (one per parked invoke)');
}

if (failures > 0) {
    console.log(`\nFAIL — ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nPASS — all orchestrator tests green');
process.exit(0);
