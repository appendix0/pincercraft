// Phase A5: single home for the input/output classifiers + gating rules that
// the orchestrator consults. Previously these were five scattered blocks at the
// top of agent.js + a tiny input_router module; co-locating them here makes the
// orchestrator contract (blueprint §6.5 item 3) explicit and gives Phases B/C/D
// one place to extend when adding new gates.
//
// Logic intentionally unchanged from the pre-refactor sites — this is a move,
// not a rewrite. Any behavior change here should be its own commit.

// ----------------------------------------------------------------------------
// 1. Input classification (interrupt vs followup) — runs at enqueue time.
// ----------------------------------------------------------------------------

const INTERRUPT_COMMANDS = ['!stop', '!halt', '!cancel'];
// Natural-language stop intents. Word-boundary so "stopped by the lake" or
// "I waited an hour" don't trigger. Matched on the full lowercased message.
const INTERRUPT_PHRASES = /\b(stop everything|stop please|stop now|please stop|just stop|halt|abort|cancel that|nevermind|never mind|hold on|hold up|pause that)\b/i;
// Standalone single-word stops must start the message: "stop", "stop.", "wait!"
const STANDALONE_STOP = /^(stop|wait|pause|cancel)\b/i;

export function isPureStopMessage(message) {
    const msg = (message || '').trim().toLowerCase();
    return INTERRUPT_COMMANDS.includes(msg);
}

export function classifyInput(input) {
    // Critical game events (low health, on fire, drowning) — life-threatening,
    // drop everything.
    if (input.kind === 'game_event_critical') return 'interrupt';

    // Mode-driven auto-reprompts: self_preservation is the only critical mode
    // in Phase 1. Other modes (e.g. item_collecting, hunting) auto-reprompt
    // as a normal followup.
    if (input.kind === 'mode_auto' && input.mode_name === 'self_preservation') {
        return 'interrupt';
    }

    // Player typed an explicit stop command or a natural-language stop intent.
    const msg = (input.message || '').toLowerCase();
    if (INTERRUPT_COMMANDS.some(kw => msg.includes(kw))) return 'interrupt';
    if (INTERRUPT_PHRASES.test(msg)) return 'interrupt';
    if (STANDALONE_STOP.test(msg.trim())) return 'interrupt';

    return 'followup';
}

// ----------------------------------------------------------------------------
// 2. Pre-LLM Lever-2 nudges — run on the player's message before the model
//    sees it. Re-assert prompt rules Haiku tends to drop under load. False
//    positives are cheap (the nudge just re-states a rule the model already has).
//    Phase E will replace these with smarter LLM-led handling, per
//    feedback_pincercraft_llm_led_smarts.
// ----------------------------------------------------------------------------

// Original (too-broad) verb match kept as a low signal — any of these means
// "could be a task", but plan-mode auto-entry needs more. Most one-verb player
// requests like "give me logs" / "come here" / "tp" / "follow" should execute
// directly, not stall the bot waiting for plan approval.
const TASK_REQUEST_VERBS = /\b(mine|craft|build|make|get|bring|fetch|give|smelt|gather|find|collect|hand|deliver|cook|grab|harvest|chop|dig)\b/i;

// Strong signals that the player actually wants a multi-step plan:
//   - explicit multi-step verbs (build, set up, make a complete X)
//   - quantities ≥ 5 of a thing ("mine 10 iron", "craft 32 sticks")
//   - multiple comma/and-joined goals ("mine iron and craft a pickaxe")
//   - explicit "plan", "step by step", "list", "first … then"
const COMPLEXITY_PATTERNS = [
    /\b(build|construct|set up|setup|automate|farm|grind)\b/i,            // multi-block / large goals
    /\b(\d{2,}|[5-9])\s+\w+/i,                                            // quantity ≥ 5 (10 iron, 5 wood)
    /\b(then|after that|next|finally|step by step|step-by-step|first .* then|make a plan|plan it out|list the steps)\b/i,
    /,.+(and|then)/i,                                                     // "X, then Y" / "X, and Y"
    /\band\s+(also\s+)?(mine|craft|build|make|get|bring|fetch|give|smelt|gather|find|collect)\b/i, // chained verbs
];

const MEMORY_REQUEST_PATTERNS = /\b(remember|don'?t forget|note that|save (this|that)|from now on|always|never|keep in mind|my name is|i (like|prefer|hate|live|work)|every time|each time|going forward|next time)\b/i;

export const TASK_REQUEST_NUDGE = '[task request detected] Your first action this turn MUST be one or more !addTask(description, end_factor) calls — one per step, in execution order, including the final "tell the player" step. Only AFTER all !addTask calls may you execute the first task. Do not call any other command first.';
export const MEMORY_REQUEST_NUDGE = '[memory cue detected] This message contains a fact worth keeping across sessions. Call !remember(topic, content) with a kebab-case topic slug — either now, or as the first step of your plan if you also have a task to do. Do not skip this. For exact coordinates use !rememberHere instead.';

// Strong multi-step verbs ("build", "set up", "automate", "construct") imply
// a plan all by themselves — no additional complexity signal needed.
const MULTI_STEP_VERBS = /\b(build|construct|set up|setup|automate|farm)\b/i;

// Plan mode is for genuinely complex multi-step work. A one-verb request
// like "give me logs" or "come here" doesn't need a written plan + player
// approval cycle — it stalls the bot and creates dead time. We require
// EITHER a strong multi-step verb OR (any task verb + a complexity signal).
export function detectTaskRequest(message) {
    if (!message || message.length < 4) return false;
    if (MULTI_STEP_VERBS.test(message)) return true;
    if (!TASK_REQUEST_VERBS.test(message)) return false;
    return COMPLEXITY_PATTERNS.some(re => re.test(message));
}

export function detectMemoryRequest(message) {
    if (!message || message.length < 4) return false;
    return MEMORY_REQUEST_PATTERNS.test(message);
}

// Phase C2: plan-mode approval / rejection detection. Used by the orchestrator
// to auto-exit plan mode when the player gives a clear yes/no on the proposed
// plan. Bias is toward "no auto-action on ambiguous input" — the patterns
// match short standalone replies (the way real players approve plans), not
// substrings inside a longer sentence. The LLM also handles ambiguous cases
// via prompt rules; this is a deterministic safety net.
const PLAN_APPROVAL_WORDS = [
    'yes', 'yep', 'yeah', 'ya', 'y',
    'ok', 'okay', 'k',
    'sure', 'fine', 'great', 'good',
    'go', 'go ahead', 'do it', "let's go", 'lets go',
    'approve', 'approved', 'accept', 'accepted',
    'sounds good', 'looks good', 'lgtm', 'ship it',
    'start', 'begin', 'execute', 'run it', 'do the plan',
    'proceed', 'continue',
];
const PLAN_REJECTION_WORDS = [
    'no', 'nope', 'nah',
    'cancel', 'stop', 'wait', 'hold on', 'pause',
    'nevermind', 'never mind',
    'change', 'revise', 'edit', 'redo',
    "don't", 'dont', 'reject', 'rejected',
];

function matchesShortReply(words, message) {
    if (!message) return false;
    // Strip trailing punctuation/emoji whitespace so "ok!" / "yes." still match.
    const m = message.trim().toLowerCase().replace(/[.!?,]+$/, '').trim();
    if (m.length === 0 || m.length > 40) return false; // approvals are short
    return words.some(w => m === w || m.startsWith(w + ' ') || m.startsWith(w + ','));
}

export function detectPlanApproval(message) {
    return matchesShortReply(PLAN_APPROVAL_WORDS, message);
}

export function detectPlanRejection(message) {
    return matchesShortReply(PLAN_REJECTION_WORDS, message);
}

export const PLAN_MODE_AUTO_NUDGE = '[plan mode auto-entered] The player asked for a multi-step task and you are now in plan mode. Your job this turn: (1) !addTask(description, end_factor) for every step including the final "tell the player" step, in execution order. (2) Post the full plan to chat as a numbered list so the player can review. (3) Stop. Do NOT execute any body-touching command — the gate will reject it. Wait for the player to say "ok"/"yes"/"go" — that auto-exits plan mode and starts task #1. If the player asks for changes, !cancelTask the bad steps and !addTask the new ones.';
export const PLAN_APPROVED_NUDGE = '[plan approved] The player approved your plan. Plan mode is now off and the first pending task has been auto-started. Execute it.';
export const PLAN_REJECTED_NUDGE = '[plan rejected] The player wants changes. Plan mode is now off. Listen to what they want, then either revise the queue (!cancelTask the bad steps, !addTask the new ones, !enterPlanMode again to confirm) or just respond and wait for direction.';

// Convenience: returns the list of nudge strings to inject as system messages
// before the next LLM turn. Skip when from a self-prompt or another bot —
// those messages don't carry player intent.
export function nudgesForUserMessage(message, { self_prompt = false, from_other_bot = false } = {}) {
    if (self_prompt || from_other_bot) return [];
    const out = [];
    if (detectTaskRequest(message)) out.push(TASK_REQUEST_NUDGE);
    if (detectMemoryRequest(message)) out.push(MEMORY_REQUEST_NUDGE);
    return out;
}

// ----------------------------------------------------------------------------
// 3. Side-chat command gating — runs per parsed command in the mid-task chat
//    path. Body-touching commands are deferred until the running task ends;
//    non-body commands (memory, queue, mode) execute in parallel.
//
// Phase B1+B2: each command now carries its own `isConcurrencySafe` flag
// (boolean or `(args) => boolean`) defined alongside the command itself in
// actions.js / queries.js. We resolve that flag here. The old hardcoded
// SIDE_CHAT_SAFE_COMMANDS Set is gone — adding a new safe command no longer
// requires touching this file.
// ----------------------------------------------------------------------------

// Resolve a per-command flag that may be a boolean or a function of args.
function resolveFlag(flag, args) {
    if (typeof flag === 'function') return !!flag(args ?? []);
    return !!flag;
}

// Phase B / C / I check: pure observation, can run in plan mode, never needs
// a permission prompt. Pass the command object (from getCommand(name)).
export function isReadOnlyCommand(cmd, args = []) {
    if (!cmd) return false;
    return resolveFlag(cmd.isReadOnly, args);
}

// Phase A/B check: command does not touch the bot's body and can be executed
// in parallel with a running task. Used by the side-chat dispatch path.
// !stop is body-affecting BY DESIGN — its purpose is to halt the running
// body action. Marking it concurrency-safe in actions.js lets the LLM act on
// ambiguous halt intent the regex classifier misses (e.g. "Hey stop what you
// are doing"). Pairs with the HALT INTENT rule in the conversing prompt.
export function isSafeSideChatCommand(cmd, args = []) {
    if (!cmd) return false;
    return resolveFlag(cmd.isConcurrencySafe, args);
}

// ----------------------------------------------------------------------------
// 4. Post-execution path-failure classifier — runs on each command's result.
//    After 2 consecutive primitives that returned a path-failure pattern,
//    inject a system nudge forcing the model to escalate to !newAction or
//    !cancelTask. Phase E's `stuck` meta-skill replaces this.
// ----------------------------------------------------------------------------

// Phase E/H7: this stays as the tripwire detector. The *response* used to be
// a direct PATH_FAILURE_NUDGE injection (Phase 1's Lever-2); now it triggers
// the 'stuck' meta-skill, which owns the escalation script. The old NUDGE
// export has been removed — every previous caller goes through invokeMetaSkill
// instead.
const PATH_FAILURE_PATTERNS = /(Path not found|Unable to reach|Took to long to decide path|Pathfinding stopped|Cannot break .* with current tools|Don'?t have right tools to break|Could not find any .* in \d+ blocks|Dug down 0 blocks)/i;

export function isPathFailure(execute_res) {
    if (!execute_res || typeof execute_res !== 'string') return false;
    return PATH_FAILURE_PATTERNS.test(execute_res);
}

// ----------------------------------------------------------------------------
// 5. !newAction tool-availability gate — runs on the prompt arg before the
//    Coder is invoked. Catches the failure mode where the planner names a
//    tool ("dig with iron_pickaxe") that isn't in the bot's inventory.
//    Saves a wasted Coder turn + pathfinder timeout on a doomed plan.
//    Phase D `smartGoTo`/`smartGather` will eventually subsume this by making
//    tool selection internal to the tool, but until then the deterministic
//    check is the cheapest belt to the planner prompt's suspenders.
// ----------------------------------------------------------------------------

const TOOL_KEYWORDS = [
    'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'golden_pickaxe', 'netherite_pickaxe',
    'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe', 'golden_axe', 'netherite_axe',
    'wooden_shovel', 'stone_shovel', 'iron_shovel', 'diamond_shovel', 'golden_shovel', 'netherite_shovel',
    'wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword', 'golden_sword', 'netherite_sword',
    'wooden_hoe', 'stone_hoe', 'iron_hoe', 'diamond_hoe', 'golden_hoe', 'netherite_hoe',
    'shears', 'fishing_rod', 'flint_and_steel', 'shield',
];

export function findMissingToolsInPrompt(promptText, inventoryItems) {
    if (!promptText || typeof promptText !== 'string') return [];
    const lower = promptText.toLowerCase();
    const have = new Set((inventoryItems || []).map(it => it?.name).filter(Boolean));
    const missing = new Set();
    for (const tool of TOOL_KEYWORDS) {
        // Word-boundary match so "iron_ingot" doesn't trigger "iron_pickaxe" etc.
        const re = new RegExp(`\\b${tool}\\b`, 'i');
        if (re.test(lower) && !have.has(tool)) missing.add(tool);
    }
    return Array.from(missing);
}

export const MISSING_TOOL_REJECT = (missing) => `[tool check failed] Your !newAction prompt named ${missing.join(', ')} but $INVENTORY has none of these. The Coder cannot equip a tool you don't have, and pathfinder will time out trying to break blocks. DO NOT retry with the same plan. Choose ONE: (1) !cancelTask, then !addTask to craft ${missing[0]} (with any prerequisite tier — stone needs wooden_pickaxe, iron_ore needs stone_pickaxe, diamond_ore needs iron_pickaxe), then re-add the original mine task at the end. (2) Rewrite !newAction to only use tools currently in $INVENTORY.`;
