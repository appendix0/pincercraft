# Current implementation guide

This guide describes the checked-in configuration and source reviewed on 2026-10-11. It accompanies the [README](../README.md). The [May agent blueprint](agent-blueprint.md) preserves the earlier design plan; its proposed defaults and completion targets are not a statement of the current runtime.

## From task to action

1. The bot receives a player message or an execution event. Player chat and command access are configured through `only_chat_with` and `permissions` in [settings.js](../settings.js).
2. With `use_orchestrator_v2` and `use_tool_use_protocol` enabled, the [orchestrator](../src/agent/orchestrator_v2.js) coordinates model turns and structured tool calls. The [live-state block](../src/agent/live_state.js) supplies observations such as inventory and supported task-progress information.
3. The LLM plans and chooses actions. The [prompter](../src/models/prompter.js) also invokes the coding model for generated actions. If a profile omits `code_model`, it uses the chat model for coding.
4. The [task queue](../src/agent/task_queue.js), [action manager](../src/agent/action_manager.js), and [modes](../src/agent/modes.js) manage work and interruptions. Preconditions and completion checks cover particular supported actions and task criteria; they do not validate every possible plan.

## Two different completion checks

The bot-side [verification code](../src/agent/verify.js) parses supported inventory criteria: absolute counts, gains or losses relative to the start, and sets of required items. Unknown criteria can return `programmatic: false`. A check being implemented in code does not make every task measurable.

The external [evaluation scorer](../eval/referee.mjs) takes its own measurements. It shares the inventory-criterion parser with the bot, and can use [blockscan.py](../eval/blockscan.py) for supported square-platform criteria. Unsupported criteria, missing snapshots, or unavailable measurements can fall back to the reported task outcome with `label_source: honor_system`. Analysis must distinguish those labels from scorer-measured outcomes.

The experiment’s [harness switches](../src/agent/harness_mode.js) control perception additions, preconditions, reflexes, bot-side completion verification, and automatic task termination. The external scorer remains enabled when those components are disabled. Player-safety mechanisms also remain enabled. The comparison is between configurations of this fork.

## Configuration boundaries

The checked-in [settings](../settings.js) enable the rate-limit wrapper, tool-use protocol, and v2 orchestrator. They disable `use_background_handles` and `use_subagent_isolation`. The historical blueprint’s proposed background execution and context-isolation behavior should not be inferred from the presence of those source files.

The starter [Claude profile](../profiles/claude.json) selects Claude Sonnet 4.6 and OpenAI embeddings. The prompter uses that embedding selection separately from the chat/coding model. Configure the corresponding credentials when using the profile unchanged.

The supplied settings contain development-bot and player configuration. They also enable MCP and `allow_insecure_coding`; the README explains what to review for a new instance. Generated JavaScript execution is a runtime capability, not evidence that the harness is an operating-system security boundary.

## Evaluation records

[eval_db.py](../eval/eval_db.py) defines the local SQLite ledger and its `PINCER_EVAL_DB` override. [campaign_report.py](../eval/campaign_report.py) analyzes existing attempts and applies recorded exclusions; it does not collect a new experiment. A fresh clone has no populated ledger.

The [results](paper/results.md) document the existing 356-attempt primary set, exclusions, calibration limits, and experimental deviations. The [runbook](paper/runbook.md) documents collection. The reported experiment provides evidence for that task set; it does not establish general long-horizon reliability.
