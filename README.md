# PincerCraft

**A Minecraft harness for studying agent reliability.**

[About](#about-the-project) · [Getting started](#getting-started) · [Usage](#usage) · [Evaluation](#evaluation) · [Status and limits](#project-status-and-limits) · [Contributing](#contributing) · [License](#license)

## About the project

PincerCraft is a hands-on project exploring how to make agents more useful on long-running tasks in open worlds. Using Minecraft, I’m building a harness that tracks world state, checks action preconditions, and verifies task completion. Through implementation and controlled experiments, I study where agents fail and how the surrounding system can help them work more reliably.

The project is built on [Mindcraft](https://github.com/mindcraft-bots/mindcraft) and inspired by [Voyager](https://voyager.minedojo.org/). Here, a *harness* is the code around the model: it supplies observations, manages execution, checks supported completion criteria, and records outcomes. The LLM plans and generates actions; the harness connects those actions to the game and measures what happened.

### Built with

JavaScript and Node.js for the bot and harness; Mindcraft and Mineflayer for Minecraft integration; Python and SQLite for evaluation and analysis. The reported experiments used Claude Sonnet 4.6.

### Learning questions

The goal is a useful agent that can keep working toward an objective, handle failures, and report its progress accurately. Minecraft provides an open world in which to build and inspect these behaviors. The experiments so far use a small, fixed task set; the broader long-horizon goal remains work in progress.

The work centers on three questions:

- Which parts of the agent’s state and progress can be checked directly in code?
- How should execution respond when an action is infeasible, interrupted, or repeatedly makes no progress?
- How can task outcomes be evaluated separately from the agent’s own completion claim?

One concrete distinction is **having an item versus gathering more of it**. If a task asks for 16 additional cobblestone, inventory that already contains 16 does not satisfy the request. The completion check needs the change from the starting inventory. Making that distinction explicit is part of the harness.

## How it works

| Part | What it does | Code |
|---|---|---|
| World-state observations | Supplies inventory, nearby objects, capabilities, and task progress to the planner. | [live_state.js](src/agent/live_state.js) |
| Action checks | Checks supported preconditions and completion criteria, including inventory counts and gains. | [classify_and_gate.js](src/agent/classify_and_gate.js), [verify.js](src/agent/verify.js) |
| Execution and recovery | Coordinates model calls and tool results; uses loop guards, task queues, and coded responses to recurring failures. | [orchestrator_v2.js](src/agent/orchestrator_v2.js), [task_queue.js](src/agent/task_queue.js), [modes.js](src/agent/modes.js) |
| Evaluation | Measures inventory changes and supported structures separately from the bot’s completion claim; records outcomes for analysis. | [referee.mjs](eval/referee.mjs), [blockscan.py](eval/blockscan.py), [eval_db.py](eval/eval_db.py) |

Completion checks have a defined scope. Inventory criteria are supported, and the evaluation scorer can check square platforms. If a criterion cannot be parsed or the required measurement is unavailable, the scorer can fall back to the task’s reported outcome and label it `honor_system`. Those labels must be distinguished from measured results. All 356 attempts in the evaluation’s primary set were scorer-labeled.

The repository also contains prompt caching and history compaction, an in-game rulebook, and an experimental evaluation loop that can propose code changes for human review. These support the working bot; the main focus here is understanding and improving its execution through the harness.

## Getting started

The checkout includes configuration for the development bot. Adapt it before starting your own instance.

You need Node.js 20.x, npm, a Java-edition Minecraft server, and model API credentials. The project’s recorded setup used Paper 1.21.x and Node 20; Node 24 caused an agent-process failure in that setup. Native graphics dependencies may require platform-specific build libraries.

```bash
git clone https://github.com/appendix0/pincercraft.git
cd pincercraft
nvm install 20
nvm use 20
npm install
cp keys.example.json keys.json
```

The `nvm` commands assume [nvm](https://github.com/nvm-sh/nvm) is installed. If Node 20 is already installed through another method, omit those two commands.

1. Add your `ANTHROPIC_API_KEY` to `keys.json`. The starter [profiles/claude.json](profiles/claude.json) also selects OpenAI embeddings, so provide `OPENAI_API_KEY` when using that profile as written.
2. In [settings.js](settings.js), set `host`, `port`, `minecraft_version`, and `auth` for your server. Set `profiles` to `["./profiles/claude.json"]` and choose the bot name in that profile. Its coding model defaults to its chat model unless `code_model` is specified.
3. Replace the existing player entry in `only_chat_with` and `permissions` with your Minecraft username. The first controls whose chat is accepted; the second controls permitted commands. An owner entry can use `{ "allow": ["!*"] }`.
4. Keep `use_orchestrator_v2` and `use_tool_use_protocol` enabled for the execution path described here. Set `mcp.enabled` to `false` unless you are configuring the local evaluation or external-tool workflow.
5. Review `allow_insecure_coding`: it enables generated JavaScript actions and is on in the supplied settings. Use a test world and an appropriately isolated process for experimentation.

```bash
npm start
```

## Usage

After the bot joins, send a small task from an authorized Minecraft account. For example:

```text
Gather 16 additional cobblestone.
```

Here, “additional” means a gain relative to the inventory at task start. The task needs an observable completion criterion; the harness only verifies criteria it supports.

The in-game commands `!inventory` and `!showQueue` inspect the bot’s inventory and task queue. They must be allowed by the player’s configured permissions. A task can fail, time out, or require clarification; the example is a request to try, not a guaranteed outcome.

For the experiment workflow, see the [evaluation section](#evaluation).

## Evaluation

I compared harness configurations with the same model, Claude Sonnet 4.6, on **13 fixed Minecraft tasks across four replicates**. The primary dataset contains **356 scored attempts across seven configurations**. The two whole-harness configurations account for 103 of those attempts:

| Configuration | Attempts | Verified task success | False completion |
|---|---:|---:|---:|
| Full harness | 52 | 35/52 (67.3%) | 2/52 (3.8%) |
| Harness components disabled | 51 | 15/51 (29.4%) | 23/51 (45.1%) |

**False completion** means the agent reported success but the scorer found the task criterion unmet. The percentages use all attempts in each row as the denominator.

The comparison disables the experimental harness components in this fork. It is not a comparison against stock Mindcraft. Player-safety mechanisms and the external evaluation scorer remain enabled in both configurations.

On this task set, the full harness produced fewer false completion reports and more verified successes. Individual component ablations did not establish the planned per-component effects. The results therefore support the whole-system comparison without establishing how much each component contributes.

### Limits of these results

This is one model, one world, and a small task family with fixed starting kits. The rates depend on that setup. Scorer calibration was mostly inventory-based, with a disagreement on the platform task.

The experiment also had a 15.0% infrastructure-fault discard rate, unequal sample sizes, and a failed position-reset mechanism. Eight zero-step timeouts remain counted as failures. These issues and the sensitivity checks are documented with the results.

See the [full results and limitations](docs/paper/results.md), [task definitions](eval/benchmarks.json), [experiment protocol](docs/paper/protocol.md), and [incident log](docs/paper/aborts.md). A [worked trace](docs/receipts/2026-07-12-search-miss-before-after.md) shows how a repeated unsuccessful search led to a change in the bot’s behavior.

To regenerate the summary from an existing evaluation ledger:

```bash
PINCER_EVAL_DB=/path/to/pincercraft_evals.db python3 eval/campaign_report.py
```

This analyzes previously collected data; it does not run the bot. The SQLite ledger is not included in a fresh clone. The [published dataset](https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap) currently documents an earlier pilot and should not be treated as the complete data for the 356-attempt evaluation above. The collection workflow in the [runbook](docs/paper/runbook.md) needs additional server, MCP, and ledger configuration.

## Project status and limits

The project remains an engineering and learning effort. The experiments do not establish reliability across arbitrary long-horizon tasks, other models, or physical robots. Completion checks only cover supported criteria, and the agent can still fail or report an incorrect outcome.

The [current implementation guide](docs/current-architecture.md) describes the execution path and configuration boundaries. The older [agent blueprint](docs/agent-blueprint.md) is a historical design plan.

## Contributing

Bug reports should include the code revision, relevant configuration with secrets removed, the task or command, and the observed outcome. For evaluation changes, include the task criteria and how the result was checked.

Use [GitHub issues](https://github.com/appendix0/pincercraft/issues) to report a problem or discuss a change. Keep fixes focused and run the relevant checks in [test/](test/) or [eval/](eval/).

## Background and credits

[Mindcraft](https://github.com/mindcraft-bots/mindcraft) provides the underlying LLM–Minecraft integration through [Mineflayer](https://github.com/PrismarineJS/mineflayer). PincerCraft builds on that foundation with harness and evaluation work.

[Voyager](https://voyager.minedojo.org/) influenced the open-ended Minecraft-agent direction and the labeled observation format used in [live_state.js](src/agent/live_state.js).

The [change history](docs/CHANGELOG.md) and experiment notes preserve the development record.

## License

[MIT](LICENSE), retaining the upstream Mindcraft license.

README structure adapted from [Best-README-Template](https://github.com/othneildrew/Best-README-Template).
