# DRAFT — Reddit posts (two subreddit variants)

**Ring 3. Human sends**, same week as Show HN, after rings 1–2 are out.
One subreddit per day, not both at once. Follow each subreddit's self-promo
rules (both allow "I made this" posts with substance; read the sidebar the
day you post).

Pre-send checklist:
- [ ] Rings 1–2 posted (upstream issue + Discord); links live
- [ ] Numbers filled — `grep ⟦` returns nothing
- [ ] Demo GIF uploaded to the post (Reddit native video/GIF beats links)
- [ ] Reply drafts ready for the obvious questions (see bottom)

---

## Variant A — r/LocalLLaMA

**Title:** Our Minecraft agent claimed "task done" on 100% of attempts — world-state checks confirmed 11%. Traces + dataset included.

**Body:**

We run a fork of Mindcraft (LLM Minecraft bot). For months it *felt* unreliable, so we stopped trusting vibes and measured the say-do gap: every task attempt snapshots inventory before, re-measures after, and a deterministic referee labels success from the delta. The model's own "done!" doesn't count.

Result across 9 referee-labeled benchmark attempts with the harness ablated: claimed 100%, verified 11% — an 89-point gap. (The same 9 tasks with the harness on: claimed 9/9, verified 9/9.) Funniest single row: told to gather 32 cobblestone while already holding 37, it declared done in 5 seconds without moving. An LLM grader passed it. The delta check didn't (gained 0, needed 32).

The fix wasn't a better model — it was a harness, built the way coding agents are built: code owns the facts (inventory, reachability, recipe gaps, completion), the LLM only plans. Deterministic reflexes catch the reflex-shaped failures (searching for mobs that can't spawn on peaceful, non-converging tasks burning tokens), and an event-driven loop replaces re-prompt-on-every-chat-line.

The harness pattern is model-agnostic — swap the brain, keep the referee. And the problem isn't Minecraft-shaped either: open-world, long-horizon tasks are where agent stacks fall apart in general — Minecraft just makes the failures cheap to measure. The same say-do gap waits for agents acting in the real, physical world.

- Dataset (episode traces + referee verdicts + human gold labels): https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap
- Worked before/after on one task: https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-12-search-miss-before-after.md
- Repo (MIT): https://github.com/appendix0/pincercraft

Happy to answer anything about the referee design or where the LLM still fails with the harness on.

## Variant B — r/programming

**Title:** We caught our Minecraft AI lying about finishing tasks, so we built it a referee that measures the world instead

**Body:**

⟦2–3 sentence version of the story: the cobblestone anecdote, the measured gap, the one-rule fix ("code owns the facts, the LLM owns the plan"), repo link. r/programming favors a linked article — link the receipt doc or the site, not a text post, if the sidebar prefers links. Decide on send day.⟧

## Reply drafts (prepare before posting, human sends)

- "Isn't this just function calling / structured output?" → No: structured output constrains the *format* of claims; the referee ignores claims entirely and measures state deltas. Different trust boundary.
- "Why not just use a better model?" → We measured with Claude Sonnet 4.6; the gap is a loop-design problem — any model that self-reports completion unverified will drift. Numbers in the dataset.
- "N is small" → True — dataset and methodology are public precisely so the N can grow; the referee was calibrated against blind human labels before the trial (11/12 agreement, 92%).
- "Cherry-picked?" → Every attempt in the field-trial window is in the ledger, failures included; `label_source` column shows which were referee-measured.
