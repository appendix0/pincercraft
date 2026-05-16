// LLM-owned task queue. The bot's model creates / completes / cancels tasks
// itself via !addTask / !finishTask / !cancelTask / !showQueue commands; the
// queue is rendered into the system prompt every turn via $TASKQUEUE so the
// model always sees what it's tracking.
//
// Tasks persist to bots/<name>/tasks.json across restarts.

import fs from 'fs';
import path from 'path';

const STATUS = {PENDING: 'pending', IN_PROGRESS: 'in_progress', DONE: 'done'};

export class TaskQueue {
    constructor(agentName) {
        this.path = path.resolve(`./bots/${agentName}/tasks.json`);
        this.tasks = [];
        this._nextId = 1;
        this._load();
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

    addTask(description) {
        description = String(description || '').trim();
        if (!description) return {ok: false, message: 'Task description was empty.'};
        const task = {id: this._nextId++, description, status: STATUS.PENDING, createdAt: Date.now()};
        this.tasks.push(task);
        this._persist();
        return {ok: true, message: `Task #${task.id} added: ${description}`, task};
    }

    // Mark a task as in_progress. If no id, picks the first pending one.
    startTask(id = null) {
        const t = id != null ? this._find(id) : this.tasks.find(x => x.status === STATUS.PENDING);
        if (!t) return {ok: false, message: id != null ? `No task #${id}.` : 'No pending tasks.'};
        if (t.status === STATUS.DONE) return {ok: false, message: `Task #${t.id} is already done.`};
        // Demote any other in_progress task back to pending — one active task at a time.
        for (const o of this.tasks) if (o.status === STATUS.IN_PROGRESS && o.id !== t.id) o.status = STATUS.PENDING;
        t.status = STATUS.IN_PROGRESS;
        this._persist();
        return {ok: true, message: `Started task #${t.id}: ${t.description}`, task: t};
    }

    // Mark a task done. If no id, picks the in_progress one.
    finishTask(id = null) {
        const t = id != null ? this._find(id) : this.tasks.find(x => x.status === STATUS.IN_PROGRESS);
        if (!t) return {ok: false, message: id != null ? `No task #${id}.` : 'No task in progress.'};
        if (t.status === STATUS.DONE) return {ok: false, message: `Task #${t.id} was already done.`};
        t.status = STATUS.DONE;
        t.finishedAt = Date.now();
        this._persist();
        return {ok: true, message: `Finished task #${t.id}: ${t.description}`, task: t};
    }

    cancelTask(id) {
        const idx = this.tasks.findIndex(x => x.id === Number(id));
        if (idx === -1) return {ok: false, message: `No task #${id}.`};
        const [t] = this.tasks.splice(idx, 1);
        this._persist();
        return {ok: true, message: `Cancelled task #${t.id}: ${t.description}`, task: t};
    }

    clearDone() {
        const before = this.tasks.length;
        this.tasks = this.tasks.filter(x => x.status !== STATUS.DONE);
        this._persist();
        return {ok: true, message: `Cleared ${before - this.tasks.length} done task(s).`};
    }

    _find(id) {
        return this.tasks.find(x => x.id === Number(id));
    }

    // What the LLM sees in $TASKQUEUE every turn. Done tasks are hidden so the
    // list stays focused on what's left to do; cleared via !clearDone.
    serialize() {
        const live = this.tasks.filter(t => t.status !== STATUS.DONE);
        if (live.length === 0) return 'Your task queue is empty.';
        const lines = live.map(t => {
            const tag = t.status === STATUS.IN_PROGRESS ? 'IN PROGRESS' : 'pending';
            return `  #${t.id} [${tag}] ${t.description}`;
        });
        return 'Your task queue:\n' + lines.join('\n');
    }

    // Human-facing chat dump for !showQueue.
    formatForChat() {
        const live = this.tasks.filter(t => t.status !== STATUS.DONE);
        if (live.length === 0) return 'No tasks queued.';
        return live.map(t => {
            const tag = t.status === STATUS.IN_PROGRESS ? '▶' : '○';
            return `${tag} #${t.id} ${t.description}`;
        }).join(' | ');
    }
}
