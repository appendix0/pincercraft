// v2 Step 3 — Unit tests for tool_protocol.js shape converters.
// Run: node scripts/test_tool_protocol.js. No real API calls.

import {
    parseToolArgs,
    buildRetryMessage,
    toAnthropicTools,
    toOpenAITools,
    fromAnthropicResponse,
    fromOpenAIResponse,
} from '../src/models/tool_protocol.js';

let failures = 0;
function assert(cond, label, info) {
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ ${label}`, info ?? ''); failures++; }
}

// 1. parseToolArgs — well-formed
console.log('test_parse_well_formed');
const a = parseToolArgs('{"x":1,"y":"hi"}');
assert(a.ok && a.args.x === 1 && a.args.y === 'hi', 'parses JSON object');

// 2. parseToolArgs — empty / null
console.log('test_parse_empty');
assert(parseToolArgs(null).ok && Object.keys(parseToolArgs(null).args).length === 0, 'null → {}');
assert(parseToolArgs('').ok, 'empty string → ok');
assert(parseToolArgs({a:1}).ok && parseToolArgs({a:1}).args.a === 1, 'already-object passes through');

// 3. parseToolArgs — tolerates smart quotes
console.log('test_parse_smart_quotes');
const sq = parseToolArgs('{“key”:"value"}');
assert(sq.ok && sq.args.key === 'value', 'smart double quotes repaired');

// 4. parseToolArgs — tolerates trailing comma
console.log('test_parse_trailing_comma');
const tc = parseToolArgs('{"a":1,"b":2,}');
assert(tc.ok && tc.args.b === 2, 'trailing comma stripped');

// 5. parseToolArgs — malformed
console.log('test_parse_malformed');
const m = parseToolArgs('this is not json');
assert(!m.ok && typeof m.error === 'string', 'malformed surfaces error');
const arr = parseToolArgs('[1,2,3]');
assert(!arr.ok, 'array root rejected (must be object)');

// 6. buildRetryMessage shape
console.log('test_retry_message');
const rm = buildRetryMessage([{ id: 'a', name: 'collectBlocks', rawArgs: '{bad', error: 'unexpected' }]);
assert(rm && rm.role === 'user' && rm.content.includes('id=a'), 'retry message contains id');
assert(buildRetryMessage([]) === null, 'empty errors → null');
assert(buildRetryMessage(null) === null, 'null errors → null');

// 7. toAnthropicTools shape
console.log('test_anthropic_tools_shape');
const descs = [{
    name: 'collectBlocks',
    description: 'Collect blocks',
    input_schema: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] },
    isLongRunning: true,
}];
const at = toAnthropicTools(descs);
assert(at.length === 1 && at[0].name === 'collectBlocks', 'name preserved');
assert(at[0].input_schema?.type === 'object', 'schema attached');
assert(at[0].isLongRunning === undefined, 'metadata-only fields stripped from wire shape');

// 8. toOpenAITools shape
console.log('test_openai_tools_shape');
const ot = toOpenAITools(descs);
assert(ot.length === 1 && ot[0].type === 'function', 'type=function');
assert(ot[0].function?.name === 'collectBlocks', 'name nested under function');
assert(ot[0].function?.parameters?.type === 'object', 'parameters = input_schema');

// 9. fromAnthropicResponse — text only
console.log('test_anthropic_text_only');
const ar1 = fromAnthropicResponse({
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
});
assert(ar1.text === 'hello', 'text captured');
assert(ar1.toolCalls.length === 0, 'no tool calls');
assert(ar1.stopReason === 'end_turn', 'stop_reason mapped');

// 10. fromAnthropicResponse — tool_use blocks
console.log('test_anthropic_tool_use');
const ar2 = fromAnthropicResponse({
    content: [
        { type: 'text', text: 'I will collect.' },
        { type: 'tool_use', id: 'toolu_1', name: 'collectBlocks', input: { type: 'iron_ore', num: 5 } },
    ],
    stop_reason: 'tool_use',
});
assert(ar2.text === 'I will collect.', 'text alongside tool use');
assert(ar2.toolCalls.length === 1, 'one tool call');
assert(ar2.toolCalls[0].name === 'collectBlocks', 'name');
assert(ar2.toolCalls[0].args.num === 5, 'args already parsed (Anthropic native)');
assert(ar2.stopReason === 'tool_use', 'tool_use stop reason');

// 11. fromAnthropicResponse — empty / null
console.log('test_anthropic_empty');
const ar3 = fromAnthropicResponse(null);
assert(ar3.text === null && ar3.toolCalls.length === 0, 'null response → empty shape');

// 12. fromOpenAIResponse — tool_calls
console.log('test_openai_tool_calls');
const or1 = fromOpenAIResponse({
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            content: 'Mining now.',
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'collectBlocks', arguments: '{"type":"iron_ore","num":5}' } },
            ],
        },
    }],
});
assert(or1.text === 'Mining now.', 'text from message.content');
assert(or1.toolCalls.length === 1, 'one tool call');
assert(or1.toolCalls[0].args.num === 5, 'args parsed from JSON string');
assert(or1.parseErrors.length === 0, 'no parse errors');
assert(or1.stopReason === 'tool_use', 'finish_reason tool_calls → tool_use');

// 13. fromOpenAIResponse — malformed arguments
console.log('test_openai_malformed_args');
const or2 = fromOpenAIResponse({
    choices: [{
        finish_reason: 'tool_calls',
        message: {
            content: null,
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'collectBlocks', arguments: '{type: iron_ore' } },
                { id: 'c2', type: 'function', function: { name: 'goToPlayer', arguments: '{"player_name":"foo","closeness":1}' } },
            ],
        },
    }],
});
assert(or2.toolCalls.length === 1, 'one valid tool call kept');
assert(or2.toolCalls[0].name === 'goToPlayer', 'valid call preserved');
assert(or2.parseErrors.length === 1, 'one parse error reported');
assert(or2.parseErrors[0].name === 'collectBlocks', 'parse error names the offender');
assert(or2.parseErrors[0].rawArgs.startsWith('{type'), 'raw args surfaced for re-prompt');

// 14. fromOpenAIResponse — finish_reason mapping
console.log('test_openai_finish_reasons');
const fr = (r) => fromOpenAIResponse({ choices: [{ finish_reason: r, message: { content: 'x' } }] }).stopReason;
assert(fr('stop') === 'end_turn', 'stop → end_turn');
assert(fr('length') === 'max_tokens', 'length → max_tokens');
assert(fr('tool_calls') === 'tool_use', 'tool_calls → tool_use');
assert(fr('content_filter') === 'stop_sequence', 'content_filter → stop_sequence');

// 15. fromOpenAIResponse — empty
console.log('test_openai_empty');
const or3 = fromOpenAIResponse({});
assert(or3.text === null && or3.toolCalls.length === 0, 'empty → empty shape');

if (failures > 0) {
    console.log(`\nFAIL — ${failures} assertion(s) failed`);
    process.exit(1);
}
console.log('\nPASS — all tool_protocol tests green');
process.exit(0);
