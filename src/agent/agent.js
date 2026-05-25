import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands, findAllCommandSpans, getCommand } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { RunQueue } from './run_queue.js';
import { humanizeCommand } from './command_humanizer.js';
import { TaskQueue } from './task_queue.js';
import { MemoryStore } from './memory_store.js';
import { RulebookLectern } from './rulebook_lectern.js';
// Phase A5: classifier + gating logic lives in one module. Previously scattered
// at the top of this file + a small input_router module.
import {
    classifyInput,
    nudgesForUserMessage,
    isSafeSideChatCommand,
    isPathFailure,
    detectTaskRequest,
    detectPlanRequest,
    detectPlanApproval,
    detectPlanRejection,
    estimateTaskSize,
    SIZE_DECOMP_THRESHOLD,
    THIN_DECOMPOSITION_NUDGE,
    PLAN_MODE_AUTO_NUDGE,
    PLAN_APPROVED_NUDGE,
    PLAN_REJECTED_NUDGE,
} from './classify_and_gate.js';
// Phase H1: player slash-commands ( /init, /review, !!init ) dispatch through
// a registry instead of going to the LLM. Skill bodies register themselves
// against this module.
import { dispatchSlashCommand, parseSlashCommand, invokeMetaSkill } from './slash_skills.js';
// Phase G1+G2: role-based subagent runtime. !dispatchAgent routes through this.
import { dispatchSubagent, finalizeSubagent, listRoles } from './subagent.js';
// Phase I2: optional MCP server mode. Disabled by default — toggle via settings.mcp.enabled.
import { startMcpServer } from '../mcp_server.js';
// v2 Step 4-6 integration. Standalone modules become live when the
// use_orchestrator_v2 flag is on. Default OFF — legacy for-loop path
// in _processInput stays the production path until the flag flips.
import { OrchestratorV2 } from './orchestrator_v2.js';
import { BackgroundTasks } from './background_tasks.js';
import { neutralToAnthropic, neutralToOpenAI } from '../models/tool_protocol.js';
import { rateLimitEvents } from '../models/rate_limited_client.js';
import { getRegistry } from './tool_registry.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        // Phase C1: plan mode is OFF at boot. While on, body-touching commands
        // are blocked by the gate in commands/index.js executeCommand; only
        // readOnly + concurrency-safe commands (observations, memory, queue
        // mutations, chat-only) run. Toggled via !enterPlanMode / !exitPlanMode
        // — Phase C2 wires the auto-trigger on task-request classifier.
        this.planMode = false;

        // Side-chat deferral tracker. When a player message arrives mid-task
        // and the bot replies with a canned "let me finish" because all the
        // commands it picked were body-touching (deferred), we record the
        // pending follow-up here. On the next task finish, _onQueueChange
        // injects a synthetic system input so the LLM addresses the question
        // instead of leaving the player hanging silently.
        // Dedup'd by target so repeated chats from the same player coalesce
        // to one follow-up (we answer the latest, not every line).
        this._pendingFollowups = [];

        // Phase 1 action queue: one serial lane, no self-collisions.
        // See docs/queue-design.md.
        this.alive = true;
        this.run_queue = new RunQueue();

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        this.task_queue = new TaskQueue(
            this.name,
            (kind, task) => this._onQueueChange(kind, task),
            () => this.planMode === true,
        );
        this.memory_store = new MemoryStore(this.name);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // v2 Step 4-6 integration. Orchestrator owns the LLM invocation loop
        // when use_orchestrator_v2 is on AND use_tool_use_protocol is on.
        // Background handles + subagent isolation gate on their own flags
        // (which require orchestrator_v2 to be useful).
        this.backgroundTasks = null;
        this.orchestrator = null;
        this.use_background_handles = false;
        if (settings.use_orchestrator_v2 && settings.use_tool_use_protocol) {
            this._initOrchestratorV2();
        } else if (settings.use_orchestrator_v2) {
            console.warn('[v2] use_orchestrator_v2=true but use_tool_use_protocol=false; orchestrator NOT initialized. Set both flags.');
        }

        // Optionally wipe the summary memory before loading so stale task
        // context from a previous session doesn't leak into the new prompt.
        // Doesn't touch tasks.json (the queue) or histories/ (full chat logs).
        if (settings.wipe_memory_on_start) {
            try {
                const fs = await import('fs');
                const memPath = `./bots/${this.name}/memory.json`;
                if (fs.existsSync(memPath)) {
                    fs.unlinkSync(memPath);
                    console.log(`[start] wiped ${memPath} (wipe_memory_on_start=true)`);
                }
            } catch (e) {
                console.warn('[start] memory wipe failed:', e?.message || e);
            }
        }

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log loudly so bot.log shows the cause — previously a null
            // `reason` produced near-empty [LoginGuard] output, which made
            // the exit look like a silent crash.
            const rawDump = (() => {
                if (reason == null) return '(null)';
                try { return typeof reason === 'string' ? reason : JSON.stringify(reason); }
                catch { return String(reason); }
            })();
            console.error(`[disconnect] event=${event} reason=${rawDump}`);
            const { type } = handleDisconnection(this.name, reason);
            console.error(`[disconnect] classified type=${type}, exiting with code 1 (parent will auto-restart after 10s)`);

            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        // Phase I2: MCP server mode (start lazily once the bot is alive but
        // before login — server only needs the agent reference, not the bot
        // session). Disabled by default; set settings.mcp.enabled=true to
        // expose tools on the configured port.
        if (settings.mcp?.enabled && !this._mcpServer) {
            try {
                this._mcpServer = startMcpServer(this, {
                    port: settings.mcp.port ?? 8765,
                    host: settings.mcp.host ?? '127.0.0.1',
                    token: settings.mcp.token ?? null,
                });
            } catch (e) {
                console.warn('[mcp] failed to start:', e?.message || e);
            }
        }

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
                this._runWorker(); // single consumer loop for the action queue
                this._startQueueHeartbeat();
                this._startStuckWatcher();
                this.rulebook_lectern = new RulebookLectern(this);
                this.rulebook_lectern.installListener();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.enqueue({source: username, message: translation, kind: 'player_chat'});
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            this.enqueue({source: 'system', message: init_message, max_responses: 2, kind: 'init'});
        }
        // Always greet players based on queue state. Then, if there's an
        // in-progress task, prompt the LLM to keep going so a reboot
        // mid-task resumes instead of stalling.
        // Rate-limit chat banter: when the bot stalls under a 429 burst,
        // post one chat message so the player knows what's happening; post
        // another when it resumes. Per-session debounce so multiple 429s
        // in a row don't spam chat.
        this._rateLimitInThrottle = false;
        this._rateLimitLastChatTs = 0;
        rateLimitEvents.on('throttle', ({ provider, waitMs }) => {
            if (!this.alive || !this.bot) return;
            const now = Date.now();
            // Suppress duplicate chats if we already posted one within 60s
            if (this._rateLimitInThrottle) return;
            if (now - this._rateLimitLastChatTs < 60_000) {
                this._rateLimitInThrottle = true;
                return;
            }
            this._rateLimitInThrottle = true;
            this._rateLimitLastChatTs = now;
            try {
                this.openChat("I need to rest for a moment. It'll take less than a minute!");
                console.log(`[rate_limit:${provider}] posted throttle chat (waitMs=${waitMs})`);
            } catch (e) { console.warn('[rate_limit] throttle chat failed:', e?.message || e); }
        });
        rateLimitEvents.on('resume', ({ provider }) => {
            if (!this.alive || !this.bot) return;
            if (!this._rateLimitInThrottle) return;
            this._rateLimitInThrottle = false;
            try {
                this.openChat("Back on it.");
                console.log(`[rate_limit:${provider}] posted resume chat`);
            } catch (e) { console.warn('[rate_limit] resume chat failed:', e?.message || e); }
        });

        const {greeting, hasActive, activeDesc, activeId} = this._rebootContext();
        this.openChat(greeting);
        if (hasActive && !save_data?.self_prompt && !init_message) {
            this.enqueue({
                source: 'system',
                message: `You just rebooted and rejoined the server. Task #${activeId} (${activeDesc}) was in progress. Continue executing it now.`,
                kind: 'init',
            });
        }
    }

    // Every minute, if there's an in_progress task, chat a one-line status so
    // the player isn't left wondering. No LLM call — rotates through stock
    // phrases with the current task description plugged in. Triggers on the
    // *task* being active, not the run_queue (which goes idle between LLM
    // turns even while mineflayer is still busy).
    // Position-based stuck detector. Polls bot.entity.position once a second
    // and watches for a 5-sample window with <0.6 block max drift while a
    // *motion-class* action is running (whitelist below). On stuck: /tp the
    // bot to the player who last spoke to it. Requires op on the server —
    // without op the /tp is silently dropped and this becomes a no-op.
    //
    // Designed to be high-precision: skips !newAction (Sonnet code-gen
    // freezes the bot for 5-15s legitimately), skips actions where standing
    // still is normal (crafting, smelting, chest ops), and kills itself if
    // it fires 3 times in 5 min — that pattern means something deeper is
    // wrong and further TPs would just bleed tokens via the system messages.
    _startStuckWatcher() {
        const WINDOW = 5;                 // samples (= 5s at 1Hz)
        const MIN_DRIFT = 0.6;            // blocks
        const COOLDOWN_MS = 30000;        // per-event throttle
        const KILL_THRESHOLD = 3;         // max TPs ...
        const KILL_WINDOW_MS = 5 * 60000; //   ... per this rolling window
        // Only TP when one of these actions is supposedly moving the bot
        // and the position hasn't drifted. Conservative whitelist —
        // anything else (newAction, craftRecipe, lookAt*, …) is left alone.
        const MOTION_ACTIONS = new Set([
            'action:goToCoordinates',
            'action:goToPlayer',
            'action:goToRememberedPlace',
            'action:goToBedrock',
            'action:searchForBlock',
            'action:searchForEntity',
            'action:collectBlocks',
            'action:attack',
            'action:attackPlayer',
            'action:moveAway',
            'action:followPlayer',
            'action:givePlayer',
        ]);
        let samples = [];
        let lastTpAt = 0;
        let tpHistory = []; // timestamps; kill-switch trips if length ≥ KILL_THRESHOLD
        let killed = false;
        let lastSkipLogAt = 0; // throttle the no-last_sender skip log to 1/min
        this._stuckWatcher = setInterval(() => {
            if (killed || !this.alive || !this.bot || !this.bot.entity || !this.bot.entity.position) return;
            const p = this.bot.entity.position;
            samples.push({ x: p.x, y: p.y, z: p.z });
            if (samples.length > WINDOW) samples.shift();
            if (samples.length < WINDOW) return;

            const label = this.actions?.currentActionLabel || '';
            if (!MOTION_ACTIONS.has(label)) return;

            const first = samples[0];
            let maxDrift = 0;
            for (const s of samples) {
                const dx = s.x - first.x, dy = s.y - first.y, dz = s.z - first.z;
                const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
                if (d > maxDrift) maxDrift = d;
            }
            if (maxDrift >= MIN_DRIFT) return;

            // No player to TP to → log and skip. Don't ~ ~10 ~ vertical-hop:
            // if the bot is stuck without anyone to follow, random TPs make
            // things worse (lose location context, possibly land in lava).
            const target = this.last_sender;
            if (!target) {
                const now2 = Date.now();
                if (now2 - lastSkipLogAt > 60000) {
                    console.warn(`[stuck] frozen during ${label} but no last_sender — skip TP (throttled)`);
                    lastSkipLogAt = now2;
                }
                return;
            }

            const now = Date.now();
            if (now - lastTpAt < COOLDOWN_MS) return;
            tpHistory = tpHistory.filter(t => now - t < KILL_WINDOW_MS);
            if (tpHistory.length >= KILL_THRESHOLD) {
                killed = true;
                console.warn(`[stuck] kill-switch: ${KILL_THRESHOLD} TPs in ${KILL_WINDOW_MS/60000}m — disabling watcher to avoid loop`);
                try {
                    this.history.add(
                        'system',
                        `[stuck recovery DISABLED] Auto-teleport fired ${KILL_THRESHOLD} times in ${KILL_WINDOW_MS/60000} minutes. Something is wrong beyond pathfinding. Please !cancelTask and ask the player for direction.`,
                    );
                } catch (e) { /* ignore */ }
                return;
            }
            lastTpAt = now;
            tpHistory.push(now);
            samples = [];

            const cmd = `/tp ${this.name} ${target}`;
            console.warn(`[stuck] no drift for ${WINDOW}s during ${label} → ${cmd}`);
            try {
                this.bot.chat(cmd);
                this.history.add(
                    'system',
                    `[stuck recovery] You were physically frozen for ${WINDOW}s during ${label}. Auto-teleported to ${target}. Re-orient with !nearbyBlocks if needed, then continue or !cancelTask if the goal isn't reachable.`,
                );
            } catch (e) {
                console.warn('[stuck] tp failed:', e?.message || e);
            }
        }, 1000);
    }

    _startQueueHeartbeat() {
        const PHRASES = [
            'Still on it — ',
            'Working on ',
            'Currently: ',
            'Continuing ',
            'Heads up, still ',
        ];
        let i = 0;
        this._heartbeat = setInterval(() => {
            if (!this.alive || !this.task_queue) return;
            const active = this.task_queue.tasks.find(t => t.status === 'in_progress');
            if (!active) return;
            const phrase = PHRASES[i++ % PHRASES.length];
            try {
                this.openChat(`${phrase}${active.description}.`);
                console.log(`[heartbeat] tick → task #${active.id}: ${active.description}`);
            } catch (e) { console.warn('[heartbeat] openChat failed:', e?.message || e); }
        }, 60000);
        // Active-task drive loop. The chat heartbeat above tells the player
        // the bot is working; this one tells the BOT to keep working. Runs
        // every 10s. Fires a system input when:
        //   - run_queue is idle (worker is parked between turns)
        //   - task_queue has a task in_progress
        //   - no player input in the last 15s (give the player a chance to talk)
        //   - we haven't already nudged this same task in the last 30s
        // Without this the bot answers a chat question then sits silent
        // forever even though a task is "in_progress" — exactly what we saw
        // with task #145.
        this._lastDriveNudgeForTask = null;
        this._lastDriveNudgeTs = 0;
        this._driveLoop = setInterval(() => {
            if (!this.alive || !this.task_queue) return;
            if (this.planMode === true) return; // plan mode is "wait for player approval", don't auto-drive
            if (this.run_queue?.state !== 'idle') return;
            if (this.run_queue?.depth > 0) return;
            const active = this.task_queue.tasks.find(t => t.status === 'in_progress');
            if (!active) return;
            const now = Date.now();
            if (this._lastPlayerInputTs && (now - this._lastPlayerInputTs) < 15000) return;
            if (this._lastDriveNudgeForTask === active.id && (now - this._lastDriveNudgeTs) < 30000) return;
            // Dedupe: if a drive_tick for any task is already queued, don't
            // stack another. Under rate-limiting the queue would otherwise
            // pile up nudges that each cost ~8K tokens to process.
            const queued = this.run_queue?.queuedInputs || [];
            if (queued.some(q => q.kind === 'drive_tick')) {
                console.log('[drive] skipping nudge — one already queued');
                return;
            }
            this._lastDriveNudgeForTask = active.id;
            this._lastDriveNudgeTs = now;
            console.log(`[drive] queue idle, nudging task #${active.id}`);
            try {
                this.enqueue({
                    source: 'system',
                    message: `[drive] Task #${active.id} (${active.description}) is in_progress and the action queue is idle. Issue the next concrete command to advance it. If the end_factor (${active.endFactor || 'unset'}) has been observed, call !finishTask. If the task no longer makes sense, !cancelTask and explain to the player.`,
                    kind: 'drive_tick',
                });
            } catch (e) { console.warn('[drive] enqueue failed:', e?.message || e); }
        }, 10000);
    }

    // Fires whenever the queue mutates. Debounces a plan-brief chat so a
    // bulk-add (3-7 !addTask calls in <2s) collapses to a single summary
    // sent shortly after the last add. Player sees the plan even if the LLM
    // forgot to brief it.
    _onQueueChange(kind, task) {
        // Phase G1+G2/G4: when a subagent's task finishes, inject the
        // [subagent finished] result message into history so the planner
        // sees the outcome on its next turn. Runs before the chat-brief
        // logic so concurrent state doesn't race.
        if (kind === 'finish' && this.activeSubagent && task && task.id === this.activeSubagent.taskId) {
            try {
                const msg = finalizeSubagent(this, task.id, { success: true, summary: task.description });
                if (msg) this.history.add('system', msg);
            } catch (e) {
                console.warn('finalizeSubagent failed:', e?.message || e);
            }
        }
        if (kind === 'cancel' && this.activeSubagent && task && task.id === this.activeSubagent.taskId) {
            try {
                const msg = finalizeSubagent(this, task.id, { success: false, summary: 'cancelled before completion' });
                if (msg) this.history.add('system', msg);
            } catch (e) {
                console.warn('finalizeSubagent (cancel) failed:', e?.message || e);
            }
        }
        // Side-chat follow-up: when a task finishes, address any player
        // messages we deferred earlier. Synthetic system input drives the
        // worker to run one planner turn focused on the deferred question.
        // Fires on the FIRST finish so the player isn't waiting through the
        // whole queue; cleared after enqueuing.
        if (kind === 'finish' && this._pendingFollowups && this._pendingFollowups.length > 0) {
            const followups = this._pendingFollowups;
            this._pendingFollowups = [];
            const lines = followups.map(f => `${f.target} said "${f.message}"`).join('; ');
            try {
                this.enqueue({
                    source: 'system',
                    message: `[task #${task?.id ?? '?'} just finished — pending player follow-up] You earlier deferred: ${lines}. Address ${followups[0].target} directly now (chat reply, then continue the queue if it isn't empty).`,
                    kind: 'system',
                });
            } catch (e) {
                console.warn('followup enqueue failed:', e?.message || e);
            }
        }
        // Per-task start announcement: tell the player which task is starting
        // so they know what the bot's about to do. Critical for the chunked-
        // build pattern where each chunk takes 10-25s of LLM overhead — without
        // this, the player sees long silences and assumes the bot is stuck.
        // 5s debounce so rapid auto-advances (e.g. 5 tasks finishing in 30s)
        // don't spam chat.
        if (kind === 'start' && task) {
            const now = Date.now();
            if (!this._lastTaskStartChatTs || now - this._lastTaskStartChatTs >= 5000) {
                this._lastTaskStartChatTs = now;
                try {
                    this.openChat(`Starting task #${task.id}: ${task.description}`);
                } catch (e) { console.warn('[task start] openChat failed:', e?.message || e); }
            }
        }
        if (kind !== 'add') return; // only briefing on adds for now
        clearTimeout(this._planBriefTimer);
        this._planBriefTimer = setTimeout(() => {
            if (!this.alive || !this.task_queue) return;
            const live = this.task_queue.tasks.filter(t => t.status !== 'done');
            if (live.length === 0) return;
            const lines = live.map(t => {
                const tag = t.status === 'in_progress' ? '▶' : '○';
                return `${tag} ${t.description}`;
            });
            try {
                this.openChat(`Plan (${live.length} task${live.length === 1 ? '' : 's'}): ${lines.join(' · ')}.`);
            } catch (e) { /* ignore */ }
        }, 2500);
    }

    // Phase G1+G2: thin bridge so the !dispatchAgent command can call into
    // the subagent runtime without each command importing subagent.js.
    async dispatchSubagent(role, description, endFactor) {
        return await dispatchSubagent(this, role, description, endFactor);
    }

    listSubagentRoles() { return listRoles(); }

    _rebootContext() {
        const tq = this.task_queue;
        if (!tq) return {greeting: `Hi, I'm ${this.name}. Ready for a mission.`, hasActive: false};
        const active = tq.tasks.find(t => t.status === 'in_progress');
        const pending = tq.tasks.filter(t => t.status === 'pending');
        if (active) {
            const tail = pending.length > 0 ? ` (+ ${pending.length} more queued)` : '';
            return {
                greeting: `Back online. Was working on: ${active.description}${tail}. Picking it up.`,
                hasActive: true,
                activeId: active.id,
                activeDesc: active.description,
            };
        }
        if (pending.length > 0) {
            return {
                greeting: `Back online. ${pending.length} task${pending.length === 1 ? '' : 's'} waiting — starting now.`,
                hasActive: false,
            };
        }
        return {greeting: `Online and ready. No tasks queued — what'll it be?`, hasActive: false};
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    // Phase C1/C3: plan-mode lifecycle. Centralized here so the !enterPlanMode
    // command, the Phase C2 auto-trigger on task-request, and the 10-min stale-
    // plan timeout all share one source of truth.
    enterPlanMode() {
        if (this.planMode === true) return false;
        this.planMode = true;
        if (this._planModeTimer) clearTimeout(this._planModeTimer);
        if (this._planModeHardCap) clearTimeout(this._planModeHardCap);
        // Re-ping the player if the plan sits unapproved for 10 minutes. Don't
        // auto-execute — the bot just nags so an unattended plan doesn't rot
        // silently (per blueprint §8 open question, biased toward "abort + ping").
        this._planModeTimer = setTimeout(() => {
            if (this.planMode === true) {
                try {
                    this.routeResponse(
                        this.last_sender,
                        '[planning] Plan still on the table — say ok to start, or cancel / revise to scrap it.'
                    );
                } catch (e) {
                    console.warn('plan-mode ping failed:', e?.message || e);
                }
            }
        }, 10 * 60 * 1000);
        // Hard cap: after 90s with no approval, auto-fall-back to listening
        // mode (plan stays in queue; just no longer gated). This stops the
        // bot getting stuck in plan mode when the player walks away or fails
        // to use the exact approval phrasing. Live tasks self-execute via the
        // queue auto-advance + drive loop once gating is off.
        this._planModeHardCap = setTimeout(() => {
            if (this.planMode === true) {
                console.log('[plan mode] hard-cap timeout, auto-releasing');
                this.exitPlanMode();
                this.history.add('system', '[plan mode timed out] No approval after 90s — plan mode released. The queue tasks (if any) will auto-execute. If the player wanted to revise, they can still say so.').catch(() => {});
            }
        }, 90 * 1000);
        return true;
    }

    exitPlanMode() {
        if (this.planMode !== true) return false;
        this.planMode = false;
        if (this._planModeTimer) {
            clearTimeout(this._planModeTimer);
            this._planModeTimer = null;
        }
        if (this._planModeHardCap) {
            clearTimeout(this._planModeHardCap);
            this._planModeHardCap = null;
        }
        return true;
    }

    // Phase E/H7: bridge so commands (e.g. !invokeSkill) can hit the meta-skill
    // registry without each command needing its own slash_skills.js import.
    async invokeMetaSkill(name, args = '') {
        return await invokeMetaSkill(this, name, args);
    }

    // Backwards-compat shim. Pre-Phase 1 code called handleMessage directly; now
    // everything flows through the queue.
    handleMessage(source, message, max_responses=null) {
        this.enqueue({source, message, max_responses, kind: 'legacy'});
    }

    // Producer side: called by event handlers. Serializes inputs so two
    // chats arriving close together don't race the LLM. The LLM itself
    // decides what to do with each input — chat, queue a task, run one,
    // refuse, etc. via the !addTask / !finishTask / !showQueue commands.
    //
    // Special case: player chat that arrives while a task is running gets
    // a parallel "side reply" so the player isn't left hanging. The task
    // keeps executing; only the bot's voice talks back.
    enqueue(input) {
        if (!input || !input.source || !input.message) {
            console.warn('enqueue ignored empty input:', input);
            return;
        }
        const mode = classifyInput(input);
        input.mode = mode;
        if (mode === 'interrupt') {
            if (this.run_queue.state === 'running') {
                this.history.add('system', `[Interrupted by: ${input.source}]`);
            }
            this.run_queue.abortCurrent();
            this.run_queue.clear();
            this.requestInterrupt();
            this.run_queue.push(input);
            return;
        }
        if (input.kind === 'player_chat') {
            // Track the last human who chatted so the stuck-watcher and other
            // recovery paths have a TP target. Mindcraft's stock last_sender
            // only updates on bot-to-bot messages; player input was leaving
            // it null, which meant the watcher would detect stuck but have
            // no one to TP to.
            this.last_sender = input.source;
            // Drive-loop suppression window: don't auto-nudge the bot while
            // the player is actively chatting — gives them ~15s to type.
            this._lastPlayerInputTs = Date.now();
        }
        if (input.kind === 'player_chat' && this.run_queue.state === 'running') {
            // Don't enqueue — the running task keeps going. Just answer the player.
            this._handleSideChat(input).catch(e => console.error('_handleSideChat:', e));
            return;
        }
        this.run_queue.push(input);
    }

    // Parallel LLM call that produces a short prose reply while a task is
    // running. Strips any commands the model emits so we never accidentally
    // interfere with the task that owns the bot's body. Always replies
    // something so the player isn't ignored — even if the LLM blanks or
    // only emits commands.
    async _handleSideChat(input) {
        const {source, message} = input;
        // Any time we bail out without a real answer (LLM failure, empty
        // reply, or all-commands-deferred), queue a follow-up so the player
        // gets addressed once the current work finishes. _onQueueChange
        // drains this list on the next task finish.
        const recordFollowup = () => {
            if (!source || source === 'system') return;
            this._pendingFollowups = (this._pendingFollowups || []).filter(f => f.target !== source);
            this._pendingFollowups.push({ target: source, message });
        };
        try {
            await this.history.add(source, `(mid-task) ${message}`);
            const history = this.history.getHistory();
            let res;
            try {
                res = await this.prompter.promptConvo(history);
            } catch (e) {
                console.warn('side-chat LLM call failed:', e?.message || e);
                recordFollowup();
                this.routeResponse(source, `Kinda busy right now, sorry — I'll get back to you.`);
                return;
            }
            if (!res || res.trim().length === 0) {
                recordFollowup();
                this.routeResponse(source, `Heard you — give me a sec.`);
                return;
            }
            // A1: parse all commands in the side-chat response, not just the first.
            // Execute every safe command in order; defer body-touching ones until the
            // current task finishes. Without this, a response like
            // `!remember(...) !addTask(...)` would silently drop the !addTask.
            const cmdSpans = findAllCommandSpans(res);

            if (cmdSpans.length === 0) {
                // No commands — pure prose reply
                await this.history.add(this.name, res);
                this.routeResponse(source, res.trim());
                return;
            }

            const preMessage = res.substring(0, cmdSpans[0].startIndex).trim();
            const trailingProse = res.substring(cmdSpans[cmdSpans.length - 1].endIndex).trim();

            await this.history.add(this.name, res);
            if (preMessage) this.routeResponse(source, preMessage);

            let executedCount = 0;
            const deferred = [];
            for (const span of cmdSpans) {
                const cmdName = span.commandName;
                if (isSafeSideChatCommand(getCommand(cmdName))) {
                    const cmdText = res.substring(span.startIndex, span.endIndex);
                    try {
                        const execRes = await executeCommand(this, cmdText);
                        if (execRes) await this.history.add('system', execRes);
                        console.log(`[side-chat] safe command executed: ${cmdName}`);
                        executedCount++;
                    } catch (e) {
                        console.warn(`[side-chat] ${cmdName} failed:`, e?.message || e);
                    }
                } else {
                    deferred.push(cmdName);
                }
            }

            if (deferred.length > 0 && executedCount === 0 && !preMessage) {
                // Nothing got through and no prose — give the player a heads-up.
                recordFollowup();
                this.routeResponse(source, `Got it — let me finish what I'm on first.`);
            } else if (deferred.length > 0) {
                recordFollowup();
                this.routeResponse(source, `(Deferring ${deferred.join(', ')} until I'm done with my current task.)`);
            } else if (trailingProse) {
                this.routeResponse(source, trailingProse);
            }
        } catch (e) {
            console.error('_handleSideChat failed:', e);
            try { this.routeResponse(source, `(I heard you but hit an error replying.)`); } catch {}
        }
    }

    // Consumer side: single forever loop. Owns the LLM + bot for one input at a time.
    async _runWorker() {
        while (this.alive) {
            let input;
            try {
                input = await this.run_queue.next();
            } catch (e) {
                console.error('run_queue.next() failed:', e);
                continue;
            }
            this.run_queue.beginRun(input);
            try {
                await this._processInput(input);
            } catch (e) {
                if (e && e.name === 'AbortError') {
                    // expected when an interrupt cuts the run short
                } else {
                    console.error('_processInput failed:', e);
                }
            } finally {
                this.run_queue.endRun();
            }
        }
    }

    async _processInput(input) {
        let {source, message, max_responses = null} = input;
        await this.checkTaskDone();

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            // Phase H1: slash-skills get first crack — /init, /review, etc.
            // Players using Bedrock can spell it !!init since vanilla reserves '/'.
            // Slash dispatch bypasses the LLM entirely: the skill composes the
            // right !addTask + !newAction chain itself.
            if (parseSlashCommand(message)) {
                const slashReply = await dispatchSlashCommand(this, source, message);
                if (slashReply !== undefined) {
                    try {
                        await this.history.add(source, message);
                        if (slashReply) await this.history.add('system', `(slash skill output) ${slashReply}`);
                        this.history.save();
                    } catch (e) {
                        console.warn('slash-skill history write failed:', e?.message || e);
                    }
                    if (slashReply) this.routeResponse(source, slashReply);
                    return true;
                }
            }
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res)
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.run_queue.aborted || this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);

        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        await this.history.add(source, message);
        for (const nudge of nudgesForUserMessage(message, { self_prompt, from_other_bot })) {
            await this.history.add('system', nudge);
        }
        // Phase C2: plan-mode auto-trigger/auto-exit. Player intent → state.
        //   - Not in plan mode + task-request detected → enter plan mode +
        //     inject the plan-mode nudge so the LLM proposes a plan instead
        //     of charging into !startTask.
        //   - Already in plan mode + clear "yes/ok/go" → exit plan mode and
        //     auto-start the first pending task (mirrors !exitPlanMode).
        //   - Already in plan mode + clear "no/cancel/revise" → exit plan mode
        //     and tell the LLM to listen for changes instead of executing.
        // Bot/self-prompt messages bypass this — only human input drives plan
        // mode transitions.
        if (!self_prompt && !from_other_bot) {
            if (this.planMode === true) {
                if (detectPlanApproval(message)) {
                    this.exitPlanMode();
                    let startMsg = '';
                    try {
                        const r = this.task_queue?.startTask(null);
                        if (r?.message) startMsg = ' ' + r.message;
                    } catch (e) {
                        console.warn('plan-approval auto-start failed:', e?.message || e);
                    }
                    await this.history.add('system', PLAN_APPROVED_NUDGE + startMsg);
                } else if (detectPlanRejection(message)) {
                    this.exitPlanMode();
                    await this.history.add('system', PLAN_REJECTED_NUDGE);
                } else if (detectTaskRequest(message)) {
                    // Supersede: player issued a NEW complex request while a
                    // prior plan was waiting for its decomposition. Old plan
                    // is dead — exit + re-enter for the new request.
                    console.log('[plan mode] superseded by new task request');
                    this.exitPlanMode();
                    await this.history.add('system', '[plan superseded] Player issued a new task request before the prior plan committed. The old plan is abandoned. Rebuild the queue for what they just asked.');
                    this.enterPlanMode();
                    await this.history.add('system', PLAN_MODE_AUTO_NUDGE);
                }
            } else if (detectTaskRequest(message)) {
                this.enterPlanMode();
                await this.history.add('system', PLAN_MODE_AUTO_NUDGE);
            }
        }
        this.history.save();

        // v2 integration: when orchestrator is live, delegate the LLM loop
        // to it. The orchestrator maintains its own neutral-shape history,
        // owns tool execution + parallelism + bg handles, and parks when
        // the LLM emits no tool calls. agent.history above is still
        // appended for archival (debug logs); the LLM-facing history is
        // orchestrator-owned. Skip the legacy for-loop entirely.
        if (this.orchestrator) {
            const pendingBefore = this.task_queue?.tasks?.filter(t => t.status === 'pending').length ?? 0;
            const planModeBefore = this.planMode === true;
            try {
                await this.orchestrator.handleEvent({
                    type: 'user_message',
                    source,
                    content: message,
                });
            } catch (e) {
                console.error('[v2 orch] handleEvent failed:', e?.message || e);
            }

            // Plan-mode auto-commit: if we entered plan mode this turn (or
            // were already in it) AND the planner produced at least one new
            // !addTask, auto-exit + auto-start task #1 immediately. No
            // approval ceremony — the bot keeps moving. The 90s hard-cap
            // in enterPlanMode() stays as a safety net for the rare case
            // the LLM enters plan mode but emits no tasks.
            if (planModeBefore && this.planMode === true) {
                const pendingTasks = this.task_queue?.tasks?.filter(t => t.status === 'pending') || [];
                const pendingNow = pendingTasks.length;
                if (pendingNow > pendingBefore) {
                    const added = pendingNow - pendingBefore;

                    // Thin-decomposition gate. If the player's request had a
                    // big size signal (≥200 blocks) AND the planner queued
                    // only 1 task, reject the plan and force a replan. The
                    // single bad task is auto-cancelled so the queue is
                    // clean before the planner retries.
                    const sizeEst = estimateTaskSize(message);
                    if (added === 1 && sizeEst.blocks >= SIZE_DECOMP_THRESHOLD) {
                        const badTask = pendingTasks[pendingTasks.length - 1];
                        const badId = badTask?.id;
                        console.log(`[plan mode] thin decomposition rejected (1 task for ~${sizeEst.blocks} blocks); cancelling task #${badId} + replanning`);
                        try {
                            if (badId != null) this.task_queue.cancelTask(badId);
                        } catch (e) { console.warn('thin-decomp cancel failed:', e?.message || e); }
                        await this.history.add('system', THIN_DECOMPOSITION_NUDGE(sizeEst, badId ?? '?'));
                        try {
                            await this.orchestrator.handleEvent({
                                type: 'checkpoint',
                                content: '[replan] Your prior plan was a single bloated task — rejected. Emit multiple smaller !addTask calls now. Plan mode is still on.',
                            });
                        } catch (e) {
                            console.error('[v2 orch] thin-decomp replan failed:', e?.message || e);
                        }
                        return true;
                    }

                    console.log(`[plan mode] auto-commit (${added} task(s) queued)`);
                    this.exitPlanMode();
                    try {
                        const r = this.task_queue.startTask(null);
                        if (r?.message) {
                            await this.history.add('system', `[plan committed] ${added} task(s) queued. ${r.message}`);
                        }
                    } catch (e) {
                        console.warn('plan auto-start failed:', e?.message || e);
                    }
                    // Kick the orchestrator immediately so task #1 begins
                    // executing on this same chat turn rather than waiting
                    // for the next drive tick.
                    try {
                        await this.orchestrator.handleEvent({
                            type: 'checkpoint',
                            content: `Plan committed: ${added} tasks queued. Task #1 is now in_progress — execute it now using the body-touching commands available outside plan mode.`,
                        });
                    } catch (e) {
                        console.error('[v2 orch] post-plan-commit handleEvent failed:', e?.message || e);
                    }
                }
            }
            return true;
        }

        if (!self_prompt && this.self_prompter.isActive())
            max_responses = 1;
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            // Phase A4: compact older turns before grabbing the snapshot so the next
            // sendRequest pays for a smaller history. Runs at most once per turn.
            await this.history.compactIfNeeded(
                settings.compaction_threshold_tokens ?? 3000,
                settings.compaction_keep_recent ?? 8
            );
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);
            if (checkInterrupt()) break;

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response');
                // Reissue safety net: a discarded-mid-generation system input
                // (reboot resume, init message, game_event, etc.) gets lost
                // forever — the input that drove this turn was consumed and
                // empty came back. Re-enqueue it once so the model gets a
                // second chance. Skips drive_tick (the drive loop will re-fire
                // on its own) and system_reissue (avoid infinite reissue
                // loops). Player-source inputs aren't reissued — the player
                // typing again handles that.
                const kind = input?.kind || 'system';
                if (source === 'system' && !self_prompt
                    && kind !== 'drive_tick' && kind !== 'system_reissue') {
                    console.log(`[reissue] empty system response, re-enqueuing kind=${kind}`);
                    try {
                        this.enqueue({
                            source: 'system',
                            message,
                            kind: 'system_reissue',
                        });
                    } catch (e) { console.warn('[reissue] enqueue failed:', e?.message || e); }
                }
                break;
            }

            // Phase A1: parse all commands in the response, execute in order.
            // Previously only the first command was executed; trailing commands
            // (`!stop\n\n!remember(...)`) were silently dropped, which is why
            // !remember and !addTask sometimes failed after !stop.
            const cmdSpans = findAllCommandSpans(res);

            if (cmdSpans.length > 0) {
                // Preserve the full response in history (no truncation) so the
                // model sees all commands it issued + any trailing prose.
                this.history.add(this.name, res);

                const preMessage = res.substring(0, cmdSpans[0].startIndex).trim();
                const trailingProse = res.substring(cmdSpans[cmdSpans.length - 1].endIndex).trim();

                // "full" mode: post the whole response once, no per-command chat
                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }

                for (let ci = 0; ci < cmdSpans.length; ci++) {
                    const span = cmdSpans[ci];
                    const cmdName = span.commandName;
                    const cmdText = res.substring(span.startIndex, span.endIndex);

                    if (!commandExists(cmdName)) {
                        this.history.add('system', `Command ${cmdName} does not exist.`);
                        console.warn('Agent hallucinated command:', cmdName);
                        continue;
                    }

                    if (checkInterrupt()) break;
                    this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(cmdName));

                    // Per-command display (skip if "full" mode already posted everything)
                    if (settings.show_command_syntax === "shortened") {
                        let chat_message = `*used ${cmdName.substring(1)}*`;
                        if (ci === 0 && preMessage.length > 0)
                            chat_message = `${preMessage}  ${chat_message}`;
                        this.routeResponse(source, chat_message);
                    }
                    else if (settings.show_command_syntax === "natural") {
                        let chat_message = humanizeCommand(cmdText);
                        if (ci === 0 && preMessage.length > 0)
                            chat_message = `${preMessage} ${chat_message}`;
                        this.routeResponse(source, chat_message);
                    }
                    else if (settings.show_command_syntax !== "full") {
                        if (ci === 0 && preMessage.length > 0)
                            this.routeResponse(source, preMessage);
                    }

                    let execute_res = await executeCommand(this, cmdText);
                    if (checkInterrupt()) break;

                    console.log('Agent executed:', cmdName, 'and got:', execute_res);
                    used_command = true;

                    if (execute_res) {
                        this.history.add('system', execute_res);
                        // Phase E/H7: deterministic stuck-detection tripwire. On
                        // the second consecutive primitive that returned a path/
                        // tool failure pattern, auto-invoke the 'stuck' meta-skill.
                        // The skill owns the escalation script (!newAction rewrite
                        // → !cancelTask + ping player). The old PATH_FAILURE_NUDGE
                        // injection is gone — `stuck` covers it more generally.
                        if (cmdName === '!newAction' || cmdName === '!cancelTask' || cmdName === '!invokeSkill') {
                            this._consecutivePathFailures = 0;
                        } else if (isPathFailure(execute_res)) {
                            this._consecutivePathFailures = (this._consecutivePathFailures || 0) + 1;
                            if (this._consecutivePathFailures >= 2) {
                                try {
                                    const stuckOut = await this.invokeMetaSkill('stuck', `${this._consecutivePathFailures} consecutive primitive failures`);
                                    if (stuckOut) this.history.add('system', stuckOut);
                                } catch (e) {
                                    console.warn('stuck auto-invoke failed:', e?.message || e);
                                }
                                this._consecutivePathFailures = 0;
                            }
                        } else {
                            this._consecutivePathFailures = 0;
                        }
                    }
                }

                // Trailing prose after the last command — post once if anything's there
                if (trailingProse.length > 0 && settings.show_command_syntax !== "full") {
                    this.routeResponse(source, trailingProse);
                }
            }
            else {
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }

            this.history.save();
        }

        return used_command;
    }

    // v2 Step 4-6 integration helpers. _initOrchestratorV2 wires
    // OrchestratorV2 against the prompter's existing model + plan-mode
    // state. Called from start() after initExamples so convo_examples
    // and the active model are ready.
    _initOrchestratorV2() {
        if (settings.use_background_handles) {
            this.backgroundTasks = new BackgroundTasks();
            this.use_background_handles = true;
        }
        this.orchestrator = new OrchestratorV2(this, {
            getSystemPrompt: async () => await this._buildSystemPromptForTools(),
            promptWithTools: async (history, system, tools) => await this._promptViaModel(history, system, tools),
            registry: getRegistry(),
        });
        this.orchestrator.backgroundTasks = this.backgroundTasks;
        console.log(`[v2] orchestrator live${this.backgroundTasks ? ' + background_handles' : ''}`);
    }

    // Build the system prompt the orchestrator sends each turn. Same as
    // promptConvo's template but strips $COMMAND_DOCS — under tool_use
    // protocol, the command surface comes from the tools[] param, not
    // the prompt body.
    async _buildSystemPromptForTools() {
        let prompt = this.prompter.profile.conversing || '';
        // Match $COMMAND_DOCS with any surrounding whitespace/newlines so
        // we don't leave a gap in the formatted template.
        prompt = prompt.replace(/\n*\$COMMAND_DOCS\n*/g, '\n');
        return await this.prompter.replaceStrings(prompt, [], this.prompter.convo_examples);
    }

    // Bridge the orchestrator's promptWithTools callback to the model
    // wrapper's sendRequestWithTools. Converts the neutral history to
    // provider-native shape before sending.
    async _promptViaModel(neutralHistory, systemMessage, toolDescriptors) {
        await this.prompter.checkCooldown();
        const activeModel = this.prompter._modelForActiveTurn();
        const providerKey = activeModel.constructor?.prefix || 'openai';
        const providerHistory = providerKey === 'anthropic'
            ? neutralToAnthropic(neutralHistory)
            : neutralToOpenAI(neutralHistory);
        const resp = await activeModel.sendRequestWithTools(providerHistory, systemMessage, toolDescriptors);
        try { this.prompter._recordUsage('convo_tools', activeModel); } catch {}
        return resp;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        // PATCHED: always use public chat when chat_ingame=true, regardless of only_chat_with.
        // only_chat_with is still respected for INPUT filtering (in respondFunc above).
        if (settings.speak) {
            speak(to_translate, this.prompter.profile.speak_model);
        }
        if (settings.chat_ingame) { this.bot.chat(message); }
        sendOutputToServer(this.name, message);
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
            // Plan-mode release on death. Recovery (going to last_death_position,
            // re-equipping, eating) cannot be gated behind plan approval — the
            // player isn't going to type "go" for every respawn cycle.
            if (this.planMode === true) {
                console.log('[plan mode] released on death');
                this.exitPlanMode();
                this.history.add('system', '[plan mode released] You died — plan mode is off. Recover first (eat, re-equip, retrieve gear), then resume work.').catch(() => {});
            }
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.enqueue({
                    source: 'system',
                    message: `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`,
                    kind: 'game_event_critical',
                });
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.alive = false;
        if (this._heartbeat) clearInterval(this._heartbeat);
        if (this._driveLoop) clearInterval(this._driveLoop);
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
