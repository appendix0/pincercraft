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
- **`RESET_STATE=1` is mandatory.** Before every attempt the runner clears the
  bot's inventory, issues the standard kit, and returns it to the pinned
  position, over RCON.
- **Standard kit** (`RESET_KIT`), chosen near the campaign-median observed stock
  so absolute difficulty stays interpretable against exploratory data:
  `128 cobblestone, 32 oak_log, 64 stick, 32 oak_planks, 8 coal, 1 stone_pickaxe,
  1 stone_axe, 1 crafting_table`.
- The kit is identical for every arm and every attempt. Held stock cannot
  satisfy a criterion: every criterion is a **net gain measured from a
  per-attempt snapshot**, so "+16 cobblestone" still requires mining 16.
- **Reset position is pinned once per experiment**, not per arm, and recorded.
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
6. Health check active (credit → park, two zero-step attempts → restart).
7. A validation smoke proving each manipulated flag reaches the agent child
   process, and each new receipt field actually persists. **A field is not in
   the receipt until a live run has been shown to write it** — three fields
   looked correct and wrote NULL on 2026-08-09.
