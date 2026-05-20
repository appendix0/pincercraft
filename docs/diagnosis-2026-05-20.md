# Pincercraft Diagnosis — 2026-05-20

> Status: Point-in-time analysis. Drives the v2 rewrite plan in [agent-blueprint.md](./agent-blueprint.md).
> Triggered by: NVIDIA-llama testing session on YOON that hit a wall of 429s, hallucinated commands, mode-interrupt crashes, and stale-memory confabulation — exposing that Phases A–I never touched the load-bearing walls.

## 1. What today's `bot.log` shows

Counts from this session unless noted lifetime:

- **8B duplicate-task loop**: 16 iterations counted via `grep -c "tasks are .* duplicated"`
- **70B wrong commands** within 5 turns of a single "get diamond_axe" sequence:
  - `!givePlayer("Daedelus404", "diamond_axe", 1)` (self-target on a give-to-other tool) — line 57140
  - `!takeFromChest("diamond_axe", 1)` (chest tool for a ground item) — line 57182
  - `!collectBlocks("diamond_axe", 1)` (block tool for an item entity) — line 57187
- **Premature `!finishTask(134)`** with 0 diamond_axe — `[verify]` post-check caught it; nothing in the LLM's reasoning would have. Line 57205.
- **`!recall` confabulation**: after a forced restart, bot queued a brand-new task ("check iron tools in inventory") from a stale memory topic the user never requested. Line 57274.
- **`self_defense` mode interrupted `!newAction`** → agent exit code 1 → Mindcraft auto-respawn. **30 disconnects lifetime**, multiple today.
- **Anthropic credit-balance errors**: 12 in today's session before swapping engines.
- **NVIDIA 429 rate-limit errors**: 12 lifetime, 2 today after cooldown bump to 3000ms.
- **"My brain disconnected" wasted turns**: 34 lifetime. Each = consumed call + zero progress + quota burn.
- **Embedding errors**: 294 lifetime. Mindcraft's `embed()` doesn't send `input_type`, which NVIDIA's `nv-embedqa-e5-v5` requires. Each failed call still hits the network.
- **Commands per LLM call**: 1711 commands / 198 calls ≈ **8.6 commands per call** — multi-command batching from Phase A1 IS working at the response level.
- **Most-issued commands (lifetime)**: `!searchForBlock` 186, `!goToCoordinates` 113, `!collectBlocks` 104, `!craftRecipe` 83, `!inventory` 74, `!stop` 66, `!recall` 61, `!goToPlayer` 55. The discover-then-act pattern dominates.

## 2. Where pain aggregates

**Cluster 1 — Wrong command, no schema guard rail.** The 70B emitted three structurally invalid commands in a row. Text parsing accepted all of them; each got executed and returned a failure or did nothing useful. No JSON Schema layer exists where bad arguments get rejected at the protocol — every command is `string in, string out`, and the model has to know which command applies to which scenario from prose docs alone.

**Cluster 2 — Long-running tools tangle with mode interrupts.** When `self_defense` fired during a `!newAction`, the Mindcraft action manager couldn't gracefully suspend, abort, or resume the in-flight code routine. It just crashed (exit code 1). Same shape will hit any long-running command (`!collectBlocks(20)`, `!followPlayer`, `!craftRecipe` with many iterations). No concept exists of a "running tool handle" that can be cancelled cleanly and re-engaged with.

**Cluster 3 — Orchestrator has no economy of motion.** Even with 8.6 cmds/call batching, the for-loop in `agent.js:_processInput` runs `for(let i=0; i<Infinity; i++)` and re-invokes the LLM on every round where the last response contained commands. For an active task that's a re-prompt every few seconds. NVIDIA's 40 RPM and Gemini's 10 RPM both lose to this pattern. The model can't tell the orchestrator "I have nothing to think about, park me until something happens" — its only park signal is emitting prose with no commands.

**Cluster 4 — Memory and context bleed.** Bot reads a `!recall` result and immediately reasons as if the recalled content is a current user request (today's "check iron tools" confabulation). The conversation history is monolithic — old user messages, system results, memory dumps, subagent prompts all share the same context window. The model can't tell which is currently load-bearing.

**Cluster 5 — Honor-system verification.** The `[verify]` post-check on `!finishTask` is the only thing preventing the LLM from declaring tasks done that aren't. The model bypasses every prompt instruction telling it to check end_factors first. It will keep doing so on any model below Sonnet-tier.

**Cluster 6 — Resilience missing everywhere.** 12 × 429 = 12 × "My brain disconnected" = 12 × wasted turn AND 12 × quota-counting failed call. Zero retry-with-backoff in any `src/models/*.js`. Zero rate-limit awareness in any client. Both providers (NVIDIA, eventually Gemini) WILL rate-limit on agentic workloads.

**Cluster 7 — Implicit Claude-tier assumption.** 5,000-word system prompt + 60-command vocabulary + queue + plan-mode + memory + subagents = a context heavy enough that only Claude-tier models follow it cleanly. Haiku fine. Sonnet great. Llama-3.3-70b drifts (3 wrong commands / 5 turns). Llama-3.1-8b breaks (16-iter loop). No graceful degradation path exists — the bot just gets sloppier.

## 3. Root-cause stack (surface → deep)

```
Layer 1 (surface):
  Hallucinated commands, wasted turns, mode crashes, rate-limit bursts
   ↑ caused by
Layer 2:
  Text-parsing protocol with no schema validation;
  long-running tools that block the loop;
  conversation-style re-prompting on every system message;
  no retry, no throttle, no cancellation
   ↑ caused by
Layer 3:
  Mindcraft architected as a chatbot, not an agent.
  LLM treated as a conversation partner emitting text that contains commands,
  rather than as an agent emitting structured tool calls and waiting for results.
   ↑ caused by
Layer 4:
  2023-era chat-completion design, predating the messages+tools[] protocol.
  Then evolved by bolting features on top (Phases A–I)
  without touching the core loop shape.
```

## 4. What Phases A–I closed, and what they didn't

| Phase | Shipped | Closed the gap? |
|---|---|---|
| 1 (prompt promotion of `!newAction`) | Prompt prefers `!newAction` for multi-step | Partial — still chains `!nearbyBlocks → !searchForBlock → !collectBlocks` for gathering |
| A1 (multi-command parsing) | `!a !b !c` in one response all execute | **Yes for parsing.** Doesn't change LLM emission cadence |
| A4 (auto-compaction) | History compressed at 3K-token threshold | Yes — context bloat under control |
| B (tool metadata) | `isReadOnly`/`isConcurrencySafe` flags exist | Flags exist; **no orchestrator uses `isConcurrencySafe` for parallelism** |
| C (Plan Mode) | Read-only-only during planning | Works |
| D (smart tools) | Renamed primitives | **Did not** — LLM still chains low-level primitives instead of using smart versions |
| E (`stuck` meta-skill) | Auto-triggers after 2 path failures | Works but the per-step thrash that causes the failures persists |
| F (memory layers) | MemoryStore + layered context | Works; **no subagent isolation** — today's confabulation evidence |
| G (subagents + roles) | `!dispatchAgent` exists, 4 role files | Roles existed; **no context isolation, no model-routing fallback** |
| H (skill registry) | `verify` / `stuck` / `loop` meta-skills | `verify` post-hoc only; bypassable; `stuck` works |
| I (permissions + MCP) | per-tool permission map; MCP server stub | Works |

**Net of phases**: parsing, planning, observability got real fixes. The **protocol** (text vs tool-use), the **orchestrator loop** (for-loop vs event-driven), the **long-running tool shape** (blocking vs background), and the **resilience layer** (retry / throttle / cancel) — the foundations a Claude-Code-style agent rests on — never got touched. Phases A–I built skyscrapers on a 2023 chat-completion slab.

## 5. Thesis

The bot is **a chatbot with agent prosthetics**. Every problem in §1 traces to that. To become a Claude-Code-style agent it needs, in order:

1. **Structured tool protocol** (tools[] + tool_use + tool_result blocks) instead of text command parsing
2. **Event-driven orchestrator** (LLM invoked only when something new happens) instead of the for-loop
3. **Background tool handles** instead of blocking long-running commands
4. **Resilience layer** (retry, throttle, cancel) instead of "My brain disconnected"
5. **Subagent context isolation** instead of monolithic history
6. **Graceful model degradation** (smaller tool sets, smaller prompts) for free-tier providers

Phase D's smart tools and a curated command vocabulary sit on top. The original blueprint correctly named the goal (Claude-Code-style agent) but its phases never touched the load-bearing walls.

## 6. What this diagnosis is NOT

- Not a critique of the previous work. Phases A–I shipped real value at the layers they targeted.
- Not a model-choice problem to be solved by swapping LLMs. Even Sonnet under the current loop would burst calls and crash on mode interrupts.
- Not a settings tweak. `cooldown: 3000` was a band-aid that didn't hold against agentic bursts.
- Not a prompt problem. The prompt is over-specified for the current substrate, not under.
