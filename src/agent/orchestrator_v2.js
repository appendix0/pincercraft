// v2 Step 4 — Event-driven orchestrator.
//
// Replaces the for(i<max_responses) loop in agent.js:_processInput when
// settings.use_orchestrator_v2 is on. Gated; default OFF until proven.
//
// Event shape:
//   { type, source, content, ... }
// Event types this dispatcher recognizes:
//   - user_message:     player/whisper chat (always invokes LLM)
//   - bg_complete:      Step 5 background tool finished (handle, result|error, toolName)
//   - mode_trigger:     Step 5 mode interrupt (mode, cancelled_handle?, context)
//   - checkpoint:       periodic queue heartbeat / plan-mode ping
//   - self_prompt_tick: Step 4 self-prompter routed through dispatcher
//
// Architecture (per docs/agent-blueprint.md §3 Step 4 rev-2):
//
//   handleEvent(event)
//     │
//     ▼
//   append to internal history (neutral shape)
//     │
//     ▼
//   invoke()  ← while loop until LLM emits no toolCalls
//     │
//     ├── activeTools() — plan-mode filter + permission filter
//     ├── prompter.sendRequestWithTools(history, system, tools)
//     ├── append assistant turn (text + toolCalls) to history
//     ├── if toolCalls.length === 0 → park (route text to chat, return)
//     └── executeTools(toolCalls):
//           • partition by isConcurrencySafe
//           • Promise.all the safe ones
//           • serialize the rest
//           • for isLongRunning + bg flag (Step 5): return handle placeholder
//         append tool_results, continue loop
//
// History representation here is provider-neutral:
//   { role: 'user' | 'assistant' | 'tool_result', content?: string,
//     text?: string, toolCalls?: [...], toolResults?: [...] }
// Per-provider serialization happens in the prompter / model wrapper.
//
// Side-chat preservation: a user_message arriving mid-invoke gets queued
// onto a pending list; when the current invoke's tool loop exits and the
// LLM emits no more toolCalls, the pending message is appended and a
// fresh invoke kicks off. This collapses the legacy _handleSideChat
// parallel-LLM pattern into the dispatcher (still pings "got it" if
// no LLM call is currently in flight, otherwise just queues).

import { getRegistry } from './tool_registry.js';
import { checkPlayerPermission } from './permissions.js';
import { matchesToolFilter } from './subagent_v2.js';

export class OrchestratorV2 {
    // promptWithTools is injected so the orchestrator stays test-friendly
    // (mock for unit tests; real Prompter binding in production).
    constructor(agent, { promptWithTools, getSystemPrompt, registry = null } = {}) {
        this.agent = agent;
        this.registry = registry || getRegistry();
        this.promptWithTools = promptWithTools;
        this.getSystemPrompt = getSystemPrompt;
        this.history = [];
        this.lastSource = null;
        this.invoking = false;
        this.pendingEvents = [];
        // Step 5 hook: when use_background_handles is on, the orchestrator
        // delegates isLongRunning tools to backgroundTasks instead of awaiting
        // them. Set externally by the agent during construction.
        this.backgroundTasks = null;
    }

    // Public entry point. Caller does NOT await the invoke loop — fire and
    // forget. invoking guard + pendingEvents queue handle re-entrancy from
    // mid-task user chats (the load-bearing side-chat case).
    async handleEvent(event) {
        if (!event || !event.type) return;
        if (this.invoking) {
            this.pendingEvents.push(event);
            return;
        }
        this.invoking = true;
        try {
            this._appendEvent(event);
            await this._invokeUntilParked();
            while (this.pendingEvents.length > 0) {
                const next = this.pendingEvents.shift();
                this._appendEvent(next);
                await this._invokeUntilParked();
            }
        } finally {
            this.invoking = false;
        }
    }

    _appendEvent(event) {
        switch (event.type) {
            case 'user_message':
                this.lastSource = event.source || this.lastSource;
                this.history.push({
                    role: 'user',
                    content: event.source ? `${event.source}: ${event.content}` : event.content,
                });
                break;
            case 'bg_complete': {
                // Surface bg-task outcome as a synthetic user turn (no
                // matching tool_use id exists — the originating tool_use
                // already returned a started-handle response on the prior
                // turn). User-role text avoids dangling-tool_use_id errors
                // on Anthropic.
                let body;
                if (event.cancelled) body = `[bg ${event.toolName} ${event.handle} cancelled]`;
                else if (event.error) body = `[bg ${event.toolName} ${event.handle} failed] ${event.error}`;
                else body = `[bg ${event.toolName} ${event.handle} complete]${event.result ? ` ${event.result}` : ''}`;
                this.history.push({ role: 'user', content: body });
                break;
            }
            case 'mode_trigger':
                this.history.push({
                    role: 'user',
                    content: `[mode_trigger] ${event.mode}: ${event.context || ''}${event.cancelledHandle ? ` (cancelled in-flight tool ${event.cancelledHandle})` : ''}`,
                });
                break;
            case 'checkpoint':
                this.history.push({ role: 'user', content: `[checkpoint] ${event.content || ''}` });
                break;
            case 'self_prompt_tick':
                this.history.push({ role: 'user', content: `[self_prompt_tick] ${event.content || 'continue if anything to do'}` });
                break;
            default:
                console.warn('[orch] unknown event type', event.type);
        }
    }

    async _invokeUntilParked() {
        // Hard cap on iterations as a safety net (real fix is the LLM
        // emitting no more toolCalls). Tune lower than the legacy
        // for(i<max_responses) which was effectively unbounded.
        const HARD_CAP = 12;
        for (let i = 0; i < HARD_CAP; i++) {
            const tools = this.activeTools();
            const system = typeof this.getSystemPrompt === 'function' ? await this.getSystemPrompt() : '';
            const resp = await this.promptWithTools(this.history, system, tools);

            this.history.push({
                role: 'assistant',
                text: resp.text || null,
                toolCalls: resp.toolCalls || [],
            });

            if (!resp.toolCalls || resp.toolCalls.length === 0) {
                // Park. Route any prose to chat.
                if (resp.text && this.agent?.routeResponse) {
                    try { this.agent.routeResponse(this.lastSource, resp.text); }
                    catch (e) { console.warn('[orch] routeResponse failed:', e?.message || e); }
                }
                return;
            }

            const results = await this.executeTools(resp.toolCalls);
            this.history.push({ role: 'tool_result', toolResults: results });
        }
        console.warn(`[orch] hit HARD_CAP=${12}; parking to avoid infinite loop`);
    }

    // Tools advertised to the LLM this turn. Plan-mode filter +
    // blocked_actions filter. Single-channel plan-mode per blueprint
    // §3 Step 3 rev-2.
    activeTools() {
        const blocked = this.agent?.blocked_actions || [];
        const descs = this.agent?.planMode === true
            ? this.registry.forPlanMode(blocked)
            : this.registry.forLLM(blocked);
        let out = this.registry.toolDescriptorsForLLM(blocked)
            .filter(d => descs.some(c => c.name === d._raw.name));
        // v2 Step 6: when a subagent is active with a tools_filter, narrow
        // the LLM surface to just the role's allowed tools. The dispatch
        // path only sets this when use_subagent_isolation is on.
        const roleFilter = this.agent?.activeSubagent?.toolsFilter;
        if (Array.isArray(roleFilter) && roleFilter.length > 0) {
            out = out.filter(d => matchesToolFilter(d.name, roleFilter));
        }
        return out;
    }

    // Partition tool calls by isConcurrencySafe; Promise.all the safe
    // ones, serialize the rest. Each result is shaped as a tool_result
    // ready to append to history.
    async executeTools(toolCalls) {
        const safe = [];
        const serial = [];
        for (const tc of toolCalls) {
            const cmd = this.registry.byName(tc.name) || this.registry.byName('!' + tc.name);
            if (!cmd) {
                serial.push({ tc, cmd: null });
                continue;
            }
            if (cmd.isConcurrencySafe === true || cmd.isReadOnly === true) safe.push({ tc, cmd });
            else serial.push({ tc, cmd });
        }
        const parallelResults = await Promise.all(safe.map(({ tc, cmd }) => this._executeOne(tc, cmd)));
        const serialResults = [];
        for (const { tc, cmd } of serial) {
            serialResults.push(await this._executeOne(tc, cmd));
        }
        // Preserve original call order in the returned array
        const out = new Array(toolCalls.length);
        let pIdx = 0, sIdx = 0;
        for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const isSafe = safe.some(({ tc: t }) => t.id === tc.id);
            out[i] = isSafe ? parallelResults[pIdx++] : serialResults[sIdx++];
        }
        return out;
    }

    async _executeOne(toolCall, cmd) {
        if (!cmd) {
            return {
                id: toolCall.id, name: toolCall.name, isError: true,
                content: `Unknown tool "${toolCall.name}". Available tools are listed in the system tools array.`,
            };
        }
        // Permission gate (mirrors commands/index.js:265-271). System and
        // self-prompt sources bypass; player sources go through.
        try {
            const ctx = { agent: this.agent, source: this.agent?.last_sender };
            const perm = checkPlayerPermission(this.agent, cmd.name, ctx);
            if (perm && perm.allow === false) {
                return { id: toolCall.id, name: toolCall.name, isError: true, content: perm.message };
            }
        } catch (e) { /* permissions check is best-effort */ }
        try {
            const perm = typeof cmd.checkPermissions === 'function'
                ? (cmd.checkPermissions(this._argsToPositional(cmd, toolCall.args), { agent: this.agent, source: this.agent?.last_sender }) ?? { allow: true })
                : { allow: true };
            if (perm.allow === false) {
                return { id: toolCall.id, name: toolCall.name, isError: true, content: perm.message || `[permission denied] You cannot use ${cmd.name} in this context.` };
            }
        } catch (e) { /* hook is best-effort */ }

        // Step 5: long-running tools route through backgroundTasks when
        // the flag is on. For now, sync execute. The hook is in place so
        // Step 5's wire-in is a one-liner.
        const isLong = (cmd.isLongRunning === true) ||
                       (typeof cmd.perform === 'function' && cmd.perform.isLongRunning === true);
        if (isLong && this.backgroundTasks && this.agent?.use_background_handles) {
            try {
                const handle = this.backgroundTasks.spawn({
                    toolName: cmd.name,
                    args: toolCall.args,
                    run: (signal) => cmd.perform(this.agent, ...this._argsToPositional(cmd, toolCall.args)),
                    onComplete: (payload) => {
                        // Re-enter the dispatcher with a bg_complete event so
                        // the LLM sees the outcome on the next invoke. The
                        // re-entrancy guard (invoking + pendingEvents) handles
                        // arrival during another in-flight turn.
                        this.handleEvent({
                            type: 'bg_complete',
                            handle: payload.handle,
                            toolName: payload.toolName,
                            result: payload.result,
                            error: payload.error,
                            cancelled: payload.cancelled,
                        }).catch(e => console.warn('[orch] bg_complete dispatch failed:', e?.message || e));
                    },
                });
                return { id: toolCall.id, name: toolCall.name, isError: false, content: `[started bg ${handle.handle}] ${cmd.name} dispatched. You'll be notified on completion.` };
            } catch (e) {
                return { id: toolCall.id, name: toolCall.name, isError: true, content: `bg spawn failed: ${e?.message || e}` };
            }
        }

        try {
            const result = await cmd.perform(this.agent, ...this._argsToPositional(cmd, toolCall.args));
            return {
                id: toolCall.id, name: toolCall.name, isError: false,
                content: String(result ?? `${cmd.name} ok`),
            };
        } catch (e) {
            return {
                id: toolCall.id, name: toolCall.name, isError: true,
                content: `${cmd.name} threw: ${e?.message || e}`,
            };
        }
    }

    // Convert {key: value, ...} args back to the positional array each
    // command's perform() signature expects. Order comes from the params
    // object's key order — these are declared in actions.js / queries.js
    // in the same order as the function signature, which is how the
    // legacy text parser also works (commands/index.js parses positional
    // by params order).
    _argsToPositional(cmd, argsObj) {
        const params = cmd?.params || {};
        const keys = Object.keys(params);
        return keys.map(k => argsObj?.[k]);
    }
}
