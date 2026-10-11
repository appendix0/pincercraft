<div align="center">

<img src="banner.webp" alt="PincerCraft — code owns the facts, the LLM owns the plan" width="640">

# PincerCraft

**Code owns the facts. The LLM owns the plan.**

A harness for LLM agents tackling long-horizon tasks in open worlds.

[Getting started](#getting-started) · [Design](docs/current-architecture.md) · [Report a bug](https://github.com/appendix0/pincercraft/issues)

</div>

## Contents

- [About the project](#about-the-project)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Agent integration](#agent-integration)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License and acknowledgments](#license-and-acknowledgments)

## About the project

PincerCraft builds the execution layer around an LLM agent: tracking world state,
checking action preconditions, coordinating tasks, and verifying supported
completion criteria. The objective is to make agents useful on long-running
tasks in open worlds. Minecraft is the development and evaluation environment.

The project builds on **Mindcraft**. The LLM plans and generates actions; the
**harness** supplies observations, manages execution, and checks supported task
criteria. Inventory counts, recipe requirements, and task progress come from
game state. Completion checks distinguish what the agent reports from what the
world shows.

For example, gathering 16 additional cobblestone requires a gain of 16 from the
starting inventory. Already holding 16 is not enough. Making these distinctions
explicit, then testing how they affect execution, guides the harness design.

Built with JavaScript, Node.js, and Mineflayer for the bot; Python and SQLite for
evaluation. The experiments use Claude Sonnet 4.6. Minecraft provides the test
environment; useful behavior over longer, more open-ended tasks remains the goal.

## Getting started

Use Node.js 20.x, npm, a Java-edition Minecraft server, and the API credentials
for your chosen profile. The recorded setup used Paper 1.21.x and Node 20.
Native graphics dependencies may need platform-specific build libraries.

```bash
git clone https://github.com/appendix0/pincercraft.git
cd pincercraft
nvm install 20
nvm use 20
npm install
cp keys.example.json keys.json
```

The `nvm` commands assume [nvm](https://github.com/nvm-sh/nvm) is installed;
omit them if you already have Node 20 through another method.

The starter [Claude profile](profiles/claude.json) uses Anthropic for the model
and OpenAI for embeddings. Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` to
`keys.json` when using that profile unchanged. Its coding model defaults to its
chat model unless `code_model` is specified.

Adapt [settings.js](settings.js) before starting:

- Set `host`, `port`, `minecraft_version`, and `auth` for your server.
- Set `profiles` to `["./profiles/claude.json"]` and choose the bot name in that file.
- Replace the development player in `only_chat_with` and `permissions` with your
  Minecraft username. An owner entry can use `{ "allow": ["!*"] }`.
- Keep `use_orchestrator_v2` and `use_tool_use_protocol` enabled. Set
  `mcp.enabled` to `false` unless you are configuring the optional tool interface.

The supplied settings enable `allow_insecure_coding`, which permits generated
JavaScript actions. Review that choice and use a test world and an appropriately
isolated process for experimentation.

```bash
npm start
```

## Usage

### Give the bot a task

After the bot joins, send a small task from an authorized Minecraft account:

```text
Gather 16 additional cobblestone.
```

“Additional” means a gain relative to the inventory at task start. A task needs
an observable completion criterion for the harness to check it. Tasks can still
fail, time out, or require clarification.

### Inspect progress

```text
!inventory
!showQueue
```

These in-game commands show the bot’s inventory and task queue. They must be
allowed by the player’s configured permissions.

The [search-miss example](docs/receipts/2026-07-12-search-miss-before-after.md)
shows a recorded failure and the change made in response: after repeatedly
searching unsuccessfully, the bot parks the task and asks the player.

## Agent integration

The [orchestrator](src/agent/orchestrator_v2.js) coordinates model turns and tool
results. [Live observations](src/agent/live_state.js) supply world state, while
the [verification code](src/agent/verify.js) checks supported inventory criteria.
The task queue and coded recovery behaviors handle interruptions and recurring
failures.

An optional local MCP interface exposes selected bot commands to external tools
and the evaluation workflow. It needs its own token and permission configuration.
The [current implementation guide](docs/current-architecture.md) describes the
execution path and feature flags.

The external [evaluation scorer](eval/referee.mjs) takes its own measurements
and records outcomes separately from the bot’s completion claim. It supports
inventory criteria and certain square-platform checks. Unsupported criteria or
unavailable measurements can fall back to self-report, labeled `honor_system`;
those labels must be distinguished from measured outcomes.

## Project status

The current implementation includes world-state observations, action checks,
task queues, loop guards, completion checks, and an evaluation workflow. These
components support a working Minecraft agent. Development combines implementation,
controlled experiments, and inspection of failure cases.

With the model held fixed, I evaluated 13 tasks across four replicates and seven
harness configurations. The primary set contains 356 scored attempts. The two
whole-harness configurations account for 103 of them:

| Configuration | Attempts | Verified success | False completion |
|---|---:|---:|---:|
| Full harness | 52 | 35/52 (67.3%) | 2/52 (3.8%) |
| Harness components disabled | 51 | 15/51 (29.4%) | 23/51 (45.1%) |

False completion means the agent reported success but the scorer found the
criterion unmet. Rates use all attempts in each row. This compares configurations
of this fork, not stock Mindcraft; player-safety mechanisms and the external
scorer remain enabled. Individual ablations did not establish the planned
per-component effects.

Current limits:

- **Limited evaluation scope.** One model, one world, and a small task family with
  fixed starting kits do not establish general long-horizon or robotics capability.
- **Limited verification coverage.** Checks cover supported criteria. Scorer
  calibration was mostly inventory-based and included a platform disagreement.
- **Experimental deviations.** The analysis reports a 15.0% infrastructure-fault
  discard rate, unequal samples, and a failed position reset. Eight zero-step
  timeouts remain counted as failures.
- **Data availability.** The [public dataset card](https://huggingface.co/datasets/Appendix0/pincercraft-say-do-gap)
  describes an earlier pilot. It should not be treated as the complete data for
  the evaluation above; the populated SQLite ledger is not included in a clone.

The [full results](docs/paper/results.md) document the analysis and limitations.
With an existing ledger, regenerate the summary using:

```bash
PINCER_EVAL_DB=/path/to/pincercraft_evals.db python3 eval/campaign_report.py
```

This analyzes collected data. Running new experiments requires the additional
server, MCP, and ledger setup in the [runbook](docs/paper/runbook.md).
Use [issues](https://github.com/appendix0/pincercraft/issues) for bugs and proposals.

## Contributing

Keep changes focused and include reproduction steps for bugs. Report the code
revision, relevant configuration with secrets removed, the task, and the observed
outcome. For evaluation changes, include the completion criteria and how the
result was checked.

Run the relevant checks in [test/](test/) or [eval/](eval/) and include the commands
and results with your change. Keep credentials and private server data out of
contributions.

## License and acknowledgments

[MIT](LICENSE), retaining the upstream Mindcraft license.

[Mindcraft](https://github.com/mindcraft-bots/mindcraft) provides the underlying
LLM–Minecraft integration through [Mineflayer](https://github.com/PrismarineJS/mineflayer).
[Voyager](https://voyager.minedojo.org/) influenced the open-ended agent direction
and labeled observation format.

README layout follows [MEMEX](https://github.com/appendix0/Memex), adapted from
[Best-README-Template](https://github.com/othneildrew/Best-README-Template).
