# DRAFT — Mindcraft Discord post

**Ring 1, artifact #2. Human sends**, ~2–3 days after the upstream issue.
Target channel: whatever the Mindcraft server uses for showcase/forks (check
pins first; if there's a #showcase or #projects channel, use that, not
#general).

Pre-send checklist:
- [x] Upstream issue is posted (this links to it) — https://github.com/mindcraft-bots/mindcraft/issues/808 (2026-07-23)
- [ ] Demo GIF/MP4 recorded and attached — the post leads with it
- [ ] Numbers filled — `grep ⟦` returns nothing
- [ ] Tone check: we're a fork saying thanks + showing work, not advertising at them
- [ ] Wait ~2-3 days after the issue post before sending (per header above)

---

**Post:**

Been running a Mindcraft fork for a couple months and finally measured the thing that was driving me crazy: how often the bot *says* it finished a task vs. how often the world agrees.

Answer, measured with the harness switched off (i.e., trusting the model the way the stock loop does): the model claimed done on 100% of attempts (9/9), world-state delta confirmed 11% (1/9). Same nine tasks with the harness on: 9/9 verified. Best single example — asked it to gather 32 cobblestone while it already held 37; it declared victory in 5 seconds without moving. The LLM grader passed it. The inventory-delta check didn't.

The fork's whole idea: **code owns the facts (inventory, "can I mine this?", "is this actually done?"), the LLM only owns the plan** — the discipline coding agents live by, pointed at Minecraft. Deterministic referee grades every task from world-state deltas, reflexes catch stuff like searching for spiders that can't spawn, and a circuit-breaker kills non-converging tasks instead of burning your API budget. Long game: agents that survive open-world, long-horizon work without lying about it — Minecraft is the arena that makes that measurable.

⟦attach demo GIF/MP4 here⟧

- Measured writeup + offer of a small upstream PR: https://github.com/mindcraft-bots/mindcraft/issues/808
- Repo (MIT, same as upstream): https://github.com/appendix0/pincercraft
- Raw traces if you want to check my math: https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap

Huge thanks to the Mindcraft folks — all of this stands on their foundation. Happy to answer anything about the harness.
