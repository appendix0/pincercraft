# SENT — second upstream issue for mindcraft-bots/mindcraft

**Ring 1 follow-up to #808.** Posted 2026-07-24: https://github.com/mindcraft-bots/mindcraft/issues/810

Timing note (2026-07-23): #808 (the completion-referee issue) was posted same day with
zero comments/reactions so far. Held ~24h per owner instruction ("check on #808 tomorrow,
then send this one") before sending.

Pre-send checklist (all re-verified immediately before send, 2026-07-24):
- [x] #808 re-checked: still 0 comments/0 reactions, still open — no engagement either way,
      but 24h had passed per owner's timing instruction, and no hostile response to hold for
- [x] #780 still open, maintainer cost-complaint reply (uukelele, 2026-06-01) still there
- [x] #187, #246, #347, #290 re-checked — all still CLOSED, summaries below still accurate
- [x] 0.79 cache-hit-ratio re-verified live on the HF dataset card
      (Appendix0/pincercraft-say-do-gap, `metrics` config, confirmed via HF API)
- [x] `grep ⟦ docs/publish/upstream-issue-2-loop-guards-caching.md` returns nothing
- [x] `HARD_CAP=12` and the two-strikes fingerprint logic in `src/agent/orchestrator_v2.js`
      unchanged since this draft was written

---

**Title:** Two cheap fixes for the "$100/day" cost problem (#780): a hard iteration cap, and prompt caching on the system prompt

**Body:**

#780 already names the two ways this framework burns money doing nothing: bots that "discuss nonsense and place random blocks" instead of finishing (wasted tool-call rounds), and — implicitly, since nothing in the loop is cached — a system prompt re-billed in full on every turn. A maintainer reply on #780 points at the first one directly ("a proper self-prompting loop" running unconstrained). We hit both on our fork and fixed them separately; writing them up together since they're the same underlying complaint.

**1. Loops: a hard per-invoke iteration cap + a two-strikes circuit breaker.**

Nothing currently stops an agent loop from continuing forever once it's making individually-plausible tool calls that add up to no progress. #187, #246, and #347 all look like symptoms of this from the outside (`goToBlock` hangs forever, "keeps getting stuck," repeats the same things over and over) — a single call or a whole task can wedge or loop with nothing in the framework noticing.

We cap each invoke (one incoming event → LLM loop until it stops calling tools) at 12 rounds, then check whether the *same task* hit that cap twice in a row with *zero measurable progress* (inventory-delta check, same mechanism as the completion referee in #808). Two strikes and the task is cancelled in code, with a chat message telling the player why — instead of silently re-arming a fresh 12-round budget forever. Real example from our logs: "get string by killing spiders" in a peaceful world (no spiders can spawn) — 24 individually-sensible-looking rounds (search, wait, search again) before the breaker caught it. Every single round looked reasonable in isolation; only checking progress *across* rounds catches it.

We also block the narrower case directly: an agent re-issuing the *exact same* inventory-changing tool call against the *exact same* inventory state gets refused outright instead of re-executed.

**2. Cost: the system prompt gets re-billed in full every turn.**

Separate mechanism, same symptom. If the system prompt is one string, none of it is eligible for Anthropic's prompt caching — the ~10-13K tokens of persona/rules/tool-schema text gets paid for as fresh input every single turn even though almost none of it changed turn to turn.

We split the system prompt into a static half (persona, rules, tool descriptions — byte-identical every turn) and a dynamic half (live inventory, task progress, nearby blocks), and only mark the static half `cache_control: ephemeral`. The tools array gets the same treatment (the cache breakpoint goes on the last tool descriptor, which caches the whole array as one prefix). Two breakpoints total, under Anthropic's 4-breakpoint limit. Measured across 43 tasks on our fork: mean cache-hit ratio 0.79 — about 79% of prompt tokens read from cache (~10x cheaper) instead of billed fresh. One trap worth flagging: anything that rewrites the front of the prompt (e.g. history compaction) busts the cache, so we throttle that deliberately rather than doing it every turn.

Both are small, self-contained — no architecture change, no new dependencies. Happy to open minimal PRs for either or both if useful; the caching one especially is a pretty mechanical prompt restructure regardless of what loop sits on top of it.

Metrics backing the 0.79 number: https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap (`metrics` config). Fork for context: https://github.com/appendix0/pincercraft (MIT, same as here).
