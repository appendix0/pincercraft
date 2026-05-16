# PincerCraft — Action Queue & Priority Design

> Status: draft. Iterating before writing code.
> Authors: @appendix0, with Claude.
> Inspiration: [OpenClaw agent loop](https://docs.openclaw.ai/concepts/agent-loop) + [queue modes](https://docs.openclaw.ai/concepts/queue).

---

## 1. Why we are doing this

Upstream Mindcraft's `handleMessage()` (`src/agent/agent.js:254`) is a single async function called directly from each `whisper`/`chat`/event handler. It has three structural problems:

1. **No serialization.** Two chat messages arriving close together call `handleMessage()` in parallel. Both compete for `this.history`, the LLM model, and the mineflayer bot. State corruption is real.
2. **No clean interrupt.** `requestInterrupt()` stops mineflayer movement, but it does not tell the LLM loop to stop or change context. The bot frequently resumes the old task after a "stop" command.
3. **Game events are invisible to the LLM.** `modes.js` reflexes (low health, enemy spotted, etc.) handle themselves but never reach the conversation loop, so the LLM can't reason about them or factor them into multi-step plans.

The bot feels "dumb" partly because of model limits, but mostly because the **loop architecture has no concept of priority, concurrency, or context switching.**

This design fixes that by adding a real action queue with prioritized inputs, drawn from OpenClaw's design but adapted for Minecraft's continuous, event-driven world.

---

## 2. Design goals

- **No self-collisions.** A bot can only do one thing at a time. Two inputs racing for the LLM is structurally impossible.
- **Interruptibility.** Urgent inputs (player saying "stop", low health) immediately abort the current run.
- **LLM-visible state.** The LLM sees what task is running and what is queued, so it reasons about its own context.
- **Phased and testable.** Each phase ships a working subset and is tested in-game before the next phase begins.
- **Backward compatibility.** All existing Mindcraft features (commands, skills, modes, self-prompter) keep working unchanged.

---

## 3. Architecture overview

Three components added on top of existing Mindcraft:

```
┌──────────────────────────────────────────────────────────┐
│  Mindcraft event sources (unchanged producers)           │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────────┐    │
│  │ bot.on whisper│ │ bot.on chat│ │ modes.js events  │    │
│  └──────┬───────┘ └─────┬──────┘ └─────────┬────────┘    │
└─────────┼────────────────┼─────────────────┼─────────────┘
          │                │                 │
          ▼                ▼                 ▼
     ┌─────────────────────────────────────────┐
     │      InputRouter.enqueue(input)          │  ◄── NEW
     │  - classifies mode (interrupt/followup)  │
     │  - on `interrupt`: signal + clear queue  │
     └────────────────┬────────────────────────┘
                      │ push
                      ▼
     ┌─────────────────────────────────────────┐
     │           RunQueue (one per agent)       │  ◄── NEW
     │  - FIFO of pending Input objects         │
     │  - interrupt token (AbortController)     │
     │  - state: idle | running | interrupted   │
     └────────────────┬────────────────────────┘
                      │ next()
                      ▼
     ┌─────────────────────────────────────────┐
     │     RunWorker (single async loop)        │  ◄── NEW
     │  while alive:                            │
     │    input = await queue.next()            │
     │    await agent._processInput(input)      │
     │     (= old handleMessage body, with      │
     │      interrupt-checkpoints inserted)     │
     └─────────────────────────────────────────┘
```

The **producers stay the same** — `whisper`/`chat`/event handlers still fire as they do today. They just call `enqueue()` instead of `handleMessage()` directly.

The **consumer is new** — a single worker loop owns the LLM and the bot for one run at a time.

---

## 4. Input sources and default queue modes

Minecraft has five input channels. Each gets a default mode (overridable by content or keyword):

| Source | Default mode | Notes |
|---|---|---|
| Player chat / whisper | `followup` | Queue and run after current. Becomes `interrupt` if the message contains `!stop` or starts with `!` urgency keywords. |
| Game event — critical (health < 6, on fire, drowning) | `interrupt` | Bot's life is in danger. Drop everything. |
| Game event — ambient (sunset, item drop nearby, idle stare) | `collect` | Low-priority context updates. Batched into next followup turn. |
| Self-prompter tick | `followup` | Just another "continue the goal" message. Same priority as a player asking for a status update. |
| Inter-bot message | `followup` | Treat like player chat from the other agent. |

These defaults are heuristics; we'll tune them with playtesting.

---

## 5. The four queue modes (full eventual set)

| Mode | Behavior when input arrives | Implementation difficulty |
|---|---|---|
| `interrupt` | Abort the current LLM call / skill. Clear pending queue. Push this input. State → `interrupted` → `running` (new task). | **Easy.** AbortController + clearing the queue. **In Phase 1.** |
| `followup` | Push input to end of queue. If worker is idle, it picks it up. State unchanged. | **Easy.** This is just FIFO behavior. **In Phase 1 implicitly** (already what a serial lane does). |
| `collect` | If a `followup` is already queued, append this input's text to that followup's content. Otherwise push as a fresh followup. | **Medium.** Need to look at queue tail. **Phase 2.** |
| `steer` | Inject input's text into the CURRENT running task — appended to history mid-run, visible to the next LLM call within the current loop. The current task is not aborted. | **Hard.** Requires the worker's inner loop (between LLM calls) to check a steer-inbox. **Phase 3.** |

---

## 6. The new shape of `handleMessage`

Today (simplified):
```js
async handleMessage(source, message) {
    // build prompt, call LLM, parse command, execute, loop
}

bot.on('whisper', (user, msg) => handleMessage(user, msg));
```

Tomorrow:
```js
// Producer side (called by event handlers, kept simple)
enqueue(input) {
    const mode = this.input_router.classify(input);
    if (mode === 'interrupt') {
        this.run_queue.abortCurrent();
        this.run_queue.clear();
    }
    this.run_queue.push({ ...input, mode });
}

// Consumer side (runs forever after agent.start())
async _runWorker() {
    while (this.alive) {
        const input = await this.run_queue.next();   // awaits until something is queued
        try {
            await this._processInput(input);          // = old handleMessage body
        } catch (e) {
            if (e.name === 'AbortError') continue;    // interrupted, just take the next one
            console.error('Run failed:', e);
        }
    }
}

bot.on('whisper', (user, msg) => agent.enqueue({source: user, message: msg, kind: 'player_chat'}));
```

`_processInput` is the old body of `handleMessage`, with **interrupt checkpoints** added:
- Before each LLM call: `if (this.run_queue.aborted) throw new AbortError()`
- Between command execution and the next LLM call: same check
- Pass the `AbortSignal` into the LLM HTTP call so an in-flight request gets cancelled cleanly

---

## 7. Interrupt semantics — what survives

When an `interrupt` fires mid-run, three things happen in order:

1. **Cancel the LLM call.** AbortSignal aborts the HTTP request. The current `_processInput` invocation throws `AbortError`.
2. **Cancel mineflayer actions.** Call existing `requestInterrupt()` to stop digging/pathfinding/PvP. (Already exists in Mindcraft.)
3. **History handling.** The interrupted run's partial history is preserved as-is — the bot's last `system` message gets an appended note: `[Interrupted by: <source>]`. The next run sees this so the LLM understands its previous task was cut off.

This way the bot doesn't pretend the old task didn't happen; it knows "I was building when you said stop."

---

## 8. Phased rollout (we ship and test each phase)

### Phase 1 — Minimal: serial lane + interrupt only (~150 lines)

**Goal:** Two messages arriving close together never race. `!stop` actually stops.

**What ships:**
- `src/agent/run_queue.js` — RunQueue class with `push`, `next`, `abortCurrent`, `clear`, AbortController.
- `src/agent/input_router.js` — InputRouter that classifies all inputs as either `followup` (default) or `interrupt` (if message includes `!stop` or low-health event).
- `src/agent/agent.js` — Refactor `handleMessage` into producer/consumer. Start `_runWorker` at spawn.
- Wire critical health event from `modes.js` → `enqueue({kind: 'game_event_critical'})`.

**Test plan (manual, in-game):**
1. Bot is building. Player whispers two messages 1s apart. Bot finishes building, then handles them in order. ✅ no race.
2. Bot is mid-task. Player whispers `!stop`. Bot stops within ~2s. ✅ interrupt works.
3. Bot takes lethal damage. Mid-task is dropped, bot reacts to threat. ✅ critical event interrupts.
4. All existing Mindcraft commands still work as before. ✅ no regression.

**Acceptance criteria:** All 4 manual tests pass. We commit, push, move to Phase 2.

### Phase 2 — Add `collect` mode (~50 additional lines)

**Goal:** Burst of three player messages handled as one batched turn, not three separate runs.

**What ships:**
- `RunQueue.coalesceTailIfMatching(input)` method.
- InputRouter rule: ambient game events default to `collect`.

**Test plan:**
1. Send three messages in 2 seconds. Bot sees all three concatenated in one LLM turn. ✅
2. Five item-pickup events in 5s show up as one summary message. ✅
3. Phase 1 tests still pass. ✅

### Phase 3 — Add `steer` mode (~150 additional lines)

**Goal:** Player says "also pick up dirt" while bot is building → bot adjusts mid-build without restarting.

**What ships:**
- A `steer_inbox` checked inside `_processInput`'s LLM loop, between command executions.
- InputRouter rule: messages starting with `!steer` use steer mode.

**Test plan:**
1. Bot starts a long build. Player whispers `!steer also chat hi every step`. Bot continues building AND chats hi periodically. ✅
2. Phase 1 + 2 tests still pass. ✅

### Phase 4 — Tuning + observability (~50 lines)

- Add `$RUN_STATE` placeholder in prompts so the LLM sees current task + queue depth.
- Add per-source rate limits to prevent griefer message spam.
- Log every queue transition for debugging.

---

## 9. State storage

In-memory only. The queue does not persist across bot restarts — restart drops pending inputs (acceptable; player can re-issue). History persists as Mindcraft does today.

If we later want crash-recovery, the queue can be persisted to `bots/<name>/queue.json` on every state change. Not in scope for Phase 1–3.

---

## 10. Open questions for review

1. **Sessions.** Phase 1 assumes one global lane per bot. Should we have **per-player** lanes (so player A talking doesn't block player B's questions)? Probably yes eventually; not in Phase 1.
2. **History on interrupt.** Should the aborted run's partial history be kept verbatim, summarized, or discarded? Phase 1 keeps verbatim + an `[Interrupted by X]` marker. Tune later if it bloats context.
3. **Game event taxonomy.** I've proposed `critical` vs `ambient`. Is that enough granularity? Or do we need a third tier like `urgent` (e.g., "an iron golem just spawned"; important but not life-threatening)?
4. **Steer in Phase 3.** Should `steer` inject at the next LLM call only, or wait for the current skill (e.g., a long `!collectBlocks`) to finish first? Probably "before next LLM call but not mid-skill," but worth confirming.

---

## 11. What this is NOT

- Not a planner. The LLM still decides one command at a time. Multi-step planning is a different change (would be a separate design doc).
- Not a multi-agent coordinator. One bot, one queue. Inter-bot conversation is still handled by `conversation.js`.
- Not a replacement for `modes.js`. Reactive modes still run in the 300ms tick loop. The queue just gets a copy of the *critical* events for LLM awareness.

---

## 12. Implementation order

1. Land this design doc (now). **← we are here**
2. Implement Phase 1. Test in-game.
3. Decide based on Phase 1 testing whether priorities (or design) need adjustment.
4. Implement Phase 2. Test.
5. Implement Phase 3. Test.
6. Implement Phase 4. Test.

Each phase is one PR-sized chunk on the `develop` branch.
