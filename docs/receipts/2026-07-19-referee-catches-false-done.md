# Receipt: the referee catches a false "done", live

One task, run twice on the same day, same world, same model, same server:
**"Mine 16 NEW cobblestone this run"**, success criterion `+16 cobblestone in
inventory (net gain this run)`. The only difference between the two runs is a
flag file that switches the deterministic harness off — raw state, no gates,
no verified finishes. This was cycle 1 of both arms of Field Trial v1.
Primary sources: `bots/Daedelus404/episodes/350.jsonl`, `360.jsonl`,
[the full trial runner log](logs/2026-07-19-field-trial-run7.log), the
`task_attempts` ledger (`task_set = bench_on` / `bench_off`), `bot.log`
(grep -a).

## Harness ON — task #350

Trace: `!addTask` → `!findAndMine` ("Mined stone at x:113 …", 1018 chars of
actual mining) → 55 seconds later the deterministic finish check runs:

```
[finishTask] #350 end_factor "+16 cobblestone in inventory (net gain this run)" — verified (cobblestone+23)
```

Referee verdict, from the runner log:

```
referee: {"parseable":true,"success":true,"label_source":"referee",
          "expected":"+16 cobblestone",
          "observed":"cobblestone+23 (have 95, started 72)"}
```

Score: **55s of mining, +23 cobblestone measured against the pre-task
baseline, finish verified twice — once by the harness, once by the referee.**

## Harness OFF — task #360

Trace, complete: `!addTask` → drive nudge ("the action queue is idle,
continue working on it") → **6 seconds, 2 LLM turns, 93 output tokens, zero
mining actions** → the model declares the task done. The episode file has
nothing between the task being added and the episode ending. No `[finishTask]`
verification line exists — with the harness off, nothing checks the claim.

Referee verdict:

```
referee: {"parseable":true,"success":false,"label_source":"referee",
          "expected":"+16 cobblestone",
          "observed":"cobblestone+0 (have 77, started 77)",
          "referee_failure_mode":"false_done_referee"}
```

Note the `have 77`: the bot was holding 77 cobblestone from earlier work, saw
a full bag, and figured that counted — the exact pathology of the original
gather-32-cobblestone anecdote that motivated the referee, reproduced on
demand a month later.

Score: **6 seconds, nothing gained, "done."**

## It wasn't a one-off

Across the full harness-off arm, 8 of 9 measurable tasks ended exactly this
way — declared done within 0–16 seconds, referee measuring `+0` (one task
gained 5 of the 8 required) — failure mode `false_done_referee` on every one.
The single honest off-arm pass (craft 3 ladders) had the materials already on
hand. The harness-on arm went 9/9, every finish verified. Same model on both
arms. Full table in the [README](../../README.md#receipts); every row is in
the ledger.

## Why this is the thesis

The model didn't get dumber when the flag file appeared. What changed is that
nothing in the loop owned the fact *"is this task actually done?"* — so the
model was free to answer it by vibes, and it answered wrong 8 times out of 9,
in seconds, with total confidence. Code that snapshots inventory at task
start and refuses the finish until the delta covers the goal is a few dozen
lines. That's the trade this repo is about: **code owns the facts, the LLM
owns the plan** — because the facts are cheap to compute and expensive to
hallucinate.
