# Pre-registration — the say-do gap benchmark campaign

**Status:** frozen 2026-08-07, before any campaign run.
**Scope:** every number intended for the paper and the v2 HF dataset.
**Rule:** this file is written *before* the runs and is not edited to match results.
Anything that changes after the first campaign run goes in the Deviations log at the
bottom, with a date and a reason — never by rewriting the section above.

> **Terminology-only rename, 2026-08-15.** Two words were substituted throughout
> this document: *shuffled backtest* → **replicate**, and *referee* → **scorer**
> (terminology.md §1, §3). **No hypothesis, falsifier, threshold, endpoint,
> sample size, number or date was touched**, and the pre-commitment this file
> exists to record is unchanged. The substitution was mechanical and total; the
> original wording is recoverable from git history. Arm labels `A-ON`/`A-OFF`/
> `B1`–`B5` are **kept here as written** — they are the historical labels, and
> terminology.md §1.1 maps them to the manuscript's arm names.

> **Provenance of §3 and §4, 2026-08-15.** The Rule above says design sections
> are never rewritten. **They were.** §4 was amended in place more than once
> during the campaign — the benchmark set grew 10 → 13 tasks, C-BASE was
> dropped, and the layer list changed — each change logged as a deviation but
> also applied to the text. The result was a hybrid: some figures updated, some
> original, and no way for a reader to tell which. Two that were never updated
> (§3's task count and tiers, §4's seeds and total) had drifted into being
> simply false, and are corrected today.
>
> **The frozen document is the git object, not this file.** The pre-freeze text
> is one command away and cannot be edited after the fact:
>
> ```
> git show 437ea87:docs/paper/preregistration.md
> ```
>
> Treat that commit as the pre-commitment, this file as the design as run, and
> the Deviations log below as the complete bridge between them. Hypotheses,
> falsifiers, thresholds and endpoints — the things a pre-registration exists to
> bind — are unchanged in every version; what moved is scale and scope, and each
> move has a dated entry giving its reason and whether it was pre- or post-data.

---

## 1. The claim

Self-reported task success by an LLM agent is unreliable, and the size of that
unreliability is measurable. A deterministic harness that reads world state
instead of trusting the agent's account both *measures* the gap and *closes* it.

This is a measurement paper, not a capability paper. We are not claiming the
agent is good at Minecraft. We are claiming the instrument is trustworthy and
that what it reveals is large.

## 2. Hypotheses

Stated with direction, before data collection.

| | Hypothesis | Fails if |
|---|---|---|
| **H0** | *(gating)* The scorer agrees with blind human judgement at ≥ 90%, with the Wilson 95% lower bound above 75%. | Lower bound ≤ 75% — instrument not trustworthy, H1–H3 become uninterpretable and the paper reports the calibration failure instead. |
| **H1** | Honor-system labelling overstates success: on identical attempts, self-reported success exceeds scorer-verified success. | Gap ≤ 0, or its CI spans 0. |
| **H2** | Verified success is higher with the harness on than off. | ON ≤ OFF, or CI spans 0. |
| **H3** | The say-do gap is *smaller* with the harness on than off. | Gap(ON) ≥ Gap(OFF). |
| **H4** | At least one individual harness layer produces a detectable drop in verified success when removed alone. | No single-layer ablation differs from full-ON beyond noise. |

**H0 gates the rest.** If the instrument does not calibrate, we report that and
stop; we do not proceed to report H1–H4 as if measured.

## 3. Definitions

- **Attempt** — one benchmark task issued to the bot, run to a terminal state
  (finish, cancel, or timeout).
- **Verified success** — the deterministic scorer's verdict, computed from an
  inventory delta against the task's `end_factor` (`eval/referee.mjs`,
  `evaluateCriterion`). Never from bot text.
- **Claimed success** — the agent's own terminal report, i.e. what an
  honor-system pipeline would have recorded (`label_source = honor_system`).
- **Say-do gap** — `P(claimed success) − P(verified success)`, over the same
  attempts. Positive means the agent overstates.
- **Task** — one of the 13 rows of `eval/benchmarks.json`, tiers 1–4. *(Frozen
  as 10 rows, tiers 1–3; tier 4 was added 2026-08-08 — see the Deviations log.)*
- **Seed** — one full pass over the task set. Seeds are independent runs, not
  RNG seeds; world state is reset between them (§7).

## 4. Design

Fixed before data collection. **Four replicates per condition** — the frozen
design said three, matching Voyager's floor; the 2026-08-09 sizing entry raised
it to four so the campaign could detect the pre-declared 15-point minimum effect
of interest at 80% power.

| Code | Condition | Tasks × replicates | Attempts |
|---|---|---|---|
| **A-ON** | Full harness (as shipped) | 13 × 4 | 52 |
| **A-OFF** | `harness_off` — all layers ablated | 13 × 4 | 52 |
| **B1–B5** | One layer removed at a time: perception, gates, reflexes, verify, autofinish | 5 × 13 × 4 | 260 |
| | | **total** | **364** |

*Frozen as 10 tasks × 3 seeds over 7 arms plus a C-BASE arm, total 240. Every
change is in the Deviations log: C-BASE dropped and `measurement` split
(2026-08-08), tier 4 added (2026-08-08), sizing raised to 4 replicates
(2026-08-09). 356 of the 364 were collected — see results.md §1.*

**Five ablatable layers.** An earlier draft listed *scorer* as one. That was an
error: the scorer is the measuring instrument, not a component under test.
Removing it would delete the measurement rather than vary a condition. `LAYERS`
in `src/agent/harness_mode.js` excludes it and `test/harness_layers_offline.mjs`
asserts it stays excluded. Note the resulting split: the bot's *own* finish
verification is ablated, while the external scorer that scores the arm is not.

**No stock-Mindcraft baseline.** An earlier draft included a C-BASE arm (stock
upstream Mindcraft, 30 runs). Dropped: this fork has diverged far enough from
upstream — orchestrator, prompts, task queue, skill layer — that any A-ON minus
C-BASE difference would be unattributable to the harness, which is the only
thing this study is about. **A-OFF is the better control**: same model, same
prompts, same task queue, same tasks, harness removed. A comparison against
upstream would also require scoring upstream with *our* scorer, since its
validators cover only its own pre-specified benchmark tasks and cannot score
open-ended ones.

**`verify` and `autofinish` are separate layers.** Seeds 1–2 ran them as one
`measurement` layer, which produced the campaign's largest effect (−61.1 pp) but
bundled "block an unearned finish" with "close the task once the criterion is
met" — so the number was not attributable to either. They are now independently
ablatable. `harness_off_measurement` is retained as a compound flag so the
seeds-1–2 arm stays reproducible from current code.

**The scorer labels every arm, including A-OFF.** The instrument is external to
the system under test. In A-OFF and B4 the harness's *own* finish-verification is
disabled, but the scorer still computes the verdict out-of-band for scoring.
This distinction is load-bearing and must survive into the code: ablating the
harness must not ablate the scorer.

**Primary endpoint:** verified success rate, A-ON vs A-OFF.
**Co-primary:** say-do gap, A-ON vs A-OFF.
**Secondary:** per-layer ablation (B1–B5); failure-mode distribution; token and
wall-clock cost per verified success.

### Excluded from the primary analysis, by prior commitment

The 5×5 cobblestone platform task is deliberately not inventory-shaped and
falls back to `honor_system` — there is no block-scan scorer yet. It is
**excluded from every scorer-labeled aggregate** and reported separately as a
worked example of what an unverifiable criterion looks like. Primary analysis is
therefore **12 tasks × 3 seeds = 36 attempts per arm**. This exclusion is
declared now, not chosen after seeing results, and is applied by task identity —
never by whether a given row happened to fall back to `honor_system`, which
would condition the exclusion on the outcome.

## 5. The instrument, and how it is calibrated

The scorer is deterministic code: snapshot inventory, run the task, diff, compare
the delta against a `+N <item>` criterion. It has no model in the loop and cannot
report on its own compliance.

**Calibration protocol (H0):**

- Target **n = 40** blind human labels, drawn across all arms and all three tiers.
- The labeler sees an evidence card: the task text, the bot's chat transcript, and
  the ground-truth inventory before and after.
- The labeler **does not see the scorer's verdict.** This is what makes the
  exercise calibration rather than confirmation.
- Showing ground truth to the human is intentional and is *not* circular: the
  scorer applies one specific rule to that state, while the human sees the whole
  picture and can catch cases the rule mis-encodes. The single historical
  disagreement (#322) was exactly that — an LLM-authored criterion written
  backwards — and a protocol that hid ground truth from the human would have
  missed it.
- Labels are recorded with `eval/agreement.py label`, which refuses duplicates.
- Reported as raw agreement, Cohen's κ, and a Wilson 95% interval.

**Pilot, already banked (n = 12, 11/12 = 92%):** these rows were collected before
this pre-registration under a less formal protocol and were used to *develop* the
grammar they test. They are reported as a pilot and are **not pooled** with the
n = 40 confirmatory set.

## 6. Randomization and ordering

- Task order within a seed is **randomized**, seeded by run index, and the order
  is recorded. Fixed ordering would confound tier with world depletion.
- Arms are interleaved by seed (seed 1 of every arm, then seed 2, …) so that any
  drift in server or model behaviour hits all arms roughly equally rather than
  landing entirely on whichever arm ran last.

## 7. Environment control

Field Trial v1 ran against YOON (`settings.js` port 25565), the owner's live
world, despite `field_trial.sh` claiming otherwise in its header. For a 240-run
campaign this is a confound: felled trees and mined stone near spawn make later
runs face a measurably poorer world.

**Commitments:**
- The campaign runs against `pincercraft-ts`, a dedicated eval world, via an
  explicit target override. Casual play on YOON is unaffected.
- The bot is returned to a known position and its inventory cleared between
  attempts; each seed starts from a recorded world state.
- No human player is on the eval server during a batch.

## 8. Abort and exclusion rules

Field Trial v1 aborted five runs (`bench_on_aborted_r2` … `r6`) before a clean
run 7. That is legitimate debugging of a pipeline, but as a practice it can
silently select for good outcomes. Constrained from here:

**An attempt or run may be discarded only for a declared infrastructure fault:**

1. Bot never spawned, or MCP unreachable within the timeout.
2. Minecraft server crash, restart, or network loss mid-run.
3. Harness/runner crash, or a code change landing mid-run.
4. A human player joining the eval server mid-run.

**Never grounds for discarding:** the agent failed the task; the result looked
wrong; the arm underperformed; the run contradicted the pilot.

Every abort is appended to `docs/paper/aborts.md` with timestamp, run tag, cause,
and which of rules 1–4 it fell under — written **at the time of the abort**, not
reconstructed later. Aborted attempts keep their `task_set` tag (`*_aborted_*`)
and are excluded from analysis but reported as a count, so the discard rate is
visible in the paper.

If a bug is found mid-campaign, the fix is applied and **every affected arm is
re-run from scratch.** Arms are not mixed across code versions; the commit hash
is recorded per attempt.

## 9. Stopping rules

- Data collection stops at the pre-declared 240 attempts. No peeking-and-extending
  to reach significance.
- If H0 fails at n = 40, collection stops and the paper reports the calibration
  failure.
- If an arm cannot complete after three infrastructure-fault re-runs, it is
  reported as incomplete with the reason, not silently dropped.

## 10. Analysis plan

Written before the data exists.

- **Proportions** reported with Wilson 95% intervals throughout.
- **A-ON vs A-OFF**: paired by task across arms; cluster bootstrap over tasks
  (10,000 resamples, task as the resampling unit) for the difference in verified
  success. Task is the unit because the 3 seeds within a task are not independent.
- **Say-do gap**: McNemar's exact test on claimed-vs-verified within the same
  attempts, per arm.
- **Per-layer ablation**: each of B1–B4 against A-ON, same cluster bootstrap,
  **Holm–Bonferroni correction across the four comparisons.** Reported as
  exploratory regardless — 4 arms × 3 seeds is underpowered for small effects,
  and we say so rather than reading noise as structure.
- **Calibration**: raw agreement, Cohen's κ, Wilson interval.
- No result is described as "significant" without the interval printed next to it.

## 11. Known risk, stated in advance

The pilot result is **9/9 vs 1/9** at a single seed. Single-seed results of that
shape regress. A confirmatory outcome of, say, 7/9 vs 3/9 would be a weaker but
still substantial effect, and **it will be reported as the headline** if that is
what comes out. Pre-committing to this is the point of the document; the pilot
number is not a target to reproduce.

Equally: if A-OFF turns out to perform comparably, that is a publishable negative
result about the harness and will be written as one.

## 12. What is already banked

For transparency, existing rows in `pincercraft_evals.db` at freeze time:

| task_set | label_source | n | successes |
|---|---|---|---|
| bench_on | scorer | 9 | 9 |
| bench_off | scorer | 9 | 1 |
| bench_on/off | honor_system | 2 | 2 |
| bench | scorer / honor | 4 / 2 | 4 / 1 |
| bench_on_aborted_r2…r6 | scorer / honor | 10 / 1 | 5 / 0 |
| play, explore, live | mixed | 35 | 23 |

These are **pilot data**. They motivated the hypotheses and are reported as such.
The confirmatory claims rest only on the attempts collected after this freeze.

---

## Deviations log

*Append-only. Date, what changed, why. Empty at freeze.*

| Date | Deviation | Reason |
|---|---|---|
| 2026-08-07 | §4: ablation arms cut from five (B1–B5) to four (B1–B4); total runs 240 → 210. The dropped arm was *scorer*. | Error in the original draft. The scorer is the measuring instrument, not a component under test — ablating it removes the measurement instead of varying a condition, contradicting §4's own rule that ablating the harness must not ablate the scorer. Found while implementing the flag split (`92a37f8`). **Pre-data:** no campaign run had happened, so no result influenced this. |
| 2026-08-08 | §4: `measurement` split into two independently ablatable layers, `verify` and `autofinish`. B arms 4 → 5. | The layer produced the campaign's largest effect (−61.1 pp) but bundled blocking an unearned finish with closing a met task, so the drop was not attributable to either. **Post-data, and declared as such:** seeds 1–2 are already collected and are reported unchanged under the compound layer. `harness_off_measurement` is retained as a compound flag so those runs remain reproducible from current code, and `campaign_report.py` drops the compound from the Holm family whenever both halves are present, to avoid correcting across a redundant hypothesis. |
| 2026-08-08 | §4: C-BASE (stock upstream Mindcraft, 30 runs) removed. | Two reasons, neither outcome-dependent. (1) This fork has diverged from upstream across the orchestrator, prompts, task queue and skill layer, so an A-ON − C-BASE difference would not be attributable to the harness. A-OFF is a strictly better control: same everything, harness removed. (2) Upstream's validators (`src/agent/tasks/tasks.js`) cover only its own pre-specified benchmark tasks and cannot score open-ended ones, so C-BASE would have to be scored by our scorer anyway. **The arm was never run**, so no data was discarded. |
| 2026-08-08 | §4: benchmark set 10 tasks → 13; tier 4 added (iron pickaxe, 64 cobblestone, 5 iron ingots). Primary set 9 × seeds → 12 × seeds. | Ceiling effect, measured not suspected: A-ON scored 3/3 on eight of the nine primary tasks in seeds 1–2. An endpoint with no headroom cannot detect improvement, which is the leading explanation for the flat H2. **Post-data.** Seeds 1–2 are reported on the 9-task primary set they were collected on and are not retro-fitted; any tier-4 result is a separate, later comparison. |
| 2026-08-08 | §5: calibration set restated as n=40 confirmatory blind labels, with the existing pilot labels explicitly non-pooling. | No change of substance — §5 always said this. Recorded because the ablation campaign added 120 scorer-labeled rows and zero human ones, leaving the middle tier ~13× the comparable apex and every campaign figure formally uncertified until the pass completes. Stated in the README so the gap is visible to a reader, not only to us. |
| 2026-08-08 | Reporting precision: the calibration apex is quoted as **12 scorer-comparable labels (11/12)**, not as the 23 rows in `gold_attempts`. | `gold_attempts` mixes two row types: 16 blind agreement labels tagged `agree:task_id=N` (written by `agreement.py label`) and 7 curated examples (written by `gold_add.py`) that calibrate nothing. Of the 16, only 12 have a scorer verdict to compare against; the other 4 are honor-system comparisons reported separately at 0/4. Quoting "23" beside "11/12" implied 11 missing rows. No number changed — 11/12 was always the figure — but the denominator is now stated where it is used. |
| 2026-08-08 | Bug fix to the `gates` layer (`82110cb`), changing what that arm measures. Seeds 1–2 gates data are superseded, not pooled with seed 3. | Two defects found by the pre-seed-3 validation smoke, before any seed-3 data existed. (1) The redundant-acquire guard fired on `+N NEW <tool>` tasks whenever the bot already held that tool, so "craft 1 NEW stone pickaxe" was unsatisfiable under the full harness while succeeding with gates ablated (1/5 vs 5/5). Inventory persists across runs, so the contamination *grew with campaign length* — a time-dependent bias, not a constant one — and had already reached the tier-4 iron pickaxe. (2) Three gate sites (`!newAction` missing-tool, `!newAction` redundant-fetch, `!takeFromChest`) carried no `layerOn('gates')` check, so real gates ran inside the "gates off" arm, biasing the measured gates effect toward zero. **Post-data for seeds 1–2, pre-data for seed 3.** The seeds 1–2 `gates` arm measured the buggy layer and is reported as such; it is not merged with seed 3. Both defects inflated A-OFF-vs-A-ON in the *conservative* direction for the gates comparison — the ablated arm was helped — so no reported effect was overstated by them. |
| 2026-08-08 | §7's "the bot is returned to a known position and its inventory cleared between attempts" is **not implemented** and was not implemented for replicates 1–2. Replicate 3 runs the same way, deliberately. | Found while validating the rig before replicate 3: neither `field_trial.sh` nor `loop.sh` contains any inventory or position reset, and the bot had accumulated 10 stone pickaxes over the campaign. Disclosed as a limitation rather than fixed, because fixing it now would leave two replicates under carry-over and one under clean-slate, which is worse for the pooled primary endpoint than three consistent replicates. **Scope of the confound is limited by design:** every criterion is a net-gain delta measured from a per-attempt snapshot, so held stock cannot satisfy a criterion — "+16 cobblestone this run" still requires mining 16 with 200 in the bag. The residual effect is on *difficulty* (tools already in hand speed later runs), and since arms interleave within a replicate it applies to all arms alike. It is nonetheless a real departure and a required fix before any future campaign; it is also what let the gates defect above grow undetected. |
| 2026-08-08 | Runner gains a per-task health check (`65f4987`); the `bench_on` seed-3 arm is re-run under it while the other six seed-3 arms ran without it. | Two arms were lost to faults the runner could not see, each poisoning every remaining attempt in its arm because the bot is only restarted between arms — see `aborts.md`. The check parks on API credit exhaustion and restarts the bot after two consecutive zero-step attempts. **It cannot alter the behaviour of a functioning bot:** a bot able to act never records 0 steps, so the branch is unreachable on any real result. That places it with the scorer as measuring infrastructure rather than a condition under test, which is why the re-run arm remains comparable to the six collected before it. The re-run is required regardless: A-ON is the reference arm every per-layer drop is measured against, and the wedged version of it is unusable. |
| 2026-08-08 | The `gates` anomaly is **resolved as a confound, not a layer effect**. Arm position within a replicate is reported as a limitation on the whole per-layer table. | The `gates` arm scored 30/30 with a −13.3 pp "drop" across all three replicates, surviving the redundant-acquire fix (`82110cb`). Cause: §6 interleaves arms *across* replicates but fixes their order *within* one (`on off perception gates reflexes verify autofinish`), and §7's inventory reset was never implemented — so arm position is perfectly confounded with arm identity. `gates` always ran 4th, after three mining-heavy arms, and inherited the richest stock every time (640 items / 245 cobblestone in replicate 3, highest of any arm). Starting cobblestone predicts success: **69% / 78% / 78% / 89%** by quartile, n=180. Ruled out a second gate defect first: craft preflight fired **zero** times campaign-wide, and neither post-fix A-ON failure shows a gate block. **Controlled test (`ctrl_*`, `RESET_STATE=1`, identical kit and position before every attempt): A-ON 9/12 vs gates-ablated 9/12 — a drop of +0.0 pp, Fisher p=1.000**, against −13.3 pp uncontrolled. Per task the two arms differ on 6 of 12, three each way — noise, not signal. **Consequence for the paper: the per-layer ablation table is position-confounded and must not be read as a ranking.** The primary A-ON vs A-OFF endpoint is less exposed (A-ON ran *first*, on the leanest stock, in replicates 1–2, and started replicate 3 with stock comparable to A-OFF: 451 vs 453 items) but is being re-validated under `RESET_STATE=1`. |
| 2026-08-09 | Block-scan scorer coverage now exists for structure criteria (`59308ba`, `e06b3c7`). The §4 exclusion of the 5×5 platform task is **retained for the exploratory data and lifted for confirmatory runs**. | §4 excluded the platform task because its criterion is not inventory-shaped, so no scorer verdict was possible; §5 recorded that the owner abstained on all three blind platform cards, human confirmation that inventory evidence alone could not settle it. `eval/blockscan.py` reads the server's blocks over RCON (`execute if block`, chunks force-loaded for the scan), independent of the bot's world model. Validated against ground truth placed over RCON: complete 5×5 at centre 25/25 pass, at a corner 25/25 pass (position tolerance), one block removed 24/25 fail, six blocks away 0/25 fail. **The exclusion is not retro-lifted:** the platform attempts already collected were scored by the honor system and re-scoring them now would mix two instruments within one dataset. `exclude_from_primary` therefore stays set in `benchmarks.json` until the confirmatory campaign re-runs the whole set under the new scorer. **First machine-scored platform attempt (#663/#664) was a false completion** — the bot claimed done, the scan measured 21/25 blocks — so the excluded task was concealing exactly the phenomenon the campaign measures, and its exclusion was conservative rather than neutral. |
| 2026-08-09 | Confirmatory per-layer campaign sized in advance: **minimum effect of interest = 15 percentage points**, 4 replicates, **52 attempts per arm**, 7 arms, 364 runs. | Required by protocol.md §8 before any confirmatory run. Endpoints are the taxonomy category each layer targets, not overall success (separating verify from autofinish on success needs n≈372/arm). Against a 0% A-ON baseline, detecting a rise in false completion at 80% power / α=0.05 needs n≈16 if the ablated rate is 33%, n≈45 at 15%, n≈90 at 8.3%, n≈159 at 5%. The exploratory data hints at 1/12 (8.3%) for verify-ablation, but that is 12 attempts collected under the arm-position confound and is not an estimate. **We therefore pre-declare a minimum effect of interest rather than powering for a guessed rate:** if ablating a layer does not raise its target failure mode by at least 15 points, that layer is not the dominant mechanism and the result is reported as a bounded null, not chased with more n. 15 points is half of A-OFF's total 33-point false-completion effect — a layer contributing less than half of the whole harness effect does not merit the word "dominant". 52 attempts/arm (4 replicates × 13 tasks) gives 80% power at that threshold with margin. |
| 2026-08-10 | **The per-layer analysis was scoring every arm on overall verified success, not on the taxonomy category each layer targets.** Corrected: `verify` → false completion, `autofinish` → reached-not-recognized, and the three capability layers (`perception`, `gates`, `reflexes`) → capability failure. The mapping is explicit in `eval/analysis_rules.py` and the endpoint is printed beside every number. | The 2026-08-09 sizing entry declares the target category as the endpoint precisely because separating the layers on success needs n≈372/arm against the 52/arm planned. The code did the opposite, so the confirmatory per-layer campaign would have been analysed on an unregistered endpoint at a sample size chosen for a different quantity. Found before the campaign resumed; no confirmatory data had been analysed. The three capability layers had no separately declared category — `capability_failure` is the one they can move, and is now written down rather than left implicit. |
| 2026-08-10 | The pre-declared 15-point minimum effect of interest is now **applied in code** as a verdict per layer (`dominant mechanism` / `bounded null` / `inconclusive`), instead of being stated in the protocol and left for a reader to apply by eye. | A decision rule that only exists in prose is a decision rule that gets applied after seeing the numbers. |
| 2026-08-10 | Bootstrap p-values now carry the `(r+1)/(B+1)` correction and print as `<0.0001` at the resolution the resample count supports, rather than `p=0.0000`. | No resampling procedure can produce a p of exactly zero; the printed value claimed a precision the method does not have. |
| 2026-08-12 | The per-task health check now fires on **0 steps *and* no completion claim**, not on 0 steps alone (`last_attempt_dead`). This **corrects the 2026-08-08 entry below**, whose stated justification — "a bot able to act never records 0 steps, so the branch is unreachable on any real result" — is false. | Attempt #725 (`conf_off`) reported `outcome=done` 0.27 s after its task was queued, with cobblestone 96 → 96, and the scorer scored it `false_done_referee`. A bot *can* record 0 steps on a real result, by claiming completion without acting — which is the phenomenon this campaign measures. The old rule therefore made the runner intervene **in response to the endpoint**: an instant false completion is possible only where the grounded completion check is ablated (`off`, `verify`) and impossible under A-ON, so two in a row would restart the bot mid-arm in exactly the arms whose false-completion rate is being measured, and never in the reference arm. The agent's claim is the clean discriminator — a bot that genuinely cannot act is cancelled or times out and never claims done — and it is already recorded as the first of the three signals (terminology.md §4). Verified against all three historical classes: #725 `done` (result), #525/#526 execution-lock wedge `cancelled` (fault), #490 credit exhaustion `timeout` (fault). Wedge detection is unweakened; a 0-step false completion now also correctly clears the consecutive-fault count, since claiming proves the bot is alive. **Found 20 attempts into the confirmatory campaign; those 20 are discarded and collection restarted, per §8's rule that arms are not mixed across code versions.** |
| 2026-08-12 | On resume, the 33-attempt interrupted segment of confirmatory replicate 1 is **discarded in full and replicate 1 re-run from scratch**, reversing the 2026-08-09 plan to keep `conf_gates` and `conf_off` and re-run only the partial `conf_on`. | Declared **before any resume run and before re-analysing the segment**; the decision turns on two facts about the rig, not on the numbers. (1) `field_trial.sh` numbers `ARM_POSITION` from 1 per invocation, but the 5 outstanding arms genuinely occupy positions 3–7 of replicate 1's randomized order. Resuming would have written a false value into the covariate introduced specifically to control arm position — avoidable only by editing the frozen runner mid-campaign (itself a deviation, and §8 forbids mixing arms across code versions) or by hand-patching receipt rows. (2) Keeping the two finished arms would give `gates` and `off` a 13/52 share of pre-pause data across a 3-day gap while the other five arms sat wholly post-pause. `gates` carries the campaign's one unresolved anomaly, so it is the arm that can least afford a confound unique to it. Cost is 26 valid attempts, ≈1.4 h of a ≈15.6 h campaign — cheap against either alternative. Rows are retained and marked in `exclusions`; nothing is deleted. |
| 2026-08-10 | When neither arm produced any event on an endpoint, the cluster bootstrap returns a degenerate `[0,0]` interval. The report now detects this and substitutes the exact one-sided bound from the ablated arm's n. | Zero events in n bounds a rate; it does not pin it to zero. The degenerate interval would have certified `autofinish` as a bounded null on 0/11 attempts, where the true one-sided bound is 23.8% — wider than the 15-point minimum effect of interest, hence inconclusive. This is the arm whose endpoint reached-not-recognized *is*, so the artefact struck exactly where it mattered. |
| 2026-08-14 | Confirmatory **replicate 2 is re-run whole** (all 7 arms, 91 attempts), rather than reporting `gates` at 39/52 or re-running `gates` alone. Owner decision. | Replicate 2's arm order is `verify on off perception reflexes autofinish gates` — `gates` ran **7th**, which is why API credit exhaustion truncated exactly that arm at 6 of 13 tasks. Re-running `gates` alone was rejected for the same reason the 2026-08-12 resume was: `field_trial.sh` numbers `ARM_POSITION` from 1 per invocation, so a solo re-run would stamp position 1 on an arm that genuinely occupies position 7 — writing a false value into the covariate introduced specifically to control arm position, on the one arm carrying the campaign's unresolved anomaly. Reporting unequal n was rejected because `gates` is the arm least able to afford reduced power. The re-run is a **true replicate**: both deterministic shuffles were verified to reproduce replicate 2 exactly — arm order as above and task order `3 7 12 0 5 8 1 11 4 10 9 6 2` — so the design, not a new draw, is repeated. Collection code is unchanged at `7ea45ee`; no repo commit is merged while it runs, so all attempts carry one commit hash as §8 requires. **Declared before the re-run and before any confirmatory number was computed.** |
| 2026-08-14 | **Pre-declared disposition of the superseded replicate-2 rows**, fixed before the re-run's outcome is known: if the re-run completes all 7 arms, the 77 original replicate-2 attempts are marked in `exclusions` as superseded (retained, not deleted) and the re-run stands. If the re-run is cut short for any reason, **the re-run rows are discarded instead** and the original replicate 2 stands as collected, at `gates` 0/13. | Both branches are written down in advance so the choice cannot be made after seeing which dataset is more favourable. Only one of the two replicate-2 datasets ever enters the analysis; they are never pooled, and no attempt is deleted under either branch. |
| 2026-08-14 | The §4 exclusion of the 5×5 platform task is **lifted for confirmatory data**, making the confirmatory primary set **13 tasks/arm rather than 12**. It is **retained for the exploratory `bench_*` data**. Implemented as `excluded_task_name(dataset)`. | This executes the conditional written into the 2026-08-09 entry — "`exclude_from_primary` stays set in `benchmarks.json` until the confirmatory campaign re-runs the whole set under the new scorer" — whose condition is now met: the campaign re-ran the whole set, and **all 27 confirmatory platform attempts carry `label_source=referee`**, verified in the ledger, so lifting admits scorer-labeled data and no honor-system rows. The exclusion stays in force for the exploratory replicates, whose platform attempts *were* honor-system scored; a single global rule would have silently restated pilot numbers already reported, which is what the 2026-08-09 entry forbade when it refused to retro-lift. The flag stays set in `benchmarks.json` — it still records which task is exclusion-eligible and why — and the dataset decides whether it applies. Note this admits the phenomenon under study rather than a neutral task: the first machine-scored platform attempt was a false completion (claimed done, 21/25 blocks), so the exclusion had been concealing the campaign's endpoint and was conservative rather than neutral. **Declared before any confirmatory number was computed.** |
| 2026-08-15 | The reported **discard rate counts infrastructure faults only**. Supersessions — valid attempts replaced wholesale by a declared re-run — are reported on a separate line and never folded into it. `terminology.md` §6 now defines the two dispositions separately. Confirmatory: **63 faults (15.0%)** and 77 superseded, against the 28.2% a combined count produced. | **Post-data reporting correction, declared as such.** Both dispositions were being written to the same `exclusions` table for receipt-immutability reasons — the raw row is never mutated — and the report billed every row in it as a §8 infrastructure fault. That is a vocabulary hole before it is a bug: §6 defined `discard` as "removed for a declared infrastructure fault", a definition the 77 rows created by the 2026-08-14 whole-arm re-run do not satisfy. The combined figure overstated our own rig's failure rate by ~13 points, which is a claim *against* the instrument and not a favourable one, so the correction moves the paper's self-report in the direction that flatters us — noted here explicitly for that reason. No attempt's disposition changed; only how the two kinds are counted and named. Affects no endpoint, no interval and no hypothesis: discarded rows were already outside the primary set under both readings. |
| 2026-08-15 | **Pre-declaration of a follow-up experiment: the stock-stripped ablated arm.** Not a change to this pre-registration — a new, separately-tagged dataset, declared here before any row exists so the prediction cannot be written after the result. **Design:** the 6 benchmark tasks whose target item the reset kit already supplies at ≥ N (#0, #1, #3, #4, #7, #11), run under `harness_off` for 4 replicates = **24 attempts**, tagged `stockstrip_off`. Each task runs with a kit that drops **only that task's target item** and keeps every enabler, so the work required is unchanged and the sole variable is whether the goal was already satisfied in stock. One kit per task rather than one stripped kit for all six, because stripping all six removes the pickaxe and the axe and would change difficulty — the confound this experiment exists to remove. **Comparison:** the existing `conf_off` stock-satisfied cell, 18/24 = 75% false completion (results.md §8.1). Never pooled with `conf_*`; `campaign_report.py` selects `conf_%` and cannot see these rows. **Prediction, stated blind:** false completion falls toward the ~17% observed on the empty-start tasks. **Decision rule, fixed in advance:** ≤ 33% → the mechanism is confirmed and §8.1's causal language stands; 34–49% → inconclusive, and §8.1's prose is softened to an association; **≥ 50% → the mechanism claim is wrong, and §8.1 is rewritten as a pattern rather than a cause.** | The §8.1 data supports an association measured *within* one arm — false completions concentrate where the goal was already satisfied in stock — while its prose ("the unharnessed agent treated the bag as the answer") asserts a cause. The matched test is causal for the *harness*, not for the *stock*. This experiment supplies the missing manipulation, and the exploratory campaign already contains the prediction: it ran before `RESET_STATE=1`, so stock varied naturally, and `bench_off` shows 10/24 (42%) with stock ≥ N against 0/6 with an empty bag (Fisher p = 0.074) — right direction, large, underpowered at six attempts. Sizing against the existing 18/24: a return of 17% gives p = 0.0001, 25% p = 0.0012, 33% p = 0.0084, 42% p = 0.039, 50% p = 0.14. 24 attempts therefore resolve everything down to ~40%. **Environment held constant, verified not assumed:** the collection path was diffed against the campaign commit `7ea45ee` with comments stripped — `rcon.py` and `eval_db.py` identical, `field_trial.sh` and `loop.sh` differing only in `say` log lines and one JavaScript comment, `benchmarks.json` differing only in a `note` field, and every difference in the analyzer prompt is unreachable because campaigns set `RUN_ANALYZER=0`. No collection code is edited: `TASKS`, `RESET_KIT`, `ARMS` and `TAG` are already environment variables of the frozen runner. **The position-reset defect (entry below) is deliberately NOT fixed first.** Repairing it would start every attempt of the new arm at a pinned position while `conf_off` never did, introducing a fresh difference between the two arms being compared; leaving it is what keeps them comparable. **One difference does remain, disclosed here rather than found later:** the kit must vary per task, and `RESET_KIT` is read once per runner invocation, so this arm runs one invocation per task and the bot restarts before **every** attempt — where `conf_off` restarted once per arm and accumulated conversation history across ~13 tasks. Measured rather than assumed: within `conf_off`'s stock-satisfied attempts, false completion by position in the arm is 4/6 = 67% (tasks 1–4), 8/11 = 73% (5–9), 6/7 = 86% (10–13). A freshly restarted bot therefore still false-completes at ~67%, close to the 75% pooled figure and far above the ≤33% confirmation threshold, so the cadence difference cannot manufacture a confirmation. It is a mild trend in the conservative direction and `stock_strip_report.py` prints the fresh-bot-matched cell (4/6) beside the pooled one as a sensitivity check. The alternative — running the six tasks back-to-back on one bot — was rejected because consecutive identical task descriptions collide with the queue's 15-second anti-thrash rule (`task_queue.js`), which is a live rig defect rather than a documented one. **Two consequences of the one-invocation-per-task structure, recorded so neither is later mistaken for signal:** (1) `arm_position` is **1 on every row** of this arm, because the runner numbers it from 1 per invocation and each invocation carries a single arm — against `conf_off`'s 2, 3, 6, 7. The covariate is meaningless here and must not be adjusted for or compared; this experiment has one arm and makes no arm-order claim. (2) `seed` indexes the four replicates as usual, but each replicate is a single attempt rather than a pass over the task set. | 
| 2026-08-15 | **§3 and §4 corrected, and the freeze relocated to git.** §3 said 10 tasks at tiers 1–3 (actual: 13, tiers 1–4) and §4 said three seeds for a 273-run total (actual: four replicates, 52/arm, 364). Both now state what ran, each with a parenthetical giving the frozen figure. A provenance note at the head of this file names `437ea87` as the pre-freeze object. **No hypothesis, falsifier, threshold, endpoint or minimum effect of interest is touched.** | **Post-data, and a departure from this file's own Rule** — recorded as such rather than done quietly. The Rule ("never by rewriting the section above") had already been broken during the campaign: §4's task count, arm list and total were each amended in place alongside their deviation entries, leaving a hybrid where some figures were current and some frozen and nothing marked which. That is worse than either pure form, because a reader cannot audit it. Two remaining figures had drifted into being false, and §3 contradicted the §4 table three lines below it. Of the three ways out — revert §3/§4 to `437ea87`, finish updating them, or annotate the hybrid — reverting was rejected because the restored text describes a C-BASE arm that never ran and a 240-run design, so every reader would reconstruct the real design from 23 log rows and the document would mislead in a new direction. **The stronger integrity artifact is the git object, which is timestamped and cannot be edited after the fact, so the freeze is relocated there explicitly instead of being claimed by a file that no longer honours it.** Found in a doc-vs-data audit that checked every regenerable figure in results.md; that audit reproduced §2, §3, §4, §5, §7, §8, §8.1, §9 and §10 exactly, so this entry is about document integrity and not about any reported number. |
| 2026-08-15 | **§7's position reset never took effect for the confirmatory campaign.** `RESET_STATE=1` reset inventory as specified but its teleport was silently rejected, so every attempt began where the previous one ended. Arm-position control rests entirely on the per-replicate randomization of arm order (§6). `results.md` §1, which asserted the teleport worked, is corrected; a position-matched robustness table is added at §10. | **Post-data, discovered after all collection was complete.** Measured, not inferred: over 486 consecutive attempt pairs the start position sits a median of **0.0 blocks** from the previous attempt's end (94% within 3 blocks) and **1128.9 blocks** from the pinned reset point (0% within 3 blocks). Root cause is a defect class, not a typo: `eval/rcon.py` returns each command's response body and never inspects it, and Minecraft answers a rejected command with an error *string* over a normal RCON response rather than a protocol error — so `reset_state`'s `\|\| die` catches auth and connection failure and cannot catch a refused `tp`. A teleport the server declines is indistinguishable from one that worked, which is why the 2026-08-08 entry's fix was believed complete when only its inventory half was. **This is the same confound the 2026-08-08 `gates` entry resolved**, and the defence is unchanged from what that entry actually relied on: §6 randomizes arm order per replicate, so arm position is no longer perfectly confounded with arm identity as it was in the exploratory campaign. Two independent checks support that the primary endpoints are unaffected. (1) The `gates` anomaly did not reproduce (63.5% vs the full harness's 67.3%), and it was the pure product of the old fixed-order confound. (2) Restricting to replicates 1 and 3, where every arm ran in the same region of the world, the §8.1 stock-satisfied contrast is **12/12 vs 0/12, p < 0.0001**, against 18/24 vs 1/24 over all four. No number in this document changes; what changes is which mechanism is credited with controlling position. **`rcon.py` must check command responses before the next campaign** — not during this one, since §8 forbids mixing arms across code versions. |
