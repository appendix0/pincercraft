# Runbook

Operational companion to [preregistration.md](preregistration.md). Two audiences:
the owner (whose only task is labelling) and whoever resumes the campaign.

---

## Owner: how to do the ~40 blind labels

This is the only step that cannot be automated, because the whole claim is that
the scorer agrees with an *independent* human. You do not need to be in-game.

**1. Generate cards**

```bash
cd ~/pincercraft
python3 eval/evidence.py cards --out /tmp/cards.md
```

Each card shows the task, what the bot claimed, and the inventory before/after.
The scorer's verdict is deliberately withheld — that comparison is the
measurement, and it is worthless if you saw the machine's answer first.

**2. Judge each one**

Ask only: *was the task, as written, genuinely accomplished?*

- Judge the **task**, not the criterion. If the criterion is wrong but the bot
  did the job, that is a success — and worth a note. Attempt #322 was exactly
  this: an `end_factor` authored backwards. That case is the reason you get to
  see ground truth rather than guessing.
- The inventory delta is your evidence. "Claimed 16 torches, `torch 0 → 8`" is a
  failure, whatever the bot said.
- If a card says the baseline was taken *post-add*, early work may not appear in
  the delta. Weigh that before calling a short delta a failure.

**3. Record it**

```bash
python3 eval/agreement.py label <task_id> <0|1> [notes]
```

It refuses duplicates. Check progress any time:

```bash
python3 eval/evidence.py status      # confirmatory labels vs the n=40 target
python3 eval/agreement.py report     # the agreement table
```

Pilot labels (pre-2026-08-07) are counted separately and never pooled with the
confirmatory set — they helped develop the grammar they test.

---

## Running a campaign segment

**Before any run:** nobody on the eval server, and the owner not playing on YOON
(a joining player changes the bot's behaviour and pollutes `bot.log`).

```bash
cd ~/pincercraft

# smoke: two arms, one seed
ARMS=both SEEDS=1 bash eval/field_trial.sh

# the campaign
ARMS="on off perception gates reflexes measurement" SEEDS=3 \
  bash eval/field_trial.sh
```

Replicates are the outer loop, so arms interleave and drift hits all
arms equally. Task order is shuffled per replicate and echoed into the run log.

The runner points the bot at **pincercraft-ts :25566** via `.runtime/target.json`,
verifies the connection from the OS after spawn, and clears the file on exit so
the bot returns to YOON. It refuses to start if nothing is listening on the eval
port, and aborts rather than running a campaign in the owner's live world.

**Results:**

```bash
python3 eval/campaign_report.py
```

## If a run dies

1. Record it in [aborts.md](aborts.md) **at the time**, with which of the four
   §8 rules it falls under. Discard rate goes in the paper.
2. Only the four declared infrastructure faults justify a discard. "The result
   looked wrong" never does.
3. If a code change was needed, re-run **every affected arm from scratch** —
   arms are not mixed across commits.

**Known exit codes:** `42` = credit/usage limit, parks the rig immediately.
`43` twice in a row = task-giver could not add a task, parks the rig.

## Gotchas that have already bitten

- `bot.log` needs `grep -a`, and it accumulates — scope with `tail`.
- Mindcraft spawns each agent as a **child** process; anything inspecting the
  bot's sockets must walk the whole process tree, not `MainPID`.
- The bot needs Node v20 (`~/.nvm/versions/node/v20.20.2/bin/node`); the nvm
  default v24 crashes the agent.
- `daedelus404.service`'s `Description=` still says Haiku 4.5. Stale — the
  profile runs Sonnet 4.6 for both planner and coder.
