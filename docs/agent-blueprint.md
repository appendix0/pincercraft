# Pincercraft Agent Blueprint v2

> **Status**: Plan committed 2026-05-20, **revised 2026-05-20 (rev-2)** after a full code-read pass. Rev-2 deltas are tagged inline per step. Reality-check findings (what the code actually does, with file:line citations) live in [Appendix B](#appendix-b--code-reality-snapshot-2026-05-20).
> **Supersedes** the original blueprint (preserved as Appendix A).
> **Triggered by**: today's testing session on YOON that exposed how thin the previous foundations are. See [diagnosis-2026-05-20.md](./diagnosis-2026-05-20.md) for the evidence.
> **Companion docs**: [`queue-design.md`](./queue-design.md), [`CHANGELOG.md`](./CHANGELOG.md).

---

## 0. TL;DR

The bot is a chatbot with agent prosthetics. To become a Claude-Code-style agent it needs a structured tool protocol, an event-driven orchestrator, background tool handles, a resilience layer, subagent context isolation, and graceful model degradation. This blueprint plans the rewrite in 7 sequenced steps, each shippable independently behind a feature flag.

**Initial provider scope**: Anthropic (paid, planner) + NVIDIA Build (free, fallback). Gemini / DeepSeek / others added after v2 stable.

---

## 1. Where we are

See [diagnosis-2026-05-20.md](./diagnosis-2026-05-20.md) for the evidence, and [Appendix B](#appendix-b--code-reality-snapshot-2026-05-20) for the corrected architectural picture from the rev-2 deep read.

**The burst engine is three loops, not one.** Rev-1 framed this as a single `for(i<∞)` in `_processInput`, but that inner loop already breaks when the LLM emits no commands (`agent.js:990-994`). The real burst sources are:

1. **`self_prompter` unbounded loop** (`self_prompter.js:65-87`) — when autonomous mode is on, fires `handleMessage('system', msg, -1)` in `while (!interrupt)` with a 2s cooldown. **#1 burst driver.**
2. **Mode auto-re-enqueue** (`modes.js:327`) — every mode interrupt (e.g. `self_defense`) enqueues `(AUTO MESSAGE) Your action ... was interrupted ...` as a fresh input, triggering a new planner turn.
3. **Side-chat parallel LLM call** (`agent.js:667 _handleSideChat`) — when a player chats during a running task, a parallel LLM call replies while the worker keeps going. Already sophisticated; preserve its behavior in v2.

**Every command is text-parsed** (`commandRegex` in `commands/index.js:30`). Type + domain validation exists at the parse layer; **semantic** validation (chest tool for ground item) does not. Today's 70B emitted three structurally valid but semantically wrong commands in five turns.

**Long-running tools block the worker.** `_processInput → executeCommand → action.perform → ActionManager._executeAction` is fully `await`ed, with no AbortController and no handle returned. Mode interrupts collide with this by calling `actions.stop()` synchronously, and a sustained collision trips `action_manager.js:78`'s `recent_action_counter > 5 → cleanKill` — that's the actual mechanism behind today's `self_defense`-vs-`newAction` `exit code 1` crashes.

Phases A–I (preserved in Appendix A) shipped real value at the layers they targeted — parsing, planning, observability, memory — but never touched the chat-completion substrate underneath.

---

## 2. Destination

A Claude-Code-style agent runtime where:

| Aspect | Today | After v2 |
|---|---|---|
| Protocol | Text commands parsed by regex | JSON Schema tool calls (`tool_use` / `tool_result` blocks) |
| Orchestrator | `for(i<∞)` re-prompting on every system append | Event-driven dispatcher — LLM invoked only when new info arrives |
| Long-running tools | Block the agent loop; mode interrupts crash | Return handles; finish in background; cancellable |
| Resilience | Errors → "My brain disconnected" → wasted turn | Sliding-window throttle + 429 retry-with-backoff |
| Subagent context | Shares parent history (confabulation risk) | Isolated context per dispatch; result bubbles back as `tool_result` |
| Model degradation | Implicit Claude-tier assumption | Tool subsets per role, prompt trimming, gated tool advertisement |

The model spends turns **deciding**, not **stepping**. Tool errors come back as terminal results the model can reason about. The orchestrator parks when there's nothing to think about.

---

## 3. The 7-step plan

Each step ships independently behind a feature flag (Section 4). Total scope ~10 working days. Order is chosen so each step's risk is bounded and rollback is one config flip.

### Step 1 — Resilience wrapper (1 day, independent)

**Goal:** stop wasting turns on transient 429s. Provider-neutral foundation everything else inherits.

**What ships:**
- `src/models/rate_limited_client.js` — sliding-window per-provider RPM throttle + 429 retry-with-backoff (max 3 attempts, exp backoff, honors `Retry-After`).
- Each `src/models/*.js` routes its API call through the wrapper.
- Settings: `rate_limit.<provider>.rpm`, `rate_limit.retry_max_attempts`, `rate_limit.backoff_max_seconds`.

**Reference shape:**
```js
// src/models/rate_limited_client.js
export class RateLimitedClient {
    constructor({ rpm, retryMaxAttempts = 3, backoffMaxSec = 30 }) { ... }
    async send(fn) {
        await this.bucket.acquire();
        for (let attempt = 0; ; attempt++) {
            try { return await fn(); }
            catch (e) {
                if (e?.status !== 429 || attempt >= this.retryMaxAttempts) throw e;
                const wait = e?.headers?.['retry-after']
                    ? parseFloat(e.headers['retry-after']) * 1000
                    : Math.min(2 ** attempt * 500, this.backoffMaxSec * 1000);
                await sleep(wait);
            }
        }
    }
}
```

**Verification:**
- Inject a fake 429 in a unit test → see retry → success.
- Burst 50 calls in 10s with rpm=40 → throttle delays the last 10, all succeed.
- Replay today's cherry-log session → zero "My brain disconnected" turns.

**Flag:** `use_rate_limit_wrapper` (default **ON** — safe upgrade).

**Why first:** smallest patch, biggest immediate win, independent of everything else. Survives every later change.

**Rev-2 status:** `rate_limited_client.js` + claude.js + gpt.js wiring drafted (uncommitted). Settings keys, unit test, commit still pending. No scope change.

---

### Step 2 — Tool registry refactor (1 day, no behavior change)

**Goal:** every command from `commands/actions.js` + `commands/queries.js` gets a structured definition. The text-parsing path keeps working — it just routes through the registry now.

**What ships:**
- `src/agent/tool_registry.js` — single source of truth for tool definitions:
```js
registry.register({
    name: 'addTask',              // strip leading '!' from current cmd names
    description: '…',
    input_schema: { type: 'object', properties: {…}, required: [...] },
    isReadOnly: false,
    isConcurrencySafe: true,
    isLongRunning: false,
    isDangerous: false,           // requires permission gate
    perform: async (agent, args) => { … },
    summarizeResult: (result) => `Task #${result.id} queued.`
});
```
- All ~60 existing commands migrated. Tools without a clean schema (e.g. `!newAction` with a free-form prompt) get a single `prompt: string` field — still better than positional regex args.
- `$COMMAND_DOCS` system-prompt section is auto-generated from registry. Hand-maintained docstrings go away.
- The legacy `commands/actions.js` array becomes a thin shim calling `registry.register(...)` for each entry.

**Verification:**
- Regression: every old command works identically through the registry.
- Schema completeness: report the list of tools missing a real `input_schema` (so we know which to refactor in Step 3).
- `findAllCommandSpans` still returns the same span set for the same input.

**Flag:** none — refactor only, no behavior change.

**Why now:** Step 3 needs structured tool definitions per provider. Doing this in a separate step keeps the protocol diff focused.

**Rev-2 additions:**
- **Prune-first.** Audit `bot.log` command frequency before migration. Propose a cut list of least-used tools for user review. User decision 2026-05-20: **prune, don't consolidate** — preserve each tool's distinctive behavior; just drop the long tail. Distinctive verbs stay even if they overlap; least-used die.
- **Fill in missing metadata.** Today only 4/60 commands carry `isReadOnly`; 29/60 carry `isConcurrencySafe`. Step 4's `Promise.all` for safe tools depends on full coverage. Audit and fill during migration.
- **Demote primitives subsumed by smart versions.** `smartGather`/`smartGoTo`/`smartBuildAt` already exist in `skills.js:1377+`. The LLM still chains `!searchForBlock → !goToCoordinates → !collectBlocks` because the prompt advertises those. Mark them deprecated in the registry (or hide entirely) so smart versions win.
- **Schema mapping.** Preserve existing `params{type, domain}` validation by mapping to JSON Schema. The type system in `commands/index.js:143-180` (BlockName, ItemName, int/float domains) feeds the schema generator.

---

### Step 3 — Tool-use protocol per provider (2 days, behind flag)

**Goal:** each model wrapper can send structured `tools[]` and receive structured tool calls. Initial provider scope: **Anthropic + NVIDIA only**.

**What ships:**

- `src/models/tool_protocol.js` — provider-neutral shape:
```js
// Output of every sendRequestWithTools()
{
    text: string | null,                    // assistant prose, if any
    toolCalls: [{ id, name, args }],        // structured tool requests
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
}
```

- Per-provider implementation of `sendRequestWithTools(messages, system, tools)`:
  - **Anthropic** (`src/models/claude.js`): `messages.create({ tools, system, messages })` → parse `content[]` blocks for `tool_use`. Native, best-in-class.
  - **OpenAI-compatible** (`src/models/gpt.js` for NVIDIA Build): `chat.completions.create({ tools, tool_choice: 'auto', messages: [{role:'system'}, ...] })` → parse `message.tool_calls`. Llama-3.3-70b supports this but quality is uneven — tolerant parsing required.

- Tolerant parsing: if a provider returns malformed JSON in `tool_calls[].function.arguments`, attempt a structured re-prompt with the parse error in context (one retry); only then fall through to "brain disconnected."

- Settings: `use_tool_use_protocol` per profile (default **OFF** until Step 4 lands).

**Verification:**
- Smoke test per provider: send a 3-tool request, parse response, verify shape.
- Bad-JSON injection: simulate a provider returning malformed args → see retry → success.
- Token cost report: schemas for all 60 tools cost ~9K tokens (measured) — gate by context (read-only tools always advertised; long-running ones only when no bg handle is active; etc.).

**Flag:** `use_tool_use_protocol` (default **OFF**).

**Why now:** Step 4's orchestrator depends on this; isolating the wire-format work lets us A/B test tool-use quality per provider before flipping the orchestrator.

**Rev-2 additions:**
- **12 placeholders survive in the system message.** Only `$COMMAND_DOCS` moves to `tools[]`. The other 11 (`$MEMORY`, `$TASKQUEUE`, `$STATS`, `$INVENTORY`, `$CONVO`, `$SELF_PROMPT`, `$LAST_GOALS`, `$BLUEPRINTS`, `$COC`, `$EXAMPLES`, `$CODE_DOCS`, `$ACTION`) keep their current `prompter.replaceStrings` pipeline.
- **Plan mode becomes single-channel** (user decision 2026-05-20). Today plan mode is a runtime gate in `commands/index.js:276` that rejects body-touching commands. In v2: filter advertised `tools[]` by `isReadOnly || isConcurrencySafe` instead. The runtime gate is deleted. Player-typed `!cmd` always executes — player is god.
- **(FROM OTHER BOT) hallucination retry** in `prompter.js:328` becomes unnecessary under tool-use; tool_use blocks can't carry a forged role. Delete in this step.
- **NVIDIA is "best-effort"** (user decision 2026-05-20). Tolerant parsing budget: one retry, then surface to the player as `"NVIDIA emitted invalid tool call; consider switching engine"` rather than burning more turns.

---

### Step 4 — Orchestrator v2 (2 days, behind flag)

**Goal:** replace the `for(i<max_responses)` loop with an event-driven dispatcher. This is the centerpiece — the "kill the burst" change.

**What ships:**
- `src/agent/orchestrator_v2.js`:
```js
class OrchestratorV2 {
    async handleEvent(event) {
        // event ∈ { user_message, bg_complete, checkpoint, mode_trigger }
        this.history.add(event.role, event.content);
        await this.invoke();
    }

    async invoke() {
        while (true) {
            const tools = this.getActiveTools();   // gated by plan mode + permissions + bg state
            const resp = await this.prompter.promptWithTools(this.history.getHistory(), tools);
            this.history.addAssistant(resp);

            if (resp.toolCalls.length === 0) {
                if (resp.text) this.agent.routeResponse(this.sourceFor(event), resp.text);
                return;            // park — no more LLM calls until next event
            }

            const results = await this.executeTools(resp.toolCalls);
            this.history.addToolResults(results);
            // long-running tools that returned {started, handle} count as sync results here;
            // their eventual completion fires a separate handleEvent({bg_complete, ...}).
        }
    }

    async executeTools(toolCalls) {
        // Partition by isConcurrencySafe; Promise.all the safe ones, serialize the rest.
        // For isLongRunning tools, return {status:'started', handle} immediately and register
        // in agent.background_tasks (lands in Step 5).
    }
}
```

- `agent.js` delegates to v1 or v2 based on `settings.use_orchestrator_v2`. The old `_processInput`, `self_prompter`, and `max_responses` for-loop become no-ops in v2 mode.

- A small adapter layer: `history.addAssistant(resp)` and `history.addToolResults(results)` write the conversation in the provider's native shape (Anthropic content blocks vs OpenAI message objects). Internally normalized; serialized per-provider on send.

**Verification:**
- Cherry-log scenario replay: ≤6 LLM calls end-to-end (was 15+ today).
- "Get diamonds" plan: LLM emits ≥4 `!addTask` tool_use blocks in a single response (multi-tool emission working).
- No re-invocation when a system message is appended without new info — proven by event log.
- `Promise.all` on concurrency-safe tools verified by timing (3 read-only tools in parallel < 1× the slowest).

**Flag:** `use_orchestrator_v2` (default **OFF**, opt-in by setting in profile or settings.js).

**Why now:** the actual fix to the cluster-3 burst problem. Builds on Steps 1-3.

**Rev-2 additions:**
- **Collapses three burst sources into one dispatcher** (see §1 rev-2). The legacy `self_prompter` loop, the `mode_auto` re-enqueue path, and the `_handleSideChat` parallel call all become events on one queue.
- **`self_prompt_tick` is a first-class event** (user decision 2026-05-20). Autonomous mode survives: the dispatcher emits `self_prompt_tick` every N seconds; the LLM decides whether to act. No unbounded `while` loop.
- **Side-chat behavior preserved.** `_handleSideChat`'s defer-body-cmds and `recordFollowup` logic is load-bearing for "how are you?" mid-task. Move it inside the dispatcher rather than deleting — when a `user_message` arrives mid-`bg_complete`-wait, the LLM gets both context and answers in one turn.
- **Mode triggers become `mode_trigger` events**, not synchronous `actions.stop()` + auto-enqueue cascades. The dispatcher tells the LLM "your `bg-7` handle was cancelled because `self_defense` fired; here are the surroundings" in one structured turn.

---

### Step 5 — Background tool handles (2 days, requires Step 4)

**Goal:** long-running tools return handles instantly. Physical work runs in the background. Mode interrupts cancel gracefully instead of crashing.

**What ships:**
- `src/agent/background_tasks.js` — registry of in-flight handles with `AbortController`:
```js
class BackgroundTasks {
    spawn({ toolName, args, run }) {
        const handle = `bg-${++this._seq}`;
        const ctrl = new AbortController();
        const promise = run(ctrl.signal)
            .then(result => this.agent.dispatcher.handleEvent({
                type: 'bg_complete', handle, toolName, result, role: 'system'
            }))
            .catch(err => this.agent.dispatcher.handleEvent({
                type: 'bg_complete', handle, toolName, error: err.message, role: 'system'
            }));
        this.handles.set(handle, { ctrl, promise, toolName, args, startedAt: Date.now() });
        return { status: 'started', handle };
    }
    cancel(handle) { this.handles.get(handle)?.ctrl.abort(); }
}
```

- Tools marked `isLongRunning: true`:
  - `newAction` — Coder routines, can run minutes
  - `collectBlocks` — mining N items
  - `goToCoordinates` / `goToPlayer` / `followPlayer` — pathfinding
  - `attack` — continuous combat
  - `craftRecipe` — large counts
  - `stay` with positive duration

  Each gets an `AbortSignal`-aware implementation that cleans up Mineflayer subscriptions on abort.

- `!cancelTask` looks up the handle and calls `cancel()`.

- Mode triggers (`self_defense`, `cowardice`) cancel the active long-running handle instead of crashing the process. The orchestrator gets a `bg_complete` event with `{cancelled: true, reason: 'self_defense'}` and re-invokes the LLM with context.

**Verification:**
- `!collectBlocks(20)` returns in <1s; bot chats with player normally during collection.
- `self_defense` interrupt during `!newAction` → no crash; LLM is told the action was cancelled and why.
- Two concurrent bg tools coexist (e.g. `!followPlayer` + `!attack` if both isConcurrencySafe).
- `!cancelTask(123)` aborts the right handle, frees Mineflayer subscriptions cleanly.

**Flag:** `use_background_handles` (default **OFF**, requires `use_orchestrator_v2`).

**Why now:** today's #1 crash mode (30 disconnects lifetime, multiple today). Naturally rests on Step 4's event dispatcher.

**Rev-2 additions:**
- **Rip out `recent_action_counter` cleanKill** (`action_manager.js:78`). Today this kills the process when actions fire 5+ times in 20ms windows — the literal mechanism behind today's `self_defense + newAction` crash. Replace with an orchestrator-level "N consecutive failed events → backoff and ping the player" instead of `process.exit(1)`.
- **Mode integration rework.** `modes.js execute()` today calls `actions.runAction()` + auto-enqueues `(AUTO MESSAGE)`. In v2, modes call `backgroundTasks.cancel(handle)` + emit `mode_trigger` event. The LLM gets ONE structured turn carrying cancellation context, not a crash + restart cascade.
- **Coder note.** `coder.generateCode` (coder.js:43) is its own LLM loop (MAX_ATTEMPTS=5). Step 1's rate-limit wrapper covers its model calls. Step 5's bg handle lets `!newAction` return immediately while the Coder loop runs in the background. The Coder's internal retries stay intact.

---

### Step 6 — Subagent context isolation (1 day, requires Step 4)

**Goal:** subagents run with clean context. Stale memory and parent task state don't bleed into subagent reasoning (today's `!recall` confabulation regression).

**What ships:**
- When `!dispatchAgent(role, task_description, end_factor)` fires, the subagent runs with:
  - Fresh `messages[]` containing only: role system prompt + task description + end factor
  - No parent `$MEMORY`, no parent task queue text, no parent conversation history
  - Tool subset filtered by `roles/<role>.json:tools_filter` (e.g. miner has no `!build*`, builder has no `!attack`)

- Subagent finishes → parent receives a single `tool_result` block:
```
[subagent finished]
role: miner
status: success | failed | cancelled
summary: "Got 5 diamonds, returned to spawn"
end_factor_met: true
elapsed_ms: 412000
inventory_delta: { diamond: +5, iron_pickaxe: -1 }
```

- Parent's history shows the dispatch as one `tool_use` + one `tool_result`. The subagent's internal turns never appear in the parent's history. (They're logged separately for debugging.)

- Each role profile gains an optional `tools_filter: ['mine*', 'goTo*', 'inventory*', 'invokeSkill', 'finishTask']` — glob patterns against tool names.

**Verification:**
- Stale-memory regression: parent calls `!recall('lospollos929-iron-tools')` → dispatches subagent for unrelated task → subagent does not reference iron tools.
- Subagent crash → parent gets `{status: 'failed', summary: '…'}` and continues planning; no half-broken history merge.
- Tool filter enforcement: miner subagent attempts `!build` → orchestrator rejects with "tool not in role's filter."

**Flag:** `use_subagent_isolation` (default **OFF**, requires `use_orchestrator_v2`).

**Why now:** today's confabulation evidence. Naturally rests on Step 4's tool_result protocol.

**Rev-2 additions:**
- **`tools_filter` enforcement.** Today `profiles/roles/{miner,builder,navigator,scout}.json` only carry `role + system_prompt + model + max_tokens + cooldown`. There is no `tools_filter` field, and even adding one wouldn't be consulted anywhere. v2 wires it through `tool_registry`: each role declares `tools_filter: ['mine*', 'goTo*', 'inventory*', 'invokeSkill', 'finishTask']`; the dispatcher filters advertised tools per dispatch.
- **Child task queue, run in background** (user decision 2026-05-20). Today `dispatchSubagent` (`subagent.js:51`) adds the subagent's task to the *parent's* `task_queue`, sharing the queue surface. In v2: the subagent gets its own `task_queue` instance, scoped to the dispatch and not surfaced to the planner. Subagent's `!addTask`/`!finishTask` operate on the child queue. When the dispatch ends, `finalizeSubagent` rolls up the child queue's outcome + inventory delta into one `tool_result` for the parent.
- **What stays shared.** The Mineflayer bot instance, persistent `$MEMORY` files on disk, and the in-game world state — there's only one body. Isolation is conversation history, queue, and tool advertisement only.

---

### Step 7 — Legacy retirement (1 day, after ≥1 stable week)

**Goal:** delete the chat-completion text-parsing codepath. v2 is the only path.

**What ships (deletes):**
- `src/agent/self_prompter.js` — its responsibilities now live in the orchestrator's event dispatcher.
- `findAllCommandSpans`, `parseCommandMessage` in `commands/index.js` — text parsing gone.
- The `for(let i=0; i<max_responses; i++)` loop in `agent.js:_processInput` — replaced by event dispatch.
- All `sendRequest` methods that used chat-completion text response — keep only `sendRequestWithTools`.
- Feature flags from Steps 1–6 — v2 is now the default and only path.

**Verification:**
- Bot runs for 24h on Anthropic engine with no fallback to v1 logic.
- Bot runs for 24h on NVIDIA engine with the same.
- Codebase grep for `for.*max_responses`, `findAllCommandSpans`, `self_prompter` returns nothing.

**When:** at least one stable week running v2 by default. Stable-week criteria apply **Anthropic only** (user decision 2026-05-20: NVIDIA is best-effort, accepts degradation). No exit-code-1 disconnects, no burst-related 429s observed on the Anthropic path.

**Rev-2 scope cuts (don't delete):**
- **`self_prompter.js` is NOT fully deleted.** It's used by `convoManager.pause()`/`resume()` during bot-to-bot conversations (`conversation.js:127, 192, 244`) and by the `load_mem` boot path (`agent.js:288-293`). Reduce it to the convoManager pause/resume contract; remove the `startLoop` unbounded `handleMessage` drive (Step 4 owns autonomous mode via `self_prompt_tick`).
- **`parseCommandMessage` + `findAllCommandSpans` stay.** Players can chat `!stats` / `!collectBlocks` directly (`agent.js:808-822`) — that path must survive. Both functions remain; only the LLM-emission text-parsing path dies.
- **`promptMemSaving` is already dormant** (Phase F1); remove the call site + the prompt.
- Feature flags from Steps 1-6 are deleted as planned.

---

## 4. Migration safety

### Feature flags (all default OFF except resilience wrapper)

| Flag | Step | Default | Depends on |
|---|---|---|---|
| `use_rate_limit_wrapper` | 1 | **ON** | none |
| `use_tool_use_protocol` | 3 | OFF | Step 1 |
| `use_orchestrator_v2` | 4 | OFF | Steps 1, 2, 3 |
| `use_background_handles` | 5 | OFF | Step 4 |
| `use_subagent_isolation` | 6 | OFF | Step 4 |

### Parallel-path strategy

Steps 3–6 ship as additive paths. The legacy `_processInput` for-loop stays intact until Step 7. To flip an engine to v2:

```jsonc
// profile or settings.js
{ "use_orchestrator_v2": true, "use_tool_use_protocol": true,
  "use_background_handles": true, "use_subagent_isolation": true }
```

Rollback is one config flip (set false, restart bot). No state migration needed because the conversation `history.json` schema additions in Step 4 are backwards-compatible reads (v1 ignores extra fields).

### Bot service rebuild & test

After each step:
```bash
sudo systemctl restart daedelus404.service
tail -F /home/ubuntu/pincercraft/bot.log    # watch for regressions
```

Step 4 also adds an explicit smoke script: `node test/smoke_v2.js` — runs a canned cherry-log scenario end-to-end against a mock Mineflayer environment, asserts LLM call count and no errors.

---

## 5. Provider compatibility matrix (initial scope)

| Capability | Anthropic Claude 4.x | NVIDIA Build (OpenAI-compat) |
|---|---|---|
| Tool-use protocol native | **Yes** — `tools[]`, `tool_use`/`tool_result` content blocks | **Yes** — `tools[]`, `tool_calls`, `tool` role |
| Tool-use quality on Mindcraft scenarios | Sonnet: excellent; Haiku: good | llama-3.3-70b: serviceable; deepseek-v4-pro: untested; llama-3.1-8b: unreliable |
| Embeddings | Native (Anthropic) | NVIDIA's nv-embedqa-e5-v5 needs `input_type` Mindcraft doesn't send — falls back to word-overlap |
| Rate limits (free / current) | Tier-based; paid required | 40 RPM, no documented daily cap |
| Streaming | Supported | Supported |
| Bedrock-iPad text chat compatibility | Pre-existing patches in place (see [Appendix A.6.3](#a63-bug-fixes--interrupt-and-side-chat)) | Same |

**Rev-2 status (2026-05-20):** Anthropic is the **first-class target** — Step 7's stable-week criteria apply Anthropic-only. NVIDIA is a **temporary, best-effort fallback** for cost reasons; degradation is acceptable, tolerant parsing budget is one retry then surface to player. The two engine profiles are already split (`profiles/daedelus404.claude.json`, `profiles/daedelus404.nvidia.json`); `profiles/daedelus404.json` is a symlink the user can flip.

Deferred providers (added once v2 is stable): Gemini 2.5 Flash, DeepSeek V4-Pro on NVIDIA, OpenRouter routes.

---

## 6. Open questions

### Resolved 2026-05-20 (rev-2)

| # | Question | Decision |
|---|---|---|
| 1 | Tool count vs context size — consolidate or prune? | **Prune.** Audit `bot.log` usage; cut the long tail. No consolidation — preserves distinctive behaviors. Cut list goes to user for review in Step 2. |
| 2 | Self-prompter — kill or keep? | **Keep, route through dispatcher.** Step 4 emits `self_prompt_tick`; LLM decides per tick. No unbounded `while` loop. |
| 3 | Plan-mode in v2 — runtime gate or tool-advertisement filter? | **Single-channel: filter tools[] only.** Runtime gate at `commands/index.js:276` dies. Player-typed `!cmd` always executes (player is god). |
| 4 | Mode-trigger semantics in v2 | **`mode_trigger` event.** Mode cancels via `AbortController` on the active bg handle; dispatcher feeds the LLM one structured turn with cancellation context. |
| 5 | Subagent state — what's shared, what's isolated? | **Child task queue runs in background.** Subagent gets its own queue scoped to dispatch; parent sees only the parent task. Conversation history, `$MEMORY` view, `tools[]` all isolated. Bot body + Mineflayer instance shared (one body). |
| 6 | NVIDIA — first-class or best-effort? | **Best-effort, temporary fallback.** Anthropic is the proven planner; NVIDIA stays for cost reasons but tolerant-parsing budget is one retry then surface. |

### Still open

1. **Tolerant parsing failure metric.** Need real production data on how often NVIDIA emits malformed `tool_calls.function.arguments`. Step 3 instruments this so we can see whether one-retry-then-surface is the right budget or we need more.

2. **Streaming.** Defer to post-Step-7. Non-streaming first; streaming added once v2 is stable. Bedrock chat UX currently doesn't show partial responses anyway.

3. **Bedrock-iPad slash skill UX.** `/init`/`/explore` etc. are reserved by Bedrock client. Workaround already in place: prefix with `!!` (e.g. `!!init`). Decide before Step 7 whether to formalize or replace.

4. **Subagent process boundary.** If a subagent's internal loop crashes (exit code 1 from a Mineflayer bug), the parent should still receive a clean `{status: 'failed'}` and not propagate the crash. Step 6 wraps in try/catch; whether a real per-subagent process boundary is needed is post-v2.

5. **Replacement safety net for `recent_action_counter` cleanKill.** Step 5 deletes the `action_manager.js:78` self-kill. Replacement is "orchestrator-level N-consecutive-failed-events backoff + ping player" — spec the threshold (N, window) during Step 5.

6. **Coder.generateCode integration.** It's a tool that contains its own LLM loop. With Step 5's bg handles, `!newAction` returns immediately while Coder runs in the background. Question: should Coder's internal LLM calls also be routed through `tool_use` (separate Coder tool surface), or stay text-mode given they're code generation? Default: stay text-mode for now.

---

## 7. Success criteria

| Criterion | How we measure | Target |
|---|---|---|
| **Burst eliminated.** Cherry-log scenario replay | Count LLM calls end-to-end | ≤6 (was 15+) |
| **No hallucinated commands.** Free-form replay of 70B "get diamond_axe" session | Count tool_use blocks with schema-rejected args | 0 (today: 3 of 5) |
| **No "brain disconnected" on 429.** Burst 100 calls in 60s on NVIDIA | Count wasted turns | 0 |
| **Mode-interrupt during long action.** `self_defense` fires during `!newAction` | Count agent process exit-1 events | 0 (today: ≥1) |
| **Subagent isolation.** Dispatch miner after parent `!recall`s a stale topic | Count subagent commands referencing the stale topic | 0 (today: 1 known regression) |
| **Premature `!finishTask` bypass blocked.** Bot tries to finish without end_factor | Count successful premature finishes | 0 (today: caught post-hoc; not prevented) |
| **Legacy gone.** After Step 7 | `grep -c 'findAllCommandSpans\|self_prompter\|max_responses' src/` | 0 |

---

## 8. What this blueprint deliberately does NOT cover

- **Phase D smart tools (`smartGoTo`, `smartGather`, `smartBuildAt`)** — pre-existing as renames; need real implementation but that's downstream of v2. Once tools complete units of work (not micro-steps), much of the per-step thrash from Cluster 3 goes away regardless of protocol. Track this separately.
- **Slash skills (`/init`, `/review`)** — Phase H artifacts. Re-evaluate after v2 lands. Likely thin wrappers on multi-tool plans.
- **MCP server mode** — Phase I artifact. Re-evaluate after Step 7. Probably exposes v2's tool registry directly.
- **Tool-use for Gemini / DeepSeek / OpenRouter** — explicit non-goal for v2. Add once v2 stable on Anthropic + NVIDIA.

---

## Appendix A — Historical phases (the 2026-05-17/18 work)

These shipped before today's diagnosis and are preserved for archaeological reference. Where they overlap with v2 plan, v2 supersedes.

### A.1 Phase 1 — Prompt promotion of `!newAction`
Status: shipped 2026-05-17. Rewrote `profiles/defaults/_default.json` so `!newAction` is the default executor for multi-step physical tasks. Partial impact — LLM still chains primitives for gathering.

### A.2 Phase A — Orchestrator contract (Phase A1 only)
Status: A1 shipped 2026-05-17 (multi-command parsing). A2 (per-command retry), A4 (auto-compaction) shipped. A3, A5 partial.

Multi-command parsing works at the response level (8.6 cmds/call lifetime avg). Does not change LLM **emission** frequency, which is the cluster-3 burst source.

### A.3 Phase B — Tool metadata
Status: shipped 2026-05-18. `isReadOnly`, `isConcurrencySafe` flags exist on each command. **No orchestrator currently uses `isConcurrencySafe` for parallelism** — v2 Step 4 finally consumes the metadata.

### A.4 Phase C — Plan Mode
Status: shipped 2026-05-18. Auto-trigger on task-intent player messages. Works.

### A.5 Phase D — Smart tools
Status: nominally shipped 2026-05-18 (renames). The LLM still chains low-level `!searchForBlock → !goToCoordinates → !collectBlocks` rather than calling smart versions. Needs real implementation post-v2.

### A.6 Phase E–I summary
- E (`stuck` meta-skill): auto-triggers after 2 path failures. Works but underlying thrash persists.
- F (memory layers): MemoryStore + per-bot/server/player layers. Works; subagent isolation missing — v2 Step 6 closes.
- G (subagents): `!dispatchAgent` exists, 4 role files. Roles inherited Claude hardcoding (fixed 2026-05-20). Context isolation missing — v2 Step 6 closes.
- H (skill registry): `verify`/`stuck`/`loop` meta-skills. `verify` is post-hoc only and bypassable.
- I (permissions + MCP): per-tool permission map works; MCP server stub present.

### A.6.3 Bug fixes — interrupt and side-chat
Pre-existing patches in `src/agent/input_router.js` and `agent.js:_handleSideChat`. v2 preserves these — they live in the dispatcher as event classifiers in Step 4.

### A.7 What carried over to v2
- `findAllCommandSpans` and the text-parser stay until Step 7 deletes them.
- `isReadOnly` / `isConcurrencySafe` metadata feeds directly into Step 2's tool registry.
- `MemoryStore`, `TaskQueue`, mode system, lectern watcher — unchanged.

---

## 9. Related docs

- [`diagnosis-2026-05-20.md`](./diagnosis-2026-05-20.md) — the analysis driving this plan
- [`queue-design.md`](./queue-design.md) — action queue + priority design (still current)
- [`CHANGELOG.md`](./CHANGELOG.md) — per-commit shipping log
- `../CLAUDE.md` — the live code of conduct (rebuilt by the lectern watcher)
- `bots/Daedelus404/memory/MEMORY.md` — the live memory index
- Memory: `project_pincercraft_bot_plan` (auto-memory pointer, due for update once Step 4 lands)
- Reference: [codeaashu/claude-code](https://github.com/codeaashu/claude-code) — leaked Claude Code source; used at architecture/pattern level only.

---

## Appendix B — Code reality snapshot (2026-05-20)

Captured during the rev-2 deep read so the next reader can verify the v2 plan against today's code without repeating the trace. File:line citations are anchors, not strict (touch-and-go on small edits).

### B.1 Orchestrator architecture (what's actually there)

```
event (player chat / mode trigger / bot death / init)
     │
     ▼
 agent.respondFunc()    (agent.js:248) — player/whisper handler
     │
     ▼
 agent.enqueue(input)   (agent.js:629) — classifies + serializes
     │     ├── interrupt? → abortCurrent + clear + push
     │     ├── player_chat mid-task? → _handleSideChat (parallel LLM call)
     │     └── otherwise → run_queue.push
     ▼
 RunQueue               (run_queue.js) — promise-based push/next, AbortController per run
     │
     ▼
 agent._runWorker       (agent.js:750) — single forever consumer
     │
     ▼
 agent._processInput    (agent.js:774) — per-input planner loop:
                          for (i<max_responses):
                            prompter.promptConvo → LLM
                            parse commands → execute each
                            history.add(system, result)
                            break if response had no commands
```

**Three concurrent burst sources** to be aware of:
- `self_prompter.startLoop` (`self_prompter.js:65`) — `while (!interrupt) handleMessage('system', msg, -1)` with 2s cooldown
- `modes.execute` (`modes.js:306`) — interrupts current action and enqueues `(AUTO MESSAGE)` after
- `_handleSideChat` (`agent.js:667`) — parallel LLM call while worker is running

### B.2 Command system

- Two lists merged in `commands/index.js:8` — `queryList` (read-only) + `actionsList` (mutating)
- Regex parser at `commands/index.js:30`: `/!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*…)*)\))?/`
- Type checks at `commands/index.js:143-180` — `int`, `float`, `boolean`, `BlockName`, `ItemName`, `BlockOrItemName`, `string`, with `domain` interval validation for numbers
- Per-command hooks (Phase B): `isReadOnly`, `isConcurrencySafe`, `isDangerous`, `prompt(ctx)`, `checkPermissions(args, ctx)`
- **Metadata coverage today** (verified `grep -c`): `isReadOnly` — 4/60; `isConcurrencySafe` — 29/60. Rev-2 Step 2 fills the gaps.
- Plan-mode gate at `commands/index.js:276` rejects body-touching commands; v2 Step 3 deletes this (single-channel decision).

### B.3 ActionManager

- `_executeAction` (`action_manager.js:61`) tracks `last_action_time` and `recent_action_counter`. **At >5 actions in <20ms windows it calls `agent.cleanKill` (line 78) → `process.exit(1)`.** This is the real mechanism behind the `self_defense + newAction` crash.
- No `AbortController`. Stop is cooperative via `bot.interrupt_code = true` polled inside running actions (`coder.js:181` injects checks into generated code).
- 10-second timeout for `stop()` to settle (`action_manager.js:28`), then `cleanKill`.

### B.4 Modes (12 of them)

`modes_list` in `modes.js:24`: `self_preservation`, `unstuck`, `cowardice`, `self_defense`, `hunting`, `item_collecting`, `torch_placing`, `elbow_room`, `idle_staring`, `cheat`. Each carries `interrupts: ['all']` or `interrupts: ['action:followPlayer']`.
- `update()` runs every 300ms (`agent.js:1120`) via `agent.update`.
- `execute(mode, agent, func)` (`modes.js:306`) calls `actions.runAction(mode:${name}, func)` which **interrupts** the running action, then on completion enqueues `(AUTO MESSAGE) Your action ... was interrupted by ${mode.name}`.
- `behavior_log` accumulates per-mode notes flushed via `bot.modes.flushBehaviorLog()` and rendered into prompts.

### B.5 Subagents (today)

- `subagent.js:51` adds the subagent's task to the **parent's** `task_queue` and injects the role's `system_prompt` as a system message in the **parent's** `agent.history`. No isolation.
- Role profiles (`profiles/roles/{miner,builder,navigator,scout}.json`) carry `role + system_prompt + model + max_tokens + cooldown`. **No `tools_filter` field** anywhere; even if added, nothing reads it.
- `finalizeSubagent` (`subagent.js:100`) rolls up `success/summary/inventory_delta/position` into a single `[subagent finished]` system message.

### B.6 Memory layers (Phase F)

`memory_store.js` + `buildLayeredMemoryIndex` (line 79) render `$MEMORY` from three layers in order:
- **Server** (`./memory/server/*.md`) — shared across all bots
- **Bot** (`./bots/<name>/memory/*.md`) — per-bot index
- **Player** (`./memory/players/<slugged-name>.md`) — only the most recent human sender

Hard caps: 200 lines index, 4KB per topic, 30 topics, 120 char summary. `wipe_memory_on_start` only touches `bots/<name>/memory.json` (history), NOT the layered files.

### B.7 Prompter — 12 placeholders

`prompter.js:186` (`replaceStrings`) substitutes: `$NAME`, `$TASKQUEUE`, `$MEMORY`, `$COC`, `$STATS`, `$INVENTORY`, `$ACTION`, `$COMMAND_DOCS`, `$CODE_DOCS`, `$EXAMPLES`, `$TO_SUMMARIZE`, `$CONVO`, `$SELF_PROMPT`, `$LAST_GOALS`, `$BLUEPRINTS`. v2 Step 3 only moves `$COMMAND_DOCS` to `tools[]`; the others stay.

Other Prompter calls:
- `promptConvo` — chat path, 3 tries, retries on `(FROM OTHER BOT)` hallucination, strips `</think>`
- `promptCoding` — code path, drives `Coder.generateCode` loop
- `promptCompact` — Phase A4 history compaction, hard 2KB cap on summary
- `promptShouldRespondToBot` — bot-to-bot filter
- `promptVision` — vision path
- `_modelForActiveTurn` — Phase G3 routes to subagent's model if active

### B.8 Coder

- `generateCode` (`coder.js:31`) is its own LLM loop with `MAX_ATTEMPTS=5`, `MAX_NO_CODE=3`
- Code is staged via `_stageCode` which injects `bot.interrupt_code` checks at every `;\n` (line 181)
- Compartment lockdown via `library/lockdown.js`; only `skills`, `log`, `world`, `Vec3` are exposed
- `MISSING_TOOL` signal short-circuits retries when `bot.equip(null)` throws

### B.9 Side-chat path (load-bearing, preserve in v2)

`_handleSideChat` (`agent.js:667`):
1. Player chats while worker is running → parallel `prompter.promptConvo` call
2. Parses all command spans, executes `isConcurrencySafe` ones, defers body-touching ones
3. Records `_pendingFollowups` per target; deduped by sender
4. `_onQueueChange` drains the follow-up list on next task finish
5. If LLM emits nothing or fails, sends `Heard you — give me a sec.` / `Kinda busy right now, sorry — I'll get back to you.`

v2 Step 4 must preserve all of this inside the dispatcher.

### B.10 Phase H — verify gate

`verify.js:58` (`verifyEndFactor`) parses three end_factor shapes:
- `N item_name in inventory` — count match
- `item_name in inventory` — implied ≥1
- `item_a, item_b, item_c in inventory` — multi
Returns `{programmatic: false}` for fuzzy criteria (passes through). Currently invoked from role profiles as `!invokeSkill("verify")` before `!finishTask`.

### B.11 Stuck watcher (load-bearing, separate from action_manager loop detector)

`_startStuckWatcher` (`agent.js:337`) — polls bot position 1Hz, on 5s of <0.6 block drift during a motion-class action, `/tp` the bot to `last_sender`. Kill-switch at 3 TPs / 5 min. Distinct from `action_manager.js:78`'s `recent_action_counter` kill — the stuck watcher is a recovery mechanism, the action_manager kill is a panic-shutdown.

---


