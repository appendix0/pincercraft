# DRAFT — Mindcraft Discord post

**Ring 1, artifact #2. Human sends**, ~2–3 days after the upstream issue.
Target channel: whatever the Mindcraft server uses for showcase/forks (check
pins first; if there's a #showcase or #projects channel, use that, not
#general).

Pre-send checklist:
- [ ] Upstream issue is posted (this links to it)
- [ ] Demo GIF/MP4 recorded and attached — the post leads with it
- [ ] Numbers filled — `grep ⟦` returns nothing
- [ ] Tone check: we're a fork saying thanks + showing work, not advertising at them

---

**Post:**

Been running a Mindcraft fork for a couple months and finally measured the thing that was driving me crazy: how often the bot *says* it finished a task vs. how often the world agrees.

Answer: the model claimed done on ⟦X%⟧ of attempts, world-state delta confirmed ⟦Y%⟧. Best single example — asked it to gather 32 cobblestone while it already held 37; it declared victory in 5 seconds without moving. The LLM grader passed it. The inventory-delta check didn't.

The fork's whole idea is Claude-Code-style: **code owns the facts (inventory, "can I mine this?", "is this actually done?"), the LLM only owns the plan.** Deterministic referee grades every task from world-state deltas, reflexes catch stuff like searching for spiders that can't spawn, and a circuit-breaker kills non-converging tasks instead of burning your API budget.

⟦attach demo GIF/MP4 here⟧

- Measured writeup + offer of a small upstream PR: ⟦upstream issue link⟧
- Repo (MIT, same as upstream): https://github.com/appendix0/pincercraft
- Raw traces if you want to check my math: ⟦HF dataset link⟧

Huge thanks to the Mindcraft folks — all of this stands on their foundation. Happy to answer anything about the harness.
