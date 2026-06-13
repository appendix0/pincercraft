<h1 align="center">PincerCraft</h1>

<p align="center">
  <img src="banner.webp" alt="PincerCraft — a Minecraft bot that can't lie to itself" width="640">
</p>

<p align="center"><b>A Minecraft bot that can't lie to itself.</b><br>A Mindcraft fork with a deterministic harness under the LLM.</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/fork%20of-Mindcraft-informational" alt="Fork of Mindcraft">
  <img src="https://img.shields.io/badge/lies%20to%20itself-no-brightgreen" alt="Lies to itself: no">
</p>

<p align="center">
  <a href="https://github.com/kolbytn/mindcraft">Upstream</a> ·
  <a href="docs/agent-blueprint.md">Design</a> ·
  <a href="docs/CHANGELOG.md">Changelog</a>
</p>

---

Stock Mindcraft hands an LLM a pickaxe and hopes. The model guesses its own inventory, "remembers" tools it isn't holding, declares victory over tasks it never finished, and re-prompts itself straight into a rate limit.

PincerCraft fixes that with one rule:

> **Code owns the facts. The LLM owns the plan.**

Inventory counts, *"can I mine this?"*, the recipe gap, *"is this task actually done?"* — computed every turn and handed to the model. It doesn't get to guess. The bot can't lie to itself about what it holds or what it finished, and it gets measurably better over time.

## What makes it different

- 🧠 **A deterministic harness.** Proprioception + recipe math + gates. Try to craft a diamond axe with zero diamonds and it stops you, offers the wooden one, and moves on. — [`live_state.js`](src/agent/live_state.js), [`verify.js`](src/agent/verify.js)
- ⚡ **Event-driven orchestrator.** Thinks when something changes, then parks. No burst loop, no "my brain disconnected." — [`orchestrator_v2.js`](src/agent/orchestrator_v2.js)
- 📋 **Queue + Plan Mode.** Talk mid-task without a race. Big builds get decomposed into a plan you approve before it touches a block.
- 📖 **A Code of Conduct it can't forget.** The rules live in a book on a lectern *in the world*. Edit it in vanilla Minecraft; the bot obeys within ~2s.
- 🔁 **It improves itself.** An eval loop invents tasks, scores them, and writes patches to `src/` — on a branch. We still read them before merging. Usually.
- 🔍 **Honest grading.** Success is graded from world state, never the bot's word. It has lied ("done!" — 0 blocks moved). The grader caught it every time.

## Stock Mindcraft vs PincerCraft

| | Stock | PincerCraft |
|---|---|---|
| Inventory & recipes | LLM eyeballs them | computed in code |
| "Task done?" | honor system | checked against world state |
| A bad plan | runs, fails, retries | bounced with a fix |
| Agent loop | re-prompts on every line | parks until something changes |
| Getting better | you edit the code | it drafts its own patches |

## Setup

Same as upstream Mindcraft — see the [Mindcraft README](https://github.com/kolbytn/mindcraft/blob/main/README.md) and [FAQ](https://github.com/kolbytn/mindcraft/blob/main/FAQ.md) for install and model config.

```bash
npm install
cp keys.example.json keys.json   # add your API keys
npm start                         # profile is set in settings.js
```

- Needs **Node 20**.
- Ships an `nvidia` profile (`profiles/nvidia.json`) for the free [build.nvidia.com](https://build.nvidia.com) endpoint (Llama 3.3 70B).
- The self-improvement loop lives in [`eval/`](eval/); the deterministic graders in [`evals/`](evals/).

## Credits

Built on [kolbytn/mindcraft](https://github.com/kolbytn/mindcraft), which wires LLMs to Minecraft via [Mineflayer](https://prismarinejs.github.io/mineflayer/). All credit for the foundation goes to the Mindcraft authors.

Pull upstream updates with:

```bash
git fetch upstream && git merge upstream/develop
```

## License

MIT — same as upstream. See [LICENSE](LICENSE).
