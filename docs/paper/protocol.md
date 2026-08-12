# Frozen confirmatory protocol

Frozen 2026-08-09. Every **confirmatory** experiment from this date runs under
this procedure. Terms are defined in [terminology.md](terminology.md); the
scientific commitments live in [preregistration.md](preregistration.md).

If a run deviates from anything below, it is exploratory. There is no third
category.

---

## 0. Exploratory vs confirmatory

**Shuffled backtests 1–3 (attempts up to #616) are EXPLORATORY.** They may
generate hypotheses, expose failure modes, and size future experiments. They
must not supply a number to the paper's claims.

This is not a formality. Three separate defects in those runs each produced a
result that looked real and was not:

| apparent finding | actual cause |
|---|---|
| compound verify+autofinish arm cost 61.1 pp | API credit exhausted; 10 attempts at 0 turns |
| ablating the precondition layer *helped* (−13.3 pp) | arm position confounded with arm identity |
| harness advantage grows with task complexity | contradicted once measured; gap is largest at tier 1–2 |

Numbers already banked from that data are reported as exploratory, with the
discard rate (11.3%) stated. Confirmatory numbers come only from runs under
this protocol.

## 1. Environment and starting state

- Runs target **pincercraft-ts (`127.0.0.1:25566`)**, the dedicated eval world,
  via `.runtime/target.json`, verified from the OS after spawn. Never YOON.
- **No human player** on the eval server during a batch.
- **State reset is on by default and mandatory.** Before every attempt the
  runner clears the bot's inventory, issues the standard kit, and returns it to
  the pinned position, over RCON. `RESET_STATE=0` is the explicit opt-out and
  marks the run exploratory.
- **If the reset cannot be applied, the run aborts.** It does not warn and
  continue: that would produce attempts which look protocol-compliant while
  running on carried-over state, and nothing downstream could tell.
- **Standard kit** (`RESET_KIT`):
  `96 cobblestone, 16 oak_log, 96 stick, 48 oak_planks, 8 coal, 1 stone_pickaxe,
  1 stone_axe, 1 crafting_table`

  Composition rule: **one of each enabler, the observed campaign median of each
  consumable** (medians over 223 exploratory attempts — cobblestone 102→96,
  stick 111→96, oak_planks 44→48, oak_log 18→16).

  Enablers are *not* set to their observed medians. The median bot held **6
  stone pickaxes**, which is an artifact of the carry-over defect this reset
  exists to remove; reproducing it would bake the bug into the control. Coal is
  the one deliberate exception in the other direction: its observed median is 0,
  which would make the tier-4 smelting task turn on finding fuel rather than on
  smelting.
- The kit is identical for every arm and every attempt. Held stock cannot
  satisfy a criterion: every criterion is a **net gain measured from a
  per-attempt snapshot**, so "+16 cobblestone" still requires mining 16 with 96
  already in the bag.
- **Reset position is pinned once per experiment**, not per arm, persisted in
  `.runtime/reset_pos`, and recorded in each attempt's evidence file
  (`pos_start` / `pos_end`).
- **RCON is bound to localhost.** It is enabled on `pincercraft-ts` only, never
  YOON; the password lives in `.runtime/rcon.pass` (0600) and host firewall
  rules restrict port 25575 to `127.0.0.1`. Console powers stay with the
  *runner*: an LLM-driven bot holding op could `kill`, `ban` or `op` itself, and
  the Code of Conduct layer is not a security boundary.
- Carry-over of inventory, position or world state across attempts is a
  protocol violation unless persistence is explicitly the manipulated variable.

**Known residual:** block changes (mined stone, felled trees) are *not* reset.
Randomized arm order distributes this across arms rather than removing it. If a
future result turns on local resource depletion, world regeneration between
replicates becomes necessary.

## 2. Arms and ordering

- **Arm order is randomized per shuffled backtest**, from the backtest number
  via the same LCG + Fisher–Yates as task order, offset so arms and tasks do not
  correlate. `FIXED_ARM_ORDER=1` exists only to reproduce a pre-2026-08-09
  segment.
- **`arm_position` is recorded on every attempt** so the variable remains
  adjustable for in analysis.
- **Task order is shuffled per backtest**, so tier never correlates with world
  depletion.
- The backtest is the **outer** loop and the arm the inner one, so drift over a
  multi-day campaign hits all arms roughly equally.
- Every arm in a comparison runs **the same task set on the same commit**. Arms
  are never mixed across code versions; if a fix lands mid-campaign, every
  affected arm is re-run from scratch.

## 3. Fixed configuration

Held constant across all arms of a comparison unless it *is* the manipulated
variable, and recorded per attempt:

| setting | value |
|---|---|
| planner model | `claude-sonnet-4-6` |
| coder model | `claude-sonnet-4-6` |
| `max_tokens` | 2000 |
| `code_timeout_mins` | 5 |
| `num_examples` | 2 |
| benchmark set | `eval/benchmarks.json`, 13 tasks, tiers 1–4 |
| referee | `eval/referee.mjs`, never ablated |
| per-attempt budget | `WATCH_TIMEOUT=480 s` |

## 4. Stopping and budget rules — declared in advance

- **Per attempt:** 480 s, after which the attempt is recorded as
  `budget_exhaustion`.
- **Credit exhaustion:** the rig **parks immediately**. Not restart-recoverable,
  and it silently produced 10 zero-turn attempts once already.
- **Wedged agent:** after **two consecutive zero-step attempts** the runner
  restarts the bot and continues. A functioning bot cannot record zero steps, so
  this never fires on a real result.
- **Task never added** (`rc=43`) twice consecutively: park.
- No stopping rule keys on the *direction* of results. The campaign never stops
  early because a number looks good.

## 5. Endpoints

**Primary, A-ON vs A-OFF:** false-completion rate, with verified task success
secondary. Cluster bootstrap over tasks; Wilson intervals; zero-event arms
reported with a one-sided upper bound rather than as "eliminated".

**Primary, per-layer arms: the taxonomy category each layer targets** —

| arm | endpoint |
|---|---|
| grounded completion check (`verify`) | false completion |
| deterministic termination (`autofinish`) | reached-not-recognized |
| perception, precondition, reflex | verified success |

Overall success is the wrong endpoint for the first two: it dilutes each layer
across runs where its failure mode never arises. Measured on success, separating
verify from autofinish needs **n ≈ 372 per arm** (80% power, α=0.05); measured
on the targeted categories, far fewer.

## 6. Replicates

Sized from a power calculation on **the endpoint actually used**, computed and
recorded before the campaign starts, not after. For reference at 80% power,
α = 0.05, on verified success:

| comparison | n per arm |
|---|---|
| false completion, A-ON vs A-OFF | 16 |
| A-ON vs A-OFF (success) | 39 |
| A-ON vs verify-ablated (success) | 174 |
| verify vs autofinish (success) | 372 |
| A-ON vs autofinish-ablated (success) | 1,727 |

Clustering by task inflates all of these. A comparison whose required n is not
affordable is either re-specified onto a sharper endpoint or reported as a
bounded null — never run underpowered and read as a ranking.

## 7. Evidence handling

- Every attempt is one **atomic receipt**: one append-only `task_attempts` row
  plus its evidence file.
- **Raw receipts are immutable.** Discards are recorded in the `exclusions`
  table keyed on `attempt_id`, never by editing the attempt.
- Every taxonomy label, derived metric, aggregate and statistic is **recomputed
  downstream** from raw receipts.
- Every number in the paper must be traceable to the exact attempts producing
  it.
- Discards follow §8 of the pre-registration: declared infrastructure faults
  only, logged in [aborts.md](aborts.md) at the time, and reported as a rate.

## 8. Checklist before a confirmatory campaign

1. `RESET_STATE=1`, RCON reachable, kit and pinned position confirmed.
2. Arm order randomization on (`FIXED_ARM_ORDER` unset).
3. One commit for the whole comparison; hash recorded per attempt.
4. Power calculation done on the chosen endpoint and written into the
   pre-registration.
5. No human player on the eval server; nothing else running against the DB.
6. Health check active: credit → park; **two consecutive attempts with 0 steps
   *and* no completion claim** → restart. The claim clause is load-bearing, not
   a detail — see §8.1(c).
7. A validation smoke proving each manipulated flag reaches the agent child
   process, and each new receipt field actually persists. **A field is not in
   the receipt until a live run has been shown to write it** — three fields
   looked correct and wrote NULL on 2026-08-09.
8. **A `TAG=smoke` run of at least two arms, one of them ablated, completed and
   inspected** — rows landed, `arm_position` and `harness_*` populated, referee
   labelled, no spurious park or restart. Smoke rows are inert to the analysis
   by design, so this cannot contaminate a rate.
9. **The runner and analysis path read end to end since the last campaign**,
   per §8.1.

### 8.1 Read the rig before you run it

Owner directive, 2026-08-12, after three launches were burned in one morning
(53 attempts and ~2 h discarded) on two defects that were sitting in
`field_trial.sh`, readable, before the first launch. Auditing the runner is
cheaper than a restart, and far cheaper than a silently biased result.

- **(a) Read the whole runner, not the diff.** Both defects were in
  fault-detection code that had not been re-read since it was written.
- **(b) Distrust fixed windows and cross-session state.** `tail -n N` over an
  append-only log, hardcoded paths, anything whose meaning depends on a previous
  run. The credit check grepped `tail -n 800 bot.log` and matched a three-day-old
  outage, parking a healthy campaign after one attempt while the API returned 200
  (`2e4f243`).
- **(c) For every automatic intervention, ask: can this fire on a real result,
  and can it fire unevenly across arms?** Any runner action correlated with the
  endpoint is a confound. Treating 0 steps as a fault did both: an instant false
  completion (#725, `done` in 0.27 s, cobblestone 96→96) is a *result*, and one
  possible only where the grounded completion check is ablated — so the runner
  would have restarted the bot mid-arm in `off` and `verify` and never under
  A-ON (`7ea45ee`).
- **(d) Re-derive inherited premises against real data.** The pre-registration
  justified the health check as neutral measuring infrastructure on the grounds
  that "a bot able to act never records 0 steps". That was false, and it had
  been carried forward unexamined.
- **(e) Audit the analysis path too, not only collection.** The 2026-08-10
  endpoint defect — every arm scored on overall success instead of its
  pre-registered target category — was the same class of error.

The asymmetry that makes this worth doing: the log-window defect announced
itself loudly and cost time. The 0-step defect would have **run silently to
completion and biased the primary comparison.** Audit for the second kind.
