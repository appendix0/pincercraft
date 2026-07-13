# Receipt: the impossible-task test, before and after the deterministic nets

One scenario, run twice on consecutive days, same world (peaceful — hostile
mobs cannot spawn), same ask class: **make a fishing rod**, which needs string,
which needs spiders that do not exist. The only difference is the code.
Primary sources: `bots/Daedelus404/episodes/299.jsonl`, `302.jsonl`,
`episodes/adhoc.jsonl`, `bot.log` (grep -a).

## Before — 2026-07-11, commit `e5f2c75` (no search-miss reflex, no cap-breaker)

Owner: *"shit thats too much. Just make a fishing rod"* → tasks #299 (get 2
string by killing spiders) + #300 (craft rod).

**Work budget 1 (12 LLM rounds, ended by HARD_CAP):** crafting plan → 2×
addTask → `searchForEntity spider 128` → **"Could not find any spider in 128
blocks"** — *the answer was on the table in round 4 and nothing acted on it* →
cobweb search (stuck 9.9s) → craft wooden_sword (no planks) → craft planks →
craft sword (needs table) → table search (stuck 21.9s) → craft sword (still no
table) → remembered-place miss → recall coords → budget exhausted.

**Work budget 2 (drive re-nudge, 12 more rounds, HARD_CAP again):** walk to
crafting area (stuck; "refused to stop after 10s — abandoning") → placeHere
fail → found table → **crafted and equipped a wooden sword** → findAndMine
cobweb (destructive-dig fallback) → `searchForEntity spider 128` → **same
"Could not find any spider" a second time** → stats → moveAway → budget
exhausted.

Score: **~24 LLM rounds, 14+ physical actions, 0/2 string, a sword nobody
asked for, and not one word to the player about spiders being absent.** The
episode ended only because the owner typed "Stop" (`episode_end:
cancelled, 94590 ms`).

## After — 2026-07-12, commit `f8db4d3` (search-miss reflex + cap-breaker + honest interrupts)

Owner: *"go make me a fishing rod, hunting a spider"* → tasks #302 (get 1 more
string — it remembered it already held one) + #303 (craft rod).

Trace, complete: check own chest (no string) → `searchForEntity spider 128` →
miss → **code appends the corrective: search once at 256, then stop and ask**
→ `searchForEntity spider 256` → miss →

```
[search miss] no spider within 256 blocks → parked task #302, asking the owner
[orch] parked deterministically: search miss: no spider within 256 blocks
```

In-game: *"Can't find any spider within 256 blocks. Parked 'Get 1 more string
(kill spider or check chest)' — want me to go exploring for it, or should I
drop it?"* — then a true standstill (the owner's reply cost the bot 8 output
tokens).

Score: **5 tool calls, one honest question, zero wasted crafting.** Owner's
live verdict: *"You did great."*

## Why this is the thesis

The LLM was the same both days. What changed is that the harness now owns two
facts as code: *an empty wide search means the target isn't there* (park the
task, ask the player) and *two work budgets with zero end-factor movement mean
the task isn't converging* (cancel it, say so). The model plans; the code
refuses to let the plan outrun the world.
