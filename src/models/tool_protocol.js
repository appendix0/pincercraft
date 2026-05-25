// v2 Step 3 — Provider-neutral tool-use protocol.
//
// Output shape returned by every provider's sendRequestWithTools():
//
//   {
//     text:        string | null,           // assistant prose, if any
//     toolCalls:   [{ id, name, args }],    // structured tool requests (parsed)
//     stopReason:  'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error',
//     parseErrors: [{ id, name, rawArgs, error }],  // malformed tool_calls.arguments
//     raw:         <provider-specific>,     // for debugging / token counting
//   }
//
// Per-provider wrappers in claude.js (Anthropic native) and gpt.js
// (OpenAI / NVIDIA-Build OpenAI-compat) shape API responses into this.
// Step 4's orchestrator consumes this shape uniformly.
//
// Tolerant parsing: when a provider returns malformed JSON in
// `tool_calls[].function.arguments` (NVIDIA llama-3.3-70b does this
// occasionally), we surface it via parseErrors[] rather than throwing.
// The caller can then either: (a) inject a structured re-prompt with
// the parse error and try once more; or (b) surface to the player.
// Step 3 budget: ONE retry, then surface — per docs/agent-blueprint.md
// §6 (NVIDIA best-effort).
//
// See docs/agent-blueprint.md §3 Step 3 and Appendix B.7.

// Attempt to parse a tool-call's arguments string into an object.
// Returns { ok: true, args } on success, { ok: false, error } otherwise.
// Tolerant of common LLM mistakes (smart quotes, trailing commas).
export function parseToolArgs(raw) {
    if (raw == null || raw === '') return { ok: true, args: {} };
    if (typeof raw === 'object') return { ok: true, args: raw };
    let s = String(raw).trim();
    if (s === '') return { ok: true, args: {} };

    // Replace common LLM mistakes before strict JSON parse.
    const repaired = s
        .replace(/[“”]/g, '"')        // curly double quotes
        .replace(/[‘’]/g, "'")        // curly single quotes
        .replace(/,(\s*[}\]])/g, '$1');         // trailing comma before } or ]

    try {
        const out = JSON.parse(repaired);
        if (out !== null && typeof out === 'object' && !Array.isArray(out)) {
            return { ok: true, args: out };
        }
        return { ok: false, error: `parsed value is not an object: ${typeof out}` };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

// Build a structured re-prompt message describing the parse errors so the
// LLM can re-emit corrected tool calls. Returned as a single system-role
// message ready to append to the messages[] array before retry.
export function buildRetryMessage(parseErrors) {
    if (!parseErrors || parseErrors.length === 0) return null;
    const lines = parseErrors.map(e =>
        `- tool_call id=${e.id} name=${e.name}: argument JSON failed to parse (${e.error}). Raw text was: ${e.rawArgs?.slice(0, 200) || '(empty)'}`,
    );
    return {
        role: 'user',
        content: `Your previous response contained tool calls whose arguments could not be parsed:\n${lines.join('\n')}\n\nRetry the same calls with valid JSON arguments. Use double quotes for strings, no trailing commas. Do not change the call intent.`,
    };
}

// Build the Anthropic-shape tools[] array from descriptors produced by
// tool_registry.toolDescriptorsForLLM(). Anthropic expects:
//   { name, description, input_schema: { type, properties, required } }
export function toAnthropicTools(descriptors) {
    return descriptors.map(d => ({
        name: d.name,
        description: d.description,
        input_schema: d.input_schema,
    }));
}

// Build the OpenAI / OpenAI-compat shape:
//   { type: 'function', function: { name, description, parameters } }
export function toOpenAITools(descriptors) {
    return descriptors.map(d => ({
        type: 'function',
        function: {
            name: d.name,
            description: d.description,
            parameters: d.input_schema,
        },
    }));
}

// Normalize an Anthropic `messages.create` response into the neutral shape.
// resp.content is an array of content blocks: { type: 'text', text } or
// { type: 'tool_use', id, name, input }.
export function fromAnthropicResponse(resp) {
    const out = { text: null, toolCalls: [], stopReason: 'end_turn', parseErrors: [], raw: resp };
    if (!resp) return out;
    out.stopReason = resp.stop_reason || 'end_turn';
    const textParts = [];
    for (const block of resp.content || []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
        } else if (block?.type === 'tool_use') {
            // Anthropic returns input as an already-parsed object — no JSON.parse needed.
            out.toolCalls.push({
                id: block.id,
                name: block.name,
                args: block.input ?? {},
            });
        }
    }
    if (textParts.length) out.text = textParts.join('\n').trim();
    return out;
}

// Normalize an OpenAI-compat chat.completions response. message.tool_calls
// is an array of { id, type: 'function', function: { name, arguments: JSON string } }.
export function fromOpenAIResponse(resp) {
    const out = { text: null, toolCalls: [], stopReason: 'end_turn', parseErrors: [], raw: resp };
    if (!resp) return out;
    const choice = resp.choices?.[0];
    if (!choice) return out;
    out.stopReason = mapOpenAIFinishReason(choice.finish_reason);
    const msg = choice.message;
    if (msg?.content && typeof msg.content === 'string' && msg.content.trim()) {
        out.text = msg.content.trim();
    }
    for (const call of msg?.tool_calls || []) {
        if (call?.type !== 'function' || !call.function) continue;
        const parsed = parseToolArgs(call.function.arguments);
        if (parsed.ok) {
            out.toolCalls.push({
                id: call.id,
                name: call.function.name,
                args: parsed.args,
            });
        } else {
            // Surface the unparseable call so the caller can decide whether
            // to retry. Don't drop the id/name — the LLM needs them for the
            // re-prompt.
            out.parseErrors.push({
                id: call.id,
                name: call.function.name,
                rawArgs: call.function.arguments,
                error: parsed.error,
            });
        }
    }
    return out;
}

function mapOpenAIFinishReason(fr) {
    switch (fr) {
        case 'tool_calls': return 'tool_use';
        case 'stop':       return 'end_turn';
        case 'length':     return 'max_tokens';
        case 'content_filter': return 'stop_sequence';
        default:           return fr || 'end_turn';
    }
}

// ─── Neutral history → provider native (for integration) ─────────────
//
// Orchestrator history shape:
//   { role: 'user',          content: string }
//   { role: 'assistant',     text: string|null, toolCalls: [{id, name, args}] }
//   { role: 'tool_result',   toolResults: [{id, name, content, isError}] }
//
// Anthropic expects content blocks; OpenAI splits tool_results into
// separate messages with role:'tool'.

export function neutralToAnthropic(history) {
    const out = [];
    for (const turn of history || []) {
        if (turn.role === 'user') {
            out.push({ role: 'user', content: typeof turn.content === 'string' ? turn.content : '' });
        } else if (turn.role === 'assistant') {
            const content = [];
            if (turn.text) content.push({ type: 'text', text: turn.text });
            for (const tc of turn.toolCalls || []) {
                content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
            }
            // Anthropic requires non-empty content array
            if (content.length === 0) content.push({ type: 'text', text: '' });
            out.push({ role: 'assistant', content });
        } else if (turn.role === 'tool_result') {
            const content = (turn.toolResults || []).map(tr => {
                const block = { type: 'tool_result', tool_use_id: tr.id, content: String(tr.content ?? '') };
                if (tr.isError === true) block.is_error = true;
                return block;
            });
            if (content.length > 0) out.push({ role: 'user', content });
        }
    }
    return out;
}

export function neutralToOpenAI(history) {
    const out = [];
    for (const turn of history || []) {
        if (turn.role === 'user') {
            out.push({ role: 'user', content: typeof turn.content === 'string' ? turn.content : '' });
        } else if (turn.role === 'assistant') {
            const msg = { role: 'assistant', content: turn.text || null };
            if (turn.toolCalls && turn.toolCalls.length > 0) {
                msg.tool_calls = turn.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
                }));
            }
            out.push(msg);
        } else if (turn.role === 'tool_result') {
            // OpenAI splits each tool_result into its own message with role:'tool'
            for (const tr of turn.toolResults || []) {
                out.push({ role: 'tool', tool_call_id: tr.id, content: String(tr.content ?? '') });
            }
        }
    }
    return out;
}
