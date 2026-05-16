// PincerCraft Phase 1: serial action lane with interrupt support.
// See docs/queue-design.md §3, §6, §7.
//
// One queue per agent. Producer (event handlers) calls push(); consumer
// (_runWorker in agent.js) calls next() in a forever loop. Each push wakes a
// pending next() exactly once. abortCurrent() signals the running task via
// AbortController; clear() drops queued-but-not-started inputs.

export class RunQueue {
    constructor() {
        this._items = [];
        this._waiters = [];
        this._abort = null;
        this.state = 'idle'; // 'idle' | 'running' | 'interrupted'
    }

    push(input) {
        if (this._waiters.length > 0) {
            const resolve = this._waiters.shift();
            resolve(input);
        } else {
            this._items.push(input);
        }
    }

    next() {
        if (this._items.length > 0) {
            return Promise.resolve(this._items.shift());
        }
        return new Promise(resolve => this._waiters.push(resolve));
    }

    clear() {
        this._items = [];
    }

    // Mark the *currently running* run as aborted. Consumer checks `aborted`
    // at checkpoints; in-flight LLM HTTP is not cancelled (Phase 1 limitation).
    abortCurrent() {
        if (this._abort) {
            this._abort.abort();
            this.state = 'interrupted';
        }
    }

    // Called by the worker before executing a new input.
    beginRun() {
        this._abort = new AbortController();
        this.state = 'running';
    }

    endRun() {
        this._abort = null;
        if (this.state !== 'interrupted') this.state = 'idle';
        else this.state = 'idle';
    }

    get aborted() {
        return !!this._abort?.signal.aborted;
    }

    get signal() {
        return this._abort?.signal;
    }

    get depth() {
        return this._items.length;
    }
}
