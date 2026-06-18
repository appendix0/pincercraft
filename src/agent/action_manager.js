export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        // Bumped when stop() force-abandons a wedged action, so a late-settling
        // zombie can detect it no longer owns the action state (see _executeAction).
        this._actionGen = 0;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        let forced = false;
        const timeout = setTimeout(() => {
            // A wedged action must NOT kill the process. A reboot here means a
            // disconnect, a lost task, and the bot "quitting" mid-session — the
            // standing rule is: stop the task and tell the player honestly, stay
            // online. So hard-abort the stuck action, drop the task it was on,
            // report it, and let the wait loop exit.
            forced = true;
            const label = this.currentActionLabel || 'that action';
            console.error(`[stop] '${label}' refused to stop after 10s — abandoning it and stopping the task (no process kill).`);
            try { this.agent.bot.pathfinder?.setGoal?.(null); } catch { /* best-effort hard stop */ }
            try { this.agent.requestInterrupt(); } catch {}
            // Invalidate the wedged action so its late cleanup can't reset state
            // out from under a newer action (see the _actionGen guard below).
            this._actionGen++;
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            try {
                const active = this.agent.task_queue?.tasks?.find(t => String(t.status) === 'in_progress');
                if (active) this.agent.task_queue.cancelTask(active.id);
            } catch { /* best-effort */ }
            try { this.agent.openChat(`I got stuck on ${label} and couldn't finish it, so I stopped that task. What do you want me to do next?`); } catch {}
        }, 10000);
        while (this.executing && !forced) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        let myGen;
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;
            myGen = this._actionGen; // captured after stop(); a later force-abandon bumps this



            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup. Skip the state reset if stop()
            // already force-abandoned this action — a newer action owns it now.
            clearTimeout(TIMEOUT);
            if (this._actionGen === myGen) {
                this.executing = false;
                this.currentActionLabel = '';
                this.currentActionFn = null;
            }

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            clearTimeout(TIMEOUT);
            if (this._actionGen === myGen) {
                this.executing = false;
                this.currentActionLabel = '';
                this.currentActionFn = null;
            }

            // A PathStopped rejection is the expected result of one action
            // preempting another: stop() -> requestInterrupt() -> pathfinder.stop()
            // rejects the in-flight goto. Treat it as a clean cancellation at the
            // arbitration boundary instead of surfacing it as a thrown exception,
            // so it never reaches the preempting action as a code error.
            if (err && err.name === 'PathStopped') {
                let output = this.getBotOutputSummary();
                let interrupted = this.agent.bot.interrupt_code;
                this.agent.clearBotLogs();
                if (!interrupted) {
                    this.agent.bot.emit('idle');
                }
                return { success: true, message: output, interrupted, timedout: false };
            }

            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}