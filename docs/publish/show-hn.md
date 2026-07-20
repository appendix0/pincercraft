# DRAFT — Show HN

**Ring 3, the big swing. Human sends**, after rings 1–2, same week as Reddit.
Post weekday morning US time (~14:00–16:00 UTC). Show HN rules: no ask for
upvotes anywhere, ever; first-person; be around for 3–4 hours after posting
to answer comments (reply drafts below help but HN smells canned answers —
personalize each).

Pre-send checklist:
- [ ] Numbers filled — `grep ⟦` returns nothing
- [ ] README is the landing page and carries the benchmark table (HN clicks the repo, not the site)
- [ ] Demo GIF at top of README
- [ ] Rings 1–2 links live (upstream issue = credibility if asked "what does upstream think?")

---

**Title:** Show HN: My Minecraft bot lied about finishing tasks, so I built it a deterministic referee

**URL:** https://github.com/appendix0/pincercraft

**First comment (post immediately after submitting):**

I run an LLM Minecraft bot (a Mindcraft fork). The moment that started all of this: I asked it to gather 32 cobblestone. It declared the task done in five seconds. It hadn't moved — it already had 37 in its bag and decided that counted. The LLM-based grader I was using at the time scored it a success.

So I stopped letting the model grade its own homework. Every task attempt now snapshots inventory before, re-measures after, and a deterministic referee labels success from the world-state delta. Measured over 9 fixed benchmark tasks with the harness switched off: the model claimed completion on 100% of them, the world confirmed 11% (1 of 9). The same 9 tasks with the harness on: 9/9 confirmed.

That number reshaped the whole bot. The design rule became: code owns the facts (inventory, "can I mine this?", recipe gaps, completion), the LLM only owns the plan — basically what coding agents do with typechecks and tests, pointed at Minecraft. Deterministic reflexes catch the dumb loops (it once spent 24 LLM rounds hunting spiders on a peaceful-mode world where spiders can't spawn — now an empty search parks the task and asks the player).

Everything's measurable on purpose: episode traces, referee verdicts, and human gold labels are published as a dataset (⟦HF link⟧), and there's a worked before/after of the same impossible task with and without the harness in the repo.

Zooming out: the goal was never a better Minecraft bot. Open-world, long-horizon tasks are where LLM agents fall apart, and Minecraft works as a cheap, measurable arena for exactly that — the same failure modes wait for any agent that has to act in the real, physical open world.

Honest limitations: it's a fork, upstream credit is in the README; the referee covers inventory-delta tasks (gather/craft/give), not build quality; N is 18 referee-labeled trial attempts (plus the 12-attempt human calibration set) and growing; Claude is the tested brain.

## Reply drafts (themes to personalize on the day)

- "LLM agents lying about completion is well known" → Known, yes; *measured with public traces on an embodied agent*, we couldn't find. Links welcome if someone has prior art — genuinely want to cite it.
- "Why Minecraft?" → Cheap, observable world state = ground truth is queryable. The referee pattern ports to anything with a measurable environment.
- "Isn't the referee just tests?" → Yes! That's the point — agents get eval'd on vibes while we'd never ship code that way. This is "write the test first" for an agent loop.
- Someone asks about cost → real numbers from the ledger (tokens per attempt by tier are in the DB; quote them, don't estimate).
