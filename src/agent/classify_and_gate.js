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

const TASK_REQUEST_VERBS = /\b(mine|craft|build|make|get|bring|fetch|give|smelt|gather|find|collect|hand|deliver|cook|grab|harvest|chop|dig)\b/i;
const MEMORY_REQUEST_PATTERNS = /\b(remember|don'?t forget|note that|save (this|that)|from now on|always|never|keep in mind|my name is|i (like|prefer|hate|live|work))\b/i;

export const TASK_REQUEST_NUDGE = '[task request detected] Your first action this turn MUST be one or more !addTask(description, end_factor) calls — one per step, in execution order, including the final "tell the player" step. Only AFTER all !addTask calls may you execute the first task. Do not call any other command first.';
export const MEMORY_REQUEST_NUDGE = '[memory cue detected] This message contains a fact worth keeping across sessions. Call !remember(topic, content) with a kebab-case topic slug — either now, or as the first step of your plan if you also have a task to do. Do not skip this. For exact coordinates use !rememberHere instead.';

export function detectTaskRequest(message) {
    if (!message || message.length < 4) return false;
    return TASK_REQUEST_VERBS.test(message);
}

export function detectMemoryRequest(message) {
    if (!message || message.length < 4) return false;
    return MEMORY_REQUEST_PATTERNS.test(message);
}

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
// ----------------------------------------------------------------------------

export const SIDE_CHAT_SAFE_COMMANDS = new Set([
    '!remember', '!rememberHere', '!forget', '!recall', '!listMemory',
    '!addTask', '!cancelTask', '!showQueue', '!clearDoneTasks',
    '!setMode', '!loadCOCFromLectern', '!designateRulebookLectern',
    // !stop is body-affecting BY DESIGN — its purpose is to halt the running
    // body action. Allowed in side-chat so the LLM can act on ambiguous halt
    // intent the regex classifier misses (e.g. "Hey stop what you are doing").
    // Pairs with the HALT INTENT rule in the conversing prompt.
    '!stop',
]);

export function isSafeSideChatCommand(cmdName) {
    return SIDE_CHAT_SAFE_COMMANDS.has(cmdName);
}

// ----------------------------------------------------------------------------
// 4. Post-execution path-failure classifier — runs on each command's result.
//    After 2 consecutive primitives that returned a path-failure pattern,
//    inject a system nudge forcing the model to escalate to !newAction or
//    !cancelTask. Phase E's `stuck` meta-skill replaces this.
// ----------------------------------------------------------------------------

const PATH_FAILURE_PATTERNS = /(Path not found|Unable to reach|Took to long to decide path|Pathfinding stopped|Cannot break .* with current tools|Don'?t have right tools to break|Could not find any .* in \d+ blocks|Dug down 0 blocks)/i;

export const PATH_FAILURE_NUDGE = (n) => `[pathfinding stuck — ${n} consecutive failures] Your next action MUST be !newAction(detailed_prompt) with a multi-step plan that handles the obstacle (dig stairs through stone, bridge water with cobblestone, tower up with dirt). Be specific about materials and target coords. If no such plan is possible, call !cancelTask and tell the player you're stuck. Chaining another primitive will not work.`;

export function isPathFailure(execute_res) {
    if (!execute_res || typeof execute_res !== 'string') return false;
    return PATH_FAILURE_PATTERNS.test(execute_res);
}
