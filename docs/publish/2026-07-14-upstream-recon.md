# Upstream recon — mindcraft, 2026-07-14

Purpose: aim the first-contact PR/issue (v1 distribution step). Sources: GitHub
API, surveyed 2026-07-14.

## The repo moved

`kolbytn/mindcraft` → **`mindcraft-bots/mindcraft`** (org). Old URL redirects.
Our README + git remote `upstream` should be updated to the new path.
5,489 stars · 858 forks · 51 open issues/PRs · last push 2026-06-10 (a month
quiet at survey time). No Discussions tab — issues and Discord are the only
public channels.

## Who's actually home (last 30 commits)

| account | commits | latest |
|---|---|---|
| riqvip | 7 | 2026-06-09 |
| uukelele | 6 | 2026-05-27 |
| domdomegg | 5 | 2026-04-16 |
| MaxRobinsonTheGreat (original author) | 5 | 2026-03-19 |

Maintenance is community-driven now; the original authors are mostly gone.
Review latency is real: two well-written external PRs (atiweb's #795
search-volume bound, #796 world-cache resync — both squarely in our
"deterministic reliability" territory) have sat unreviewed since 2026-06-17.
Lesson: the PR must be small, self-evidently correct, and the issue text has
to carry the argument even if the PR waits.

## Has anyone made our point? No.

Searches for hallucination / false completion / "claims done" complaints:
**zero issues frame "the bot says done when it isn't" as a measurable
problem.** The say-do gap thesis is unclaimed territory upstream.

But the *symptoms* are all over the tracker — these are the issues to cite:

- **#800 "Problem about Items Putting"** (opened 2026-07-14, active): bot's
  bag shows mutton, bot acts as if it has none — a live inventory
  proprioception/desync complaint. This is exactly our inventory-authority
  layer.
- **#780 "This is pretty poor. No real house ever been build"** (open): most
  capable APIs, ~$100 spent, bots "discuss nonsense" and place random blocks —
  the cost-of-unverified-claims complaint.
- **#798 PathStopped** (open): same nav failure class as our P1 backlog item.
- **#801 stuck on blocks (Paper server)**, **#451 water source confusion**,
  **#767 freezes after damage**, **#741 constant crashes** — reliability, not
  intelligence, is what users complain about.

## Pitch angle (for the PR/issue draft)

1. Lead with **their** issues: #800 and #780 are the hook — "here's the same
   failure measured, and a harness pattern that closes it."
2. Offer ONE small, reviewable PR (candidate: the search-miss reflex or the
   inventory delta referee as a standalone eval script — pick after the
   campaign numbers exist). Not the whole fork.
3. Attach the number: claimed-vs-verified gap from the two-arm campaign, plus
   the referee-agreement %.
4. Link the receipt doc and the HF dataset for anyone who wants the traces.

## Action items

- [ ] Update README upstream links + `upstream` remote to mindcraft-bots/mindcraft.
- [ ] Draft `docs/publish/upstream-issue.md` after campaign numbers exist,
      citing #800/#780.
- [ ] Watch #800 (active today) — if it stays open, it's the natural thread to
      reply in with the measured take. (Human sends; draft goes here.)
