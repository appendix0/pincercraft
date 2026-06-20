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
import * as world from './library/world.js';
import settings from './settings.js';

// Acquisition-class actions: their whole point is to change inventory. If one
// runs with the SAME args and produces NO inventory change, repeating it is the
// token-burn loop (the iron_pickaxe-from-chest churn). Movement/social actions
// are intentionally excluded — re-issuing !goToPlayer / !followPlayer is normal.
const ACQUISITION_ACTIONS = new Set([
    '!newAction', '!findAndMine', '!gather', '!collectBlocks',
    '!craftRecipe', '!smeltItem', '!takeFromChest', '!pickupItems',
]);

const LOOP_GUARD_MSG = (name) => `[loop guard] ${name} just ran with no change to your inventory — repeating it will not help. STOP repeating the same action. Check your live INVENTORY: if the goal item is already there, !finishTask now. If not, this approach is failing — do something DIFFERENT (relocate, craft the missing tier, or ask the player). Do not call ${name} again with the same plan.`;

// How many acquisition actions in a row that change nothing before the
// loop-breaker blocks the next one — even when the args VARY each time. The
// exact-signature ledger only catches verbatim repeats; a flail that tries to
// craft A, then B, then C with no materials never repeats a signature yet still
// gets nowhere. N=3: two no-progress attempts are tolerated, the third blocked.
const NO_PROGRESS_STREAK_LIMIT = 3;

// Flatten an orchestrator neutral turn into the { role, content:string } shape
// that promptCompact → stringifyTurns expects. tool_result turns map to a
// user-side line; assistant tool calls are rendered compactly so the summary
// keeps the gist of what the bot actually did.
function flattenForSummary(turn) {
    if (turn.role === 'assistant') {
        const calls = (turn.toolCalls || [])
            .map(tc => `${tc.name}(${JSON.stringify(tc.args || {})})`)
            .join(', ');
        const parts = [];
        if (turn.text) parts.push(turn.text);
        if (calls) parts.push(`[called: ${calls}]`);
        return { role: 'assistant', content: parts.join(' ') || '(no output)' };
    }
    if (turn.role === 'tool_result') {
        const results = (turn.toolResults || [])
            .map(tr => `${tr.name}${tr.isError ? ' ERROR' : ''}: ${String(tr.content ?? '')}`)
            .join('; ');
        return { role: 'user', content: `[results] ${results}` };
    }
    return { role: 'user', content: typeof turn.content === 'string' ? turn.content : '' };
}

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
        // Loop-breaker (D) state. _acqLedger maps an acquisition action's
        // signature (which now includes the inventory it ran against) ->
        // 'progress' | 'noprogress'. Keying on inventory means a "no progress"
        // verdict only blocks a re-run while the inventory is unchanged; once
        // the bot makes any change (e.g. crafts a prerequisite), the old
        // verdict is stale and the action is retried. Resets on user_message.
        this._acqLedger = new Map();
        // Companion to _acqLedger: counts consecutive acquisition actions that
        // produced no inventory change, regardless of whether their args
        // matched. Catches a varied-args flail the exact-signature ledger
        // can't. Reset by any inventory-changing acquisition and by fresh
        // user intent (same lifetime as _acqLedger).
        this._noProgressStreak = 0;
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
            // P0 (user intent outranks the running task): a player message that
            // lands mid-invoke must not wait for the in-flight task action to
            // finish. Interrupt the body so the current invoke parks promptly
            // and this queued message drains next. Non-user events (checkpoints,
            // bg/mode) keep the old queue-and-wait behavior.
            if (event.type === 'user_message') {
                try { this.agent?.requestInterrupt?.(); } catch { /* best-effort */ }
            }
            return;
        }
        this.invoking = true;
        try {
            this._appendEvent(event);
            await this._compactIfNeeded();
            await this._invokeUntilParked();
            while (this.pendingEvents.length > 0) {
                const next = this.pendingEvents.shift();
                this._appendEvent(next);
                await this._compactIfNeeded();
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
                // Fresh player intent → forget the loop-breaker history so a
                // deliberately-repeated request isn't blocked as a loop.
                this._acqLedger.clear();
                this._noProgressStreak = 0;
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

    // Auto-compaction for the orchestrator's OWN neutral history. The v1
    // history.compactIfNeeded never runs on this path (agent.history is
    // archival; THIS array is what the LLM actually sees), so under v2 it grew
    // unbounded. Folds older turns into one summary turn via the existing
    // promptCompact, keeping the recent N.
    //
    // Threshold-gated so it fires RARELY: each compaction rewrites the front of
    // the history, which busts the prompt cache and forces a rebuild. Compacting
    // every turn would defeat caching — so we only summarize once the history is
    // genuinely large, the same trade Claude Code makes with occasional /compact.
    // Called at invoke boundaries (after the triggering event is appended, so
    // the tail is a user turn), never mid-tool-loop.
    async _compactIfNeeded() {
        const threshold = settings.compaction_threshold_tokens ?? 3000;
        const keepRecent = settings.compaction_keep_recent ?? 8;
        if (this.history.length <= keepRecent) return false;
        const estimated = Math.ceil(JSON.stringify(this.history).length / 4);
        if (estimated < threshold) return false;

        const toCompact = this.history.slice(0, this.history.length - keepRecent);
        const recent = this.history.slice(this.history.length - keepRecent);
        // Don't keep a tool_result whose matching tool_use just got compacted
        // away — Anthropic 400s on an orphaned tool_result. Pull only leading
        // tool_result turns back into the compacted chunk. A leading assistant
        // turn is fine to keep: the prepended summary is user-role, so
        // user(summary) → assistant is valid and that assistant's tool_result
        // is the next kept turn. This preserves ~keepRecent turns of real
        // detail instead of collapsing the window.
        while (recent.length > 0 && recent[0].role === 'tool_result') {
            toCompact.push(recent.shift());
        }
        if (toCompact.length === 0) return false;

        console.log(`[orch compact] turns=${this.history.length} tokens≈${estimated} threshold=${threshold} → compacting ${toCompact.length}, keeping ${recent.length}`);
        try {
            const summary = await this.agent.prompter.promptCompact(toCompact.map(flattenForSummary));
            if (summary) {
                this.history = [
                    { role: 'user', content: `[compacted ${toCompact.length} older turns]\n${summary}` },
                    ...recent,
                ];
            } else {
                console.warn('[orch compact] empty summary; dropping oldest turns as fallback');
                this.history = recent;
            }
            console.log(`[orch compact] done. new turn count=${this.history.length}`);
            return true;
        } catch (e) {
            console.error('[orch compact] failed:', e?.message || e);
            return false;
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

            // Skip recording a no-op assistant turn (no text + no toolCalls).
            // Anthropic 400s on replays that contain empty content; OpenAI is
            // tolerant but recording garbage helps no one.
            const hasText = !!(resp.text && resp.text.trim().length > 0);
            const hasTools = !!(resp.toolCalls && resp.toolCalls.length > 0);
            if (hasText || hasTools) {
                this.history.push({
                    role: 'assistant',
                    text: hasText ? resp.text : null,
                    toolCalls: resp.toolCalls || [],
                });
            }

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

        // Loop-breaker (D): block an acquisition action only when this EXACT
        // action already ran against THIS EXACT inventory and changed nothing.
        // Keying the verdict to the inventory is what unblocks multi-step
        // crafts: !craftRecipe("iron_axe") with no table changes nothing and
        // gets marked, but the moment the bot crafts/places a crafting_table
        // the inventory differs, so the next iron_axe attempt is a new
        // signature and runs (the skill auto-places the table and succeeds).
        // The old args-only key marked it bad forever and the bot could never
        // finish the recipe.
        let acqSig = null, invBefore = null;
        if (ACQUISITION_ACTIONS.has(cmd.name)) {
            invBefore = this._inventoryHash();
            acqSig = `${cmd.name}|${JSON.stringify(toolCall.args || {})}|${invBefore}`;
            if (this._acqLedger.get(acqSig) === 'noprogress') {
                console.log(`[loop guard] blocked ${cmd.name} (repeatNoProgress=true, same inventory)`);
                return { id: toolCall.id, name: toolCall.name, isError: true, content: LOOP_GUARD_MSG(cmd.name) };
            }
            // Streak guard: even with VARYING args (so the exact-sig check above
            // never matches), N acquisitions in a row that changed nothing is a
            // flail. Block the Nth before it runs and tell the LLM to change tack.
            if (this._noProgressStreak >= NO_PROGRESS_STREAK_LIMIT - 1) {
                console.log(`[loop guard] blocked ${cmd.name} (noProgressStreak=${this._noProgressStreak} >= ${NO_PROGRESS_STREAK_LIMIT - 1})`);
                return { id: toolCall.id, name: toolCall.name, isError: true, content: LOOP_GUARD_MSG(cmd.name) };
            }
        }

        try {
            const result = await cmd.perform(this.agent, ...this._argsToPositional(cmd, toolCall.args));
            if (acqSig) {
                // Did THIS run change inventory? That's the only honest progress
                // signal. Record the verdict against the inventory it ran on, so
                // it only blocks a re-run while nothing else has changed.
                const madeProgress = this._inventoryHash() !== invBefore;
                this._acqLedger.set(acqSig, madeProgress ? 'progress' : 'noprogress');
                // Progress resets the streak; a no-op extends it toward the limit.
                this._noProgressStreak = madeProgress ? 0 : this._noProgressStreak + 1;
            }
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

    // Stable, order-independent fingerprint of the bot's inventory. Used by
    // the loop-breaker to detect "this action changed nothing." Best-effort —
    // any failure yields '' so the guard simply doesn't trip.
    _inventoryHash() {
        try {
            const inv = world.getInventoryCounts(this.agent.bot);
            return Object.keys(inv).sort().map(k => `${k}:${inv[k]}`).join(',');
        } catch {
            return '';
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
