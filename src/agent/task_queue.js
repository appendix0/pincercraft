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

export class TaskQueue {
    constructor(agentName, onChange = null) {
        this.agentName = agentName;
        this.path = path.resolve(`./bots/${agentName}/tasks.json`);
        this.tasks = [];
        this._nextId = 1;
        this.onChange = onChange; // (kind, task) => void; kind in {add, start, finish, cancel, clearDone, auto-start}
        this._load();
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
        // Reject duplicates among live (non-done) tasks. Compare case-insensitive
        // exact match — fuzzy match would risk false rejects on similar-but-
        // distinct tasks (e.g. "mine 3 iron_ore" vs "mine 5 iron_ore").
        const dupe = this.tasks.find(t => t.status !== STATUS.DONE && t.description.toLowerCase() === description.toLowerCase());
        if (dupe) return {ok: false, message: `Duplicate of task #${dupe.id} (${dupe.status}): "${dupe.description}" — rejected. Use the existing task.`};
        const task = {id: this._nextId++, description, endFactor, status: STATUS.PENDING, createdAt: Date.now()};
        this.tasks.push(task);
        // Auto-advance: if nothing is in progress, promote this one immediately
        // so the model never has to chain !addTask + !startTask manually.
        const hasActive = this.tasks.some(x => x.status === STATUS.IN_PROGRESS);
        const endHint = ` Done when: ${endFactor}.`;
        if (!hasActive) {
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
        const next = this.tasks.find(x => x.status === STATUS.PENDING);
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
    serialize() {
        const live = this.tasks.filter(t => t.status !== STATUS.DONE);
        if (live.length === 0) return 'Your task queue is empty.';
        const lines = live.map(t => {
            const tag = t.status === STATUS.IN_PROGRESS ? 'IN PROGRESS' : 'pending';
            const end = t.endFactor ? `  (done when: ${t.endFactor})` : '';
            return `  #${t.id} [${tag}] ${t.description}${end}`;
        });
        return 'Your task queue:\n' + lines.join('\n');
    }

    // Human-facing chat dump for !showQueue.
    formatForChat() {
        const live = this.tasks.filter(t => t.status !== STATUS.DONE);
        if (live.length === 0) return 'No tasks queued.';
        return live.map(t => {
            const tag = t.status === STATUS.IN_PROGRESS ? '▶' : '○';
            const end = t.endFactor ? ` (done: ${t.endFactor})` : '';
            return `${tag} #${t.id} ${t.description}${end}`;
        }).join(' | ');
    }
}
