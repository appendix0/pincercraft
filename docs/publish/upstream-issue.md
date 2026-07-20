# DRAFT — upstream issue for mindcraft-bots/mindcraft

**Ring 1, artifact #1. Human sends.** This goes first — everything else links it.

Pre-send checklist:
- [ ] Field Trial done; every `⟦…⟧` replaced with a number that traces to a DB row
- [ ] Referee Calibration done (~6 human-verified attempts)
- [ ] Receipt doc + HF dataset links live
- [ ] Re-check #800/#780 are still open; adjust the opener if they've moved
- [ ] `grep ⟦ docs/publish/upstream-issue.md` returns nothing

---

**Title:** Measuring the "bot says done but it isn't" failure — and a cheap deterministic check that catches it

**Body:**

A lot of the open reliability issues here look different on the surface but share a root. #800 — the bot's bag shows mutton, the bot acts as if it has none. #780 — top-tier APIs, ~$100 spent, and the bots "discuss nonsense" while placing random blocks. In both cases the model is being *trusted* for facts it can't reliably perceive (its own inventory, whether a task actually finished), and nothing in the loop checks its claims against the world.

We wanted to know how big that problem actually is, so we measured it on our fork.

**Setup:** every task attempt snapshots inventory before, re-measures after, and a deterministic referee labels success from the world-state delta — the model's own "done!" doesn't count. Attempts land in a SQLite ledger with both labels (what the model claimed vs. what the world showed).

**Result:** across 9 referee-labeled benchmark attempts with our harness ablated — i.e., trusting the model the way the stock loop does — the model claimed completion on 100% but the world-state delta confirmed only 11% (1 of 9) — an 89-point say-do gap. The same 9 tasks with the harness on verified 9/9. (Referee calibration: 11/12 = 92% agreement with blind human labels on live attempts.) The single funniest row: asked to *gather 32 cobblestone* while already holding 37, the bot declared done in five seconds having moved zero blocks — and an LLM grader scored it a success. The delta check fails it: gained 0, needed 32.

Full traces (episode JSONLs + referee verdicts + human gold labels) are published as a dataset: ⟦HF link⟧. A worked before/after on one task is here: [receipt doc](https://github.com/appendix0/pincercraft/blob/develop/docs/receipts/2026-07-12-search-miss-before-after.md).

**The part that might be useful upstream:** the completion check is small and self-contained — snapshot inventory at task start, compute the delta at "done", reject the claim if the delta doesn't cover the goal. No architecture change, no new dependencies. I'm happy to open a minimal PR with just that piece (as an eval-side script or wired into task completion, whichever fits better) if there's interest. Keeping it deliberately small so it's easy to review.

Fork with the full harness, for context: https://github.com/appendix0/pincercraft (MIT, same as here).
