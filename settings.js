import fs from 'node:fs';

// Eval campaigns must not run in the owner's live world. Over a long campaign
// the trees felled and stone mined near spawn accumulate, so a later arm faces
// a measurably poorer world than an earlier one and world depletion is
// confounded with the condition under test (docs/paper/preregistration.md §7).
// The runner drops .runtime/target.json to point the bot at the dedicated eval
// server and clears it on exit. Absent — which is the normal case, including
// every watcher-spawned session — the bot joins YOON exactly as before.
// Resolved against this file, not cwd, since systemd and the runner differ.
const target = (() => {
    let raw;
    try {
        raw = fs.readFileSync(new URL('./.runtime/target.json', import.meta.url), 'utf8');
    } catch { return {}; }          // absent: normal play, join YOON
    try {
        return JSON.parse(raw);
    } catch (e) {
        // Present but unparseable means a redirect was intended and did not
        // take. Defaulting to YOON here would quietly run a campaign in the
        // owner's live world, so fail loudly instead of failing "safe".
        throw new Error(`.runtime/target.json present but unparseable (${e.message}) — refusing to start`);
    }
})();

const settings = {
    // PincerCraft TS runs the same Paper 1.21.11 as YOON, so switching targets
    // needs no version flip.
    "minecraft_version": "1.21.11",
    "host": target.host || "127.0.0.1",
    "port": target.port || 25565, // YOON Java port. v2 orchestrator validated end-to-end 2026-05-25 on Claude (Haiku planner + Sonnet coder) — tool-use protocol, decomposition gates, prompt caching all green.
    "auth": "microsoft", // device-code flow with PinBench1502 MS account (owns Java)

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": false, // headless server, no browser

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./profiles/daedelus404.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": true, // bot remembers prior sessions (memory.json persists)
    "wipe_queue_on_start": true, // clear the task queue (tasks.json) on every restart so stale tasks don't auto-resume. Durable memory (places + facts) is KEPT and compacted at boot — Claude-Code style.
    "keep_in_progress_task_on_restart": true, // C1 (2026-06-06): when wiping the queue, SPARE the single in_progress task so an involuntary crash/disconnect restart resumes the interrupted work instead of losing it. Pending/done are still dropped. Set false to restore the old full-wipe behavior.
    "init_message": null, // upstream Mindcraft default was "Respond with hello world and your name" — we now use the reboot-context greeting in agent.js instead (queue-aware: "Online and ready" / "Back online, was working on X / picking it up")
    "only_chat_with": ["LosPollos929"], // Floodgate strips its `.` prefix before mineflayer sees the username

    // Phase I1: per-player command permission rules. The chat filter above
    // (only_chat_with) decides who the bot LISTENS to; this map decides what
    // each listener can MAKE THE BOT DO. Two layers, not duplicates.
    //
    // Pattern syntax: '!exact' exact match, '!prefix*' suffix wildcard,
    // '!*' or '*' for all commands. deny wins over allow.
    //
    // Missing player + missing '*' fallback → default deny. Set "*" with
    // a permissive allow list if you want strangers to drive the bot.
    "permissions": {
        "LosPollos929": { "allow": ["!*"] },
        // 2026-05-25: the eval loop drives the bot as synthetic player 'mcp'.
        // Scoped to task-injection + read-only grounding; queued tasks then
        // execute under the agent's own authority, not mcp's.
        "mcp": { "allow": ["!addTask", "!showQueue", "!stats", "!inventory", "!nearbyBlocks", "!cancelTask", "!finishTask", "!dispatchAgent", "!invokeSkill"] }
    },

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // enabled 2026-05-11 — Claude can write/run JS via !newAction. Required for any complex non-trivial task (building structures, custom multi-step logic). Bot runs as user `ubuntu` so cannot touch root-owned YOON files; iptables not modifiable without sudo.
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : [] , // Step 2 prune removed the 5 commands previously listed here (blueprint quartet + !restart) — they no longer exist to block. Re-add command names here to block them at runtime.
    "code_timeout_mins": 5, // C3 (2026-06-06): minutes a single !newAction may run before the action manager forces a stop. Was -1 (no timeout) — a hung action then only ended via an external preempt → stop()-spin → cleanKill (full process exit → disconnect → restart). A finite cap converts most hangs into a clean "timed out" return to the orchestrator. 5min is generous for one action; long builds are chunked into subtasks by the orchestrator, so no single action should need more.
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context (legacy summarizer; slated for Phase F removal)
    "compaction_threshold_tokens": 3000, // Phase A4: when turns array exceeds this many estimated tokens, compact older turns into one system message
    "compaction_keep_recent": 8, // Phase A4: how many most-recent turns to preserve uncompacted
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "none", // chat shows only the LLM's prose, never the command syntax. The model speaks naturally about what it's doing.
    "narrate_behavior": false, // suppress mode chatter ("I'm stuck!", "I'm free.", "Picking up item!", "Hunting ...!"). The internal behavior_log still records them for the LLM.
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 300, // 5min — first-time MS device-code auth needs time
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.

    // Phase I2: MCP server mode. When enabled, the bot exposes a curated set
    // of its commands as MCP tools via JSON-RPC 2.0 over HTTP on `mcp.port`.
    // Auth: if `mcp.token` is set, clients must send Authorization: Bearer <token>.
    // The synthetic player name 'mcp' is the source for external invocations,
    // so add an entry to `permissions` (above) if you want to gate them.
    "mcp": {
        "enabled": true, // 2026-05-25: enabled so the eval/ self-improvement loop can inject tasks. Token lives in keys.json (mcp_token).
        "host": "127.0.0.1",
        "port": 8765,
        "token": null
    },

    // Phase D5: Movements tuning. The smart primitives in src/agent/library/
    // skills.js own their own Movements escalation now (tier 1 default →
    // tier 2 canDig with auto-equipped pickaxe → tier 3 canDig+towers with
    // inventory scaffold blocks). There is no global Movements config — each
    // smart primitive constructs the right Movements for its tier. If you
    // need stricter behavior (e.g. ban dig on a peaceful server), edit
    // smartGoTo's tier1/tier2/tier3 directly.
    "log_all_prompts": false, // log ALL prompts to file

    // v2 Step 1: Resilience wrapper. Provider-neutral sliding-window RPM
    // throttle + 429 retry-with-backoff (honors Retry-After). When ON,
    // each src/models/<provider>.js routes API calls through
    // src/models/rate_limited_client.js. See docs/agent-blueprint.md §3 Step 1.
    "use_rate_limit_wrapper": true,
    "rate_limit": {
        "anthropic": { "rpm": 50 },  // Sonnet 4.6 paid tier baseline
        "nvidia":    { "rpm": 30 },  // NVIDIA Build docs say 40 but real-world bursts trip 429 at 35+; conservative
        "openai":    { "rpm": 60 },
        "retry_max_attempts": 5,     // bumped from 3 — observed nvidia 429 storms exceed 4 attempts
        "backoff_max_seconds": 60    // bumped from 30 — Retry-After headers up to 45s seen in wild
    },

    // v2 Step 3: Tool-use protocol. When ON, planner turns route through
    // sendRequestWithTools (structured tools[] + tool_use/tool_result blocks)
    // instead of the legacy text-parsing path. Default OFF — Step 4's
    // orchestrator depends on this; flip ON once orchestrator_v2 lands.
    // See docs/agent-blueprint.md §3 Step 3.
    "use_tool_use_protocol": true,

    // v2 Step 4: Event-driven orchestrator. When ON (and
    // use_tool_use_protocol is also ON), agent._processInput delegates to
    // OrchestratorV2.handleEvent instead of the legacy for(i<max_responses)
    // loop. The orchestrator parks on no-toolCalls; runs Promise.all on
    // isConcurrencySafe tools; plan mode = single-channel tools[] filter.
    // To enable: set BOTH use_orchestrator_v2 AND use_tool_use_protocol to
    // true, then restart the bot. See docs/agent-blueprint.md §3 Step 4.
    "use_orchestrator_v2": true,

    // v2 Step 5: Background tool handles. When ON (and use_orchestrator_v2
    // is on), isLongRunning tools spawn via BackgroundTasks and return a
    // handle immediately; orchestrator threads completion back as a
    // bg_complete event. Required for mode interrupts to cancel without
    // crashing. See docs/agent-blueprint.md §3 Step 5.
    "use_background_handles": false,

    // v2 Step 6: Subagent context isolation. When ON, !dispatchAgent stores
    // the role's tools_filter on agent.activeSubagent; the orchestrator's
    // activeTools() then narrows the tool surface to the role's lane. Full
    // child-history isolation (createChildSubagentContext) is deferred —
    // the tools-filter alone is the load-bearing piece for confabulation
    // reduction. See docs/agent-blueprint.md §3 Step 6.
    "use_subagent_isolation": false,
};

export default settings;
