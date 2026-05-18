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
    PATH_FAILURE_NUDGE,
    detectTaskRequest,
    detectPlanApproval,
    detectPlanRejection,
    PLAN_MODE_AUTO_NUDGE,
    PLAN_APPROVED_NUDGE,
    PLAN_REJECTED_NUDGE,
} from './classify_and_gate.js';

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
        this.task_queue = new TaskQueue(this.name, (kind, task) => this._onQueueChange(kind, task));
        this.memory_store = new MemoryStore(this.name);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

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

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
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
    }

    // Fires whenever the queue mutates. Debounces a plan-brief chat so a
    // bulk-add (3-7 !addTask calls in <2s) collapses to a single summary
    // sent shortly after the last add. Player sees the plan even if the LLM
    // forgot to brief it.
    _onQueueChange(kind, _task) {
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
        try {
            await this.history.add(source, `(mid-task) ${message}`);
            const history = this.history.getHistory();
            let res;
            try {
                res = await this.prompter.promptConvo(history);
            } catch (e) {
                console.warn('side-chat LLM call failed:', e?.message || e);
                this.routeResponse(source, `Kinda busy right now, sorry — I'll get back to you.`);
                return;
            }
            if (!res || res.trim().length === 0) {
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
                this.routeResponse(source, `Got it — let me finish what I'm on first.`);
            } else if (deferred.length > 0) {
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
                    this.planMode = false;
                    let startMsg = '';
                    try {
                        const r = this.task_queue?.startTask(null);
                        if (r?.message) startMsg = ' ' + r.message;
                    } catch (e) {
                        console.warn('plan-approval auto-start failed:', e?.message || e);
                    }
                    await this.history.add('system', PLAN_APPROVED_NUDGE + startMsg);
                } else if (detectPlanRejection(message)) {
                    this.planMode = false;
                    await this.history.add('system', PLAN_REJECTED_NUDGE);
                }
            } else if (detectTaskRequest(message)) {
                this.planMode = true;
                await this.history.add('system', PLAN_MODE_AUTO_NUDGE);
            }
        }
        this.history.save();

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
                console.warn('no response')
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
                        // Per-command path-failure tracking (Phase 1 classifier; replaced by `stuck` skill in Phase E).
                        if (cmdName === '!newAction' || cmdName === '!cancelTask') {
                            this._consecutivePathFailures = 0;
                        } else if (isPathFailure(execute_res)) {
                            this._consecutivePathFailures = (this._consecutivePathFailures || 0) + 1;
                            if (this._consecutivePathFailures >= 2) {
                                this.history.add('system', PATH_FAILURE_NUDGE(this._consecutivePathFailures));
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
