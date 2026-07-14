# PincerCraft distribution plan

Goal: **maximum number of people who know the project exists**, funneled to
the GitHub repo. Baseline 2026-07-14: 1 star, 0 external contributors, site
live but unvisited. Everything below funnels to
https://github.com/appendix0/pincercraft — the repo is the landing page; the
site is a business card.

## The story we're selling

One sentence: **"My Minecraft bot kept lying about finishing tasks, so I gave
it a deterministic harness and a referee that measures the world instead of
trusting the model."**

Why it travels: it's not "another Minecraft bot" (crowded, we lose) — it's
"LLM agents lie about task completion and here's the measured gap + the fix"
(agent-reliability story, wide audience, we have receipts nobody else has).
Every channel gets the same story tuned to its dialect.

## Audiences, largest reach last

| ring | who | where | why they care |
|---|---|---|---|
| 1 | Mindcraft community | mindcraft-bots/mindcraft issues, Mindcraft Discord | their bots have this exact disease (issues #800, #780) |
| 2 | LLM-agent builders & eval people | HuggingFace dataset, r/LocalLLaMA, X | say-do-gap trace dataset; harness-over-model design |
| 3 | General devs | Show HN, r/programming | "we caught our AI lying and built a referee" is a great story |

Ring 1 is small but gives *credibility* (upstream engagement we can point
at). Ring 3 is where the raw numbers are. Launch order = 1 → 2 → 3, each post
linking the artifacts the previous ring validated.

## Vocabulary (named 2026-07-14)

- **Field Trial** — the two-arm in-game evidence campaign: 10 fixed tasks
  (`eval/benchmarks.json`), harness on vs. harness off, 30–50 attempts/arm,
  referee-graded, runs unattended. Produces the claimed-vs-verified gap +
  the README benchmark table.
- **Referee Calibration** — the one-time human check of the referee before
  the Field Trial: owner hand-verifies ~6 attempts (`eval/agreement.py label`),
  compares to referee verdicts (`report`). Certifies the grader; fix the
  referee first if it disagrees.

## Asset checklist (hook → proof → depth)

| asset | state | job |
|---|---|---|
| Demo GIF/tape (30–60s) | ❌ script ready (fishing-rod receipt = storyboard) | the hook; top of README, every post embeds it |
| Headline number: claimed-vs-verified gap | ❌ needs the Field Trial | the proof; the one thing HN can't dismiss |
| Referee Calibration % | ❌ needs ~6 human-verified attempts (10 min, in-game) | pre-empts "why trust your referee?" |
| README | 🟡 rewritten 2026-07-14 (top-5 hierarchy locked, receipt linked, demo slot reserved); missing numbers + demo | the landing page |
| Receipts docs | 🟡 1 shipped (search-miss before/after); want a 2nd (cap-breaker or referee-catches-false-done) | the depth clicks |
| HF dataset | ❌ raw material exists (28 episode JSONLs, 20-attempt SQLite ledger, gold labels) | ring-2 artifact + SEO surface |
| Site | 🟡 live, ~6 weeks stale | must mirror the thesis + link demo |
| Upstream issue/PR draft | ✅ drafted (upstream-issue.md); numbers pending | ring-1 artifact |
| Discord post draft | ✅ drafted (discord-post.md); numbers pending | ring-1 artifact |
| Show HN / Reddit drafts | ✅ drafted (show-hn.md, reddit-drafts.md); numbers pending | ring-3 artifacts |

## Sequence

**Phase 0 — build the assets (now, parallel with the Field Trial):**
1. README fixes that need no numbers: upstream links → mindcraft-bots,
   link the receipt doc, add "verified live" list with episode IDs.
2. Record the demo tape (owner records iPad screen; Claude monitors log,
   dry-run first). Convert to GIF for README + keep MP4 for posts.
3. Referee Calibration: owner hand-verifies ~6 attempts → agreement %.
4. Field Trial runs unattended (two arms, harness on vs off; delta benchmarks,
   `92cea36`): full stack vs ablated, 30–50 attempts/arm.
5. Draft all posts in docs/publish/ while numbers cook.

**Phase 1 — package the proof:**
6. README numbers table + second receipt doc.
7. HF dataset: episodes + referee verdicts + gold labels + README card
   ("say-do gap in LLM Minecraft agents"). Publish (it's quiet — datasets
   don't trend, they accumulate citations and search traffic).
8. Site refresh to mirror it.

**Phase 2 — launch, in ring order (one artifact per ~2–3 days, each linking
the previous):**
9. Upstream GitHub issue citing their #800/#780 with our measured gap +
   offer of a small PR. (Maintainer review is slow — the issue TEXT carries
   the argument.)
10. Mindcraft Discord post: demo GIF + gap number + repo link + "posted the
    measurement upstream here →".
11. Show HN: "Show HN: My Minecraft bot lied about finishing tasks, so I
    built it a deterministic referee" + r/LocalLLaMA the same week.

**Phase 3 — sustain:** reply drafts for every thread (human sends), watch
upstream #800, changelog cadence, second wave (blog-style deep dive on the
five-layer harness) if wave one gets traction.

## Rules of engagement

- Human sends everything; drafts live in docs/publish/. No account automation.
- Never oversell: every number in a post must trace to a DB row or episode
  file. The honesty IS the brand — a bot that can't lie, marketed by people
  who don't.
- Metrics to watch: repo stars, issue/PR replies upstream, HF downloads,
  HN points. Baseline 1 star.
