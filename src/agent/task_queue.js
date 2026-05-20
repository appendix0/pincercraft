// LLM-owned task queue. The bot's model creates / completes / cancels tasks
// itself via !addTask / !finishTask / !cancelTask / !showQueue commands; the
// queue is rendered into the system prompt every turn via $TASKQUEUE so the
// model always sees what it's tracking.
//
// Tasks persist to bots/<name>/tasks.json across restarts.

import fs from 'fs';
import path from 'path';

const STATUS = {PENDING: 'pending', IN_PROGRESS: 'in_progress', DONE: 'done'};
const LOG_PATH = path.resolve('./queue.log');

// End-factor phrases that aren't verifiable. Rejecting them at add-time forces
// the LLM to write a concrete criterion, which is what Phase H's verify gate
// needs in order to catch honor-system finishes. The exact words come from
// observed failures (queue.log, diamond-armor session 2026-05-19) where the
// LLM declared tasks done because "enough X for Y" is unfalsifiable.
const VAGUE_END_FACTOR_PATTERNS = [
    /\benough\b/i,
    /\b(?:if|as|when)\s+(?:needed|necessary|possible|appropriate)\b/i,
    /\bsufficient\b/i,
    /\bsome\s+(?:more|of)\b/i,
];

export class TaskQueue {
    constructor(agentName, onChange = null, isPaused = null) {
        this.agentName = agentName;
        this.path = path.resolve(`./bots/${agentName}/tasks.json`);
        this.tasks = [];
        this._nextId = 1;
        this.onChange = onChange; // (kind, task) => void; kind in {add, start, finish, cancel, clearDone, auto-start}
        // () => boolean. When truthy, addTask + finishTask skip auto-promotion
        // so plan-mode honors "no work until the player approves." The queue
        // can still add/cancel/finish; only the implicit start is gated.
        this.isPaused = isPaused;
        this._load();
    }

    _paused() {
        if (typeof this.isPaused !== 'function') return false;
        try { return !!this.isPaused(); } catch (e) {
            console.warn('TaskQueue.isPaused threw:', e?.message || e);
            return false;
        }
    }

    _fire(kind, task) {
        if (this.onChange) {
            try { this.onChange(kind, task); } catch (e) { console.warn('TaskQueue.onChange failed:', e?.message || e); }
        }
    }

    _log(action, task) {
        try {
            const ts = new Date().toISOString();
            const line = task
                ? `${ts} [${this.agentName}] ${action} #${task.id} ${task.status} ${JSON.stringify(task.description)}\n`
                : `${ts} [${this.agentName}] ${action}\n`;
            fs.appendFileSync(LOG_PATH, line);
        } catch (e) {
            console.warn('queue log append failed:', e?.message || e);
        }
    }

    _load() {
        try {
            if (!fs.existsSync(this.path)) return;
            const data = JSON.parse(fs.readFileSync(this.path, 'utf8'));
            this.tasks = data.tasks || [];
            this._nextId = data.nextId || (this.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1);
        } catch (e) {
            console.warn('TaskQueue load failed:', e?.message || e);
        }
    }

    _persist() {
        try {
            fs.mkdirSync(path.dirname(this.path), {recursive: true});
            fs.writeFileSync(this.path, JSON.stringify({nextId: this._nextId, tasks: this.tasks}, null, 2));
        } catch (e) {
            console.warn('TaskQueue persist failed:', e?.message || e);
        }
    }

    addTask(description, endFactor = null) {
        description = String(description || '').trim();
        endFactor = String(endFactor || '').trim() || null;
        if (!description) return {ok: false, message: 'Task description was empty — rejected.'};
        if (description.length < 4) return {ok: false, message: `Task description "${description}" too short (need at least 4 chars). Be specific — rejected.`};
        if (!endFactor) return {ok: false, message: `Task "${description}" missing end_factor — rejected. Every task needs an explicit completion criterion (e.g. "3 iron_ore in inventory", "player picked up the pickaxe", "bot at coords 100,64,-50").`};
        const vague = VAGUE_END_FACTOR_PATTERNS.find(re => re.test(endFactor));
        if (vague) {
            const hit = endFactor.match(vague)[0];
            return {ok: false, message: `Task "${description}" has a vague end_factor ("${endFactor}") — rejected. The phrase "${hit}" is not verifiable. Use a concrete, measurable criterion (e.g. "3 iron_ingot in inventory", "iron_pickaxe in inventory", "bot at coords 100,64,-50"). Pick a specific number and item.`};
        }
        // Reject duplicates among live (non-done) tasks. Compare case-insensitive
        // exact match — fuzzy match would risk false rejects on similar-but-
        // distinct tasks (e.g. "mine 3 iron_ore" vs "mine 5 iron_ore").
        const dupe = this.tasks.find(t => t.status !== STATUS.DONE && t.description.toLowerCase() === description.toLowerCase());
        if (dupe) return {ok: false, message: `Duplicate of task #${dupe.id} (${dupe.status}): "${dupe.description}" — rejected. Use the existing task.`};
        const task = {id: this._nextId++, description, endFactor, status: STATUS.PENDING, createdAt: Date.now()};
        this.tasks.push(task);
        // Auto-advance: if nothing is in progress, promote this one immediately
        // so the model never has to chain !addTask + !startTask manually.
        // Plan-mode pause suppresses this — the LLM is supposed to lay out the
        // full plan and wait for player approval before any task starts.
        const hasActive = this.tasks.some(x => x.status === STATUS.IN_PROGRESS);
        const endHint = ` Done when: ${endFactor}.`;
        if (!hasActive && !this._paused()) {
            task.status = STATUS.IN_PROGRESS;
            this._persist();
            this._log('add+start', task);
            this._fire('add', task);
            return {ok: true, message: `Task #${task.id} added and started: ${description}.${endHint} Begin executing it now.`, task};
        }
        this._persist();
        this._log('add', task);
        this._fire('add', task);
        return {ok: true, message: `Task #${task.id} queued: ${description}.${endHint}`, task};
    }

    // Mark a task as in_progress. If no id, picks the first pending one.
    // Mostly used to re-order; auto-start covers the common case.
    startTask(id = null) {
        const t = id != null ? this._find(id) : this.tasks.find(x => x.status === STATUS.PENDING);
        if (!t) return {ok: false, message: id != null ? `No task #${id}.` : 'No pending tasks.'};
        if (t.status === STATUS.DONE) return {ok: false, message: `Task #${t.id} is already done.`};
        for (const o of this.tasks) if (o.status === STATUS.IN_PROGRESS && o.id !== t.id) o.status = STATUS.PENDING;
        t.status = STATUS.IN_PROGRESS;
        this._persist();
        this._log('start', t);
        return {ok: true, message: `Started task #${t.id}: ${t.description}`, task: t};
    }

    // Mark a task done. If no id, picks the in_progress one. Auto-advances to
    // the next pending task so the model can immediately execute it.
    finishTask(id = null) {
        const t = id != null ? this._find(id) : this.tasks.find(x => x.status === STATUS.IN_PROGRESS);
        if (!t) return {ok: false, message: id != null ? `No task #${id}.` : 'No task in progress.'};
        if (t.status === STATUS.DONE) return {ok: false, message: `Task #${t.id} was already done.`};
        t.status = STATUS.DONE;
        t.finishedAt = Date.now();
        this._log('finish', t);
        // Plan-mode pause skips the implicit advance — if a task somehow ran
        // into plan mode, finishing it shouldn't slide the next pending into
        // in_progress behind the player's back.
        const next = this._paused() ? null : this.tasks.find(x => x.status === STATUS.PENDING);
        if (next) {
            next.status = STATUS.IN_PROGRESS;
            this._persist();
            this._log('auto-start', next);
            return {
                ok: true,
                message: `Finished task #${t.id}: ${t.description}. Auto-started #${next.id}: ${next.description}. Begin executing it now.`,
                task: t,
            };
        }
        this._persist();
        return {
            ok: true,
            message: `Finished task #${t.id}: ${t.description}. Queue is empty — all done. Tell the player you're done.`,
            task: t,
        };
    }

    cancelTask(id) {
        const idx = this.tasks.findIndex(x => x.id === Number(id));
        if (idx === -1) return {ok: false, message: `No task #${id}.`};
        const [t] = this.tasks.splice(idx, 1);
        this._persist();
        this._log('cancel', t);
        return {ok: true, message: `Cancelled task #${t.id}: ${t.description}`, task: t};
    }

    // Wipe everything not yet finished. Called by !stop so the player's mental
    // model ("stop = stop everything") matches reality. Done tasks stay so they
    // remain visible in history. Fires a 'cancel' event for each so any
    // listeners (chat surface, persist hooks) react consistently.
    cancelAllPending() {
        const cancelled = this.tasks.filter(x => x.status !== STATUS.DONE);
        if (cancelled.length === 0) return {ok: true, count: 0, message: 'No pending tasks to cancel.'};
        this.tasks = this.tasks.filter(x => x.status === STATUS.DONE);
        this._persist();
        this._log(`cancelAllPending (removed ${cancelled.length})`);
        cancelled.forEach(t => this._fire('cancel', t));
        return {ok: true, count: cancelled.length, message: `Cancelled ${cancelled.length} pending task(s).`};
    }

    clearDone() {
        const before = this.tasks.length;
        this.tasks = this.tasks.filter(x => x.status !== STATUS.DONE);
        this._persist();
        this._log(`clearDone (removed ${before - this.tasks.length})`);
        return {ok: true, message: `Cleared ${before - this.tasks.length} done task(s).`};
    }

    _find(id) {
        return this.tasks.find(x => x.id === Number(id));
    }

    // What the LLM sees in $TASKQUEUE every turn. Done tasks are hidden so the
    // list stays focused on what's left to do; cleared via !clearDone. Each
    // line carries its end factor so the model self-checks against the same
    // criterion it set at add-time.
    serialize({ planMode = false } = {}) {
        const live = this.tasks.filter(t => t.status !== STATUS.DONE);
        if (live.length === 0) {
            return planMode
                ? 'Your task queue is empty — propose a plan via !addTask, then post it to chat for approval.'
                : 'Your task queue is empty.';
        }
        const header = planMode
            ? 'Your task queue (PLAN MODE — awaiting player approval):'
            : 'Your task queue:';
        const lines = live.map(t => {
            const tag = t.status === STATUS.IN_PROGRESS ? 'IN PROGRESS' : 'pending';
            const end = t.endFactor ? `  (done when: ${t.endFactor})` : '';
            return `  #${t.id} [${tag}] ${t.description}${end}`;
        });
        return header + '\n' + lines.join('\n');
    }

    // Human-facing chat dump for !showQueue.
    formatForChat({ planMode = false } = {}) {
        const live = this.tasks.filter(t => t.status !== STATUS.DONE);
        if (live.length === 0) {
            return planMode ? '[planning] no plan yet — add steps with !addTask' : 'No tasks queued.';
        }
        const prefix = planMode ? '[planning] Plan: ' : '[executing] ';
        const body = live.map(t => {
            const tag = t.status === STATUS.IN_PROGRESS ? '▶' : '○';
            const end = t.endFactor ? ` (done: ${t.endFactor})` : '';
            return `${tag} #${t.id} ${t.description}${end}`;
        }).join(' | ');
        return prefix + body + (planMode ? '  (say ok to start)' : '');
    }
}
