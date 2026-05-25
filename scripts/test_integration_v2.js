// v2 integration smoke — orchestrator + neutral converters + (mocked)
// model wrapper round-trip. Run: node scripts/test_integration_v2.js.
//
// This exercises the exact code path agent.js wires when
// use_orchestrator_v2 + use_tool_use_protocol are on, but without
// touching Mineflayer / real LLM. Catches integration breakage
// (shape mismatches between orchestrator history and provider
// API messages) that the per-module tests miss.

import { OrchestratorV2 } from '../src/agent/orchestrator_v2.js';
import { neutralToAnthropic, neutralToOpenAI, fromAnthropicResponse, fromOpenAIResponse } from '../src/models/tool_protocol.js';

let failures = 0;
function assert(cond, label, info) {
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label}`, info ?? ''); failures++; }
}

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

// ── 1. Anthropic round-trip ───────────────────────────────────────────
console.log('test_anthropic_roundtrip');
{
    // Mock the Anthropic SDK shape directly: messages.create returns
    // { content: [...], stop_reason }
    const anthropicCalls = [];
    const responseScripts = [
        // First call: emit a tool_use block
        { content: [
            { type: 'text', text: 'mining now' },
            { type: 'tool_use', id: 'toolu_1', name: 'collectBlocks', input: { type: 'iron_ore', num: 3 } },
        ], stop_reason: 'tool_use' },
        // Second call: park with text only
        { content: [{ type: 'text', text: 'got it' }], stop_reason: 'end_turn' },
    ];
    let respIdx = 0;
    const mockAnthropic = {
        messages: {
            create: async (req) => {
                anthropicCalls.push(req);
                return responseScripts[respIdx++];
            },
        },
    };

    // Bridge: simulates what agent._promptViaModel does for Anthropic
    const promptWithTools = async (history, system, tools) => {
        const providerHistory = neutralToAnthropic(history);
        const resp = await mockAnthropic.messages.create({
            model: 'claude-sonnet-4-6',
            system,
            messages: providerHistory,
            tools: tools.map(d => ({ name: d.name, description: d.description, input_schema: d.input_schema })),
        });
        return fromAnthropicResponse(resp);
    };

    let collectCalledWith = null;
    const reg = makeMockRegistry([
        { name: '!collectBlocks', params: { type: { type: 'BlockName' }, num: { type: 'int' } },
          perform: async (a, type, num) => { collectCalledWith = { type, num }; return `collected ${num} ${type}`; } },
    ]);
    const agent = {
        blocked_actions: [], last_sender: 'P',
        routeResponse: (to, msg) => { agent._lastChat = msg; },
        planMode: false,
    };
    const orch = new OrchestratorV2(agent, {
        promptWithTools,
        getSystemPrompt: async () => 'TEST SYSTEM',
        registry: reg,
    });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'mine 3 iron_ore' });

    // First call should have shipped the user message + tool descriptor for collectBlocks
    assert(anthropicCalls.length === 2, `2 Anthropic calls (tool then park); got ${anthropicCalls.length}`);
    assert(anthropicCalls[0].messages?.[0]?.role === 'user', 'first call has user message');
    assert(anthropicCalls[0].messages?.[0]?.content?.includes('mine 3'), 'user content preserved');
    assert(anthropicCalls[0].tools?.length === 1, '1 tool advertised');
    assert(anthropicCalls[0].tools[0].name === 'collectBlocks', 'tool name stripped of !');
    assert(anthropicCalls[0].system === 'TEST SYSTEM', 'system prompt forwarded');

    // Second call should have appended the assistant turn + tool_result
    assert(anthropicCalls[1].messages?.length === 3, `2nd call has 3 messages (user, assistant, tool_result-as-user); got ${anthropicCalls[1].messages?.length}`);
    const asstTurn = anthropicCalls[1].messages[1];
    assert(asstTurn.role === 'assistant', 'message 2 is assistant');
    assert(Array.isArray(asstTurn.content), 'assistant content is array');
    assert(asstTurn.content.some(b => b.type === 'tool_use' && b.id === 'toolu_1'), 'tool_use block preserved');
    const toolResultTurn = anthropicCalls[1].messages[2];
    assert(toolResultTurn.role === 'user', 'tool_result wrapped in user message (Anthropic shape)');
    assert(toolResultTurn.content[0]?.type === 'tool_result', 'tool_result block');
    assert(toolResultTurn.content[0]?.tool_use_id === 'toolu_1', 'tool_use_id linked');
    assert(toolResultTurn.content[0]?.content?.includes('collected 3 iron_ore'), 'tool output threaded back');

    // Tool actually executed
    assert(collectCalledWith?.type === 'iron_ore', 'perform got iron_ore');
    assert(collectCalledWith?.num === 3, 'perform got num=3');

    // Final chat reached the player
    assert(agent._lastChat === 'got it', 'final park sent text to chat');
}

// ── 2. OpenAI round-trip ──────────────────────────────────────────────
console.log('test_openai_roundtrip');
{
    const openaiCalls = [];
    const responseScripts = [
        // First call: tool_calls
        { choices: [{ finish_reason: 'tool_calls', message: {
            content: 'going',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inventory', arguments: '{}' } }],
        }}]},
        // Second call: park
        { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] },
    ];
    let respIdx = 0;
    const mockOpenAI = {
        chat: { completions: {
            create: async (req) => { openaiCalls.push(req); return responseScripts[respIdx++]; },
        }},
    };

    const promptWithTools = async (history, system, tools) => {
        const providerHistory = neutralToOpenAI(history);
        const messages = [{ role: 'system', content: system }, ...providerHistory];
        const resp = await mockOpenAI.chat.completions.create({
            model: 'llama-3.3-70b',
            messages,
            tools: tools.map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.input_schema } })),
            tool_choice: 'auto',
        });
        return fromOpenAIResponse(resp);
    };

    const reg = makeMockRegistry([
        { name: '!inventory', isReadOnly: true, params: {},
          perform: async () => 'iron_ore: 5, oak_planks: 12' },
    ]);
    const agent = {
        blocked_actions: [], last_sender: 'P',
        routeResponse: (to, msg) => { agent._lastChat = msg; },
        planMode: false,
    };
    const orch = new OrchestratorV2(agent, {
        promptWithTools, getSystemPrompt: async () => 'TEST SYSTEM', registry: reg,
    });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'what inv' });

    assert(openaiCalls.length === 2, `2 OpenAI calls; got ${openaiCalls.length}`);
    assert(openaiCalls[0].messages?.[0]?.role === 'system', 'system message first');
    assert(openaiCalls[0].messages?.[0]?.content === 'TEST SYSTEM', 'system content forwarded');
    assert(openaiCalls[0].messages?.[1]?.role === 'user', 'user message second');

    // Second call sees assistant + tool messages
    const m = openaiCalls[1].messages;
    assert(m.find(x => x.role === 'assistant' && x.tool_calls?.length === 1), 'assistant turn with tool_calls');
    const toolMsg = m.find(x => x.role === 'tool');
    assert(toolMsg, 'tool_result split into role:tool message');
    assert(toolMsg.tool_call_id === 'c1', 'tool_call_id linked');
    assert(toolMsg.content.includes('iron_ore: 5'), 'tool output threaded back');

    assert(agent._lastChat === 'done', 'final park sent text to chat');
}

// ── 3. Plan-mode filter trips through orchestrator → mock provider ────
console.log('test_plan_mode_advertising');
{
    let advertisedTools = null;
    const promptWithTools = async (history, system, tools) => {
        advertisedTools = tools;
        return { text: 'planning', toolCalls: [], stopReason: 'end_turn' };
    };
    const reg = makeMockRegistry([
        { name: '!stats', isReadOnly: true, params: {}, perform: async () => '' },
        { name: '!addTask', isConcurrencySafe: true, params: {}, perform: async () => '' },
        { name: '!collectBlocks', params: {}, perform: async () => '' },  // body-touching
        { name: '!attack', params: {}, perform: async () => '' },         // body-touching
    ]);
    const agent = {
        blocked_actions: [], last_sender: 'P',
        routeResponse: () => {}, planMode: true,
    };
    const orch = new OrchestratorV2(agent, {
        promptWithTools, getSystemPrompt: async () => '', registry: reg,
    });
    await orch.handleEvent({ type: 'user_message', source: 'P', content: 'plan it' });
    const advertisedNames = advertisedTools?.map(t => t.name) || [];
    assert(advertisedNames.includes('stats'), 'readonly stats advertised in plan mode');
    assert(advertisedNames.includes('addTask'), 'concurrency-safe addTask advertised');
    assert(!advertisedNames.includes('collectBlocks'), 'body-touching collectBlocks hidden in plan mode');
    assert(!advertisedNames.includes('attack'), 'body-touching attack hidden in plan mode');
}

if (failures > 0) {
    console.log(`\nFAIL — ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nPASS — integration smoke green');
process.exit(0);
