# PincerCraft Changelog

## 2026-05-18 — Overnight build: phases B → I

The Daedelus404 bot becomes a Claude-Code-style agent. Phases A and 1
landed on 2026-05-17; everything below shipped in one autonomous overnight
session driven by a `/loop` task list (21 tasks, see commit log).

### Phase B — Tool metadata standardization
- `isReadOnly`, `isConcurrencySafe`, `prompt(ctx)`, and `checkPermissions`
  are now per-command hooks. Queries default to both safety flags via a
  one-line post-list loop; actions are tagged inline.
- The old hardcoded `SIDE_CHAT_SAFE_COMMANDS` Set is gone — adding a new
  safe command no longer requires touching `classify_and_gate.js`.

### Phase C — Plan Mode
- `!enterPlanMode` / `!exitPlanMode` commands plus a body-touching gate
  inside `executeCommand`. Plan-mode renders the task queue with a
  `(PLAN MODE — awaiting player approval)` header.
- Auto-trigger on task-request classifier; auto-exit on short approval
  replies (`ok`, `yes`, `go`, `lgtm`, `ship it`, …). Stale-plan ping
  after 10 minutes.

### Phase D — Smart pathfinding primitives
- `smartGoTo` — tier-1 default → tier-2 canDig (with auto-equipped
  best pickaxe) → tier-3 canDig + 1x1 towers/bridges.
- `smartGather` — composes find + smartGoTo + collectBlock with tool-tier
  escalation per a block→tool hint table (axes for logs, shovels for
  dirt/sand, the right pickaxe tier for ores including deepslate variants).
- `smartBuildAt` — aggregates material requirements, smartGathers any
  missing, then places.
- `!goToCoordinates` and `!collectBlocks` rebound to the smart versions.

### Phase E + H7 — `stuck` meta-skill
- `PATH_FAILURE_NUDGE` deleted; the tripwire counter now auto-invokes the
  `stuck` meta-skill. Trip 1: re-frame via `!newAction`. Trip 2 on the
  same task: `!cancelTask` + ping the player.

### Phase F — Memory unification + layers
- Legacy `saving_memory` summarizer is dormant — its output no longer
  reaches `$MEMORY`.
- `!remember` content goes through JSON-style escape parsing and
  CRLF/whitespace normalization.
- Summary truncation is now word-boundary aware.
- New layered memory: `memory/server/*.md` (shared across all bots) +
  `memory/players/<player>.md` (per-player). `$MEMORY` concatenates
  server + bot + active-player layers with section headers.

### Phase G — Coordinator
- `!dispatchAgent(role, description, end_factor)` routes focused work to
  a role-specific subagent. Roles: miner / builder / navigator / scout,
  each with its own profile in `profiles/roles/<role>.json` (tight
  system prompt + Sonnet model).
- Per-subagent model routing: `Prompter._modelForActiveTurn()` lazy-
  creates and caches the role's model. `daedelus404.json` also sets
  `code_model: claude-sonnet-4-6` so every `!newAction` already uses
  the action model.
- `!setSubagentSummary` / `!setSubagentResult` let the subagent shape
  its own `[subagent finished]` report.
- `!sendMessage` for fire-and-forget bot-to-bot signaling.

### Phase H — Skill registry
- `/init`, `/review`, `/explore`, `/sleep`, `/restock` player slash
  skills (Bedrock players use `!!` as the alias prefix). Each composes
  the right `!addTask` + `!newAction` chain.
- `stuck`, `loop`, `verify` meta-skills are bot-self-invokable via
  `!invokeSkill`.
- Authorization reuses `settings.only_chat_with` so strangers can't
  dispatch slash skills.

### Phase I — Permissions + MCP server mode
- New `src/agent/permissions.js` enforces per-player allow/deny rules
  with glob patterns. `executeCommand` checks permissions first, before
  the plan-mode gate, so denials short-circuit cleanly.
- `src/mcp_server.js` exposes a curated set of bot tools as MCP tools
  via JSON-RPC 2.0 over HTTP — `say`, `read_stats`, `read_inventory`,
  `read_nearby_blocks`, `mine_block`, `go_to_coords`, `go_to_player`,
  `add_task`, `show_queue`, `invoke_skill`, `dispatch_agent`,
  `run_raw_command`. External agents appear as the synthetic player
  `mcp` for permission purposes.

### What didn't ship
- No tests were added — the user's Anthropic API was rate-limited at
  build time, so live-server verification wasn't possible. Static
  syntax checks (`node --check`) confirm every changed file parses.
- The blueprint's earlier note about deleting the path-failure regex
  classifier itself wasn't taken — the deterministic detector now
  acts as the safety-net trigger for `stuck` instead of being a
  duplicate of the LLM's prompt rules.
