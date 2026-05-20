// v2 Step 5 — Background tool handles.
//
// Long-running tools (newAction, collectBlocks, goTo*, attack,
// craftRecipe, stay) return a handle immediately and run in the
// background. Mode interrupts cancel gracefully via AbortController
// instead of crashing the process (which is what today's
// action_manager.js:78 recent_action_counter > 5 → cleanKill does).
//
// Lifecycle:
//   const {handle} = bg.spawn({
//       toolName: 'collectBlocks',
//       args: { type: 'iron_ore', num: 5 },
//       run: (signal) => skills.smartGather(bot, 'iron_ore', 5, signal),
//       onComplete: ({handle, result|error, cancelled, toolName}) => ...
//   });
//   // ... later
//   bg.cancel(handle);  // triggers AbortController; run() must respect signal
//
// Orchestrator wiring: when use_background_handles is on, the
// orchestrator's _executeOne() spawns long-running tools through this
// and returns a {status:'started', handle} tool_result immediately.
// On completion, onComplete fires handleEvent({type:'bg_complete', ...}),
// which the orchestrator threads back into the LLM history as a real
// tool_result.
//
// What this does NOT include this step:
//   - Removing action_manager.js:78 cleanKill — destructive; defer to
//     integration phase when orchestrator is live in production. Until
//     then BG handles and the cleanKill coexist (BG handles bypass
//     ActionManager entirely, so the counter doesn't trip).
//   - Refitting Mineflayer skills to honor AbortSignal — incremental;
//     each runAsAction-wrapped command needs its skills.* call updated.
//     For Step 5 ship, the signal is plumbed; refit is downstream.
//
// See docs/agent-blueprint.md §3 Step 5 rev-2.

export class BackgroundTasks {
    constructor() {
        this.handles = new Map();
        this._seq = 0;
    }

    // Returns {status, handle}. run(signal) is the actual work — it should
    // poll signal.aborted or pass signal into pathfinder/Mineflayer where
    // supported. onComplete fires exactly once per spawn, with one of:
    //   { handle, toolName, result }         success
    //   { handle, toolName, error }          run() threw
    //   { handle, toolName, cancelled: true } cancel() was called and run() then settled
    spawn({ toolName, args, run, onComplete }) {
        if (typeof run !== 'function') throw new Error('spawn: run must be a function');
        const handle = `bg-${++this._seq}`;
        const ctrl = new AbortController();
        const startedAt = Date.now();

        const fire = (payload) => {
            try { onComplete?.(payload); }
            catch (e) { console.warn(`[bg ${handle}] onComplete threw:`, e?.message || e); }
            this.handles.delete(handle);
        };

        const promise = Promise.resolve()
            .then(() => run(ctrl.signal))
            .then(result => {
                if (ctrl.signal.aborted) fire({ handle, toolName, cancelled: true });
                else fire({ handle, toolName, result });
            })
            .catch(err => {
                if (ctrl.signal.aborted) fire({ handle, toolName, cancelled: true });
                else fire({ handle, toolName, error: err?.message || String(err) });
            });

        this.handles.set(handle, { ctrl, promise, toolName, args, startedAt });
        return { status: 'started', handle };
    }

    cancel(handle) {
        const h = this.handles.get(handle);
        if (!h) return { ok: false, message: `No bg handle "${handle}"` };
        h.ctrl.abort();
        return { ok: true, message: `Cancelled ${handle} (${h.toolName})` };
    }

    // Used by tests + ops tooling. Returns shallow snapshot, no internals.
    list() {
        return Array.from(this.handles.entries()).map(([handle, v]) => ({
            handle,
            toolName: v.toolName,
            args: v.args,
            startedAt: v.startedAt,
            elapsedMs: Date.now() - v.startedAt,
        }));
    }

    // Wait for everything in flight to settle. Used during clean shutdown
    // and in tests. Doesn't cancel — caller should cancel() first if they
    // want abort behavior.
    async drain(timeoutMs = 10_000) {
        const promises = Array.from(this.handles.values()).map(h => h.promise);
        if (promises.length === 0) return { drained: 0 };
        const settled = Promise.allSettled(promises);
        const timeout = new Promise(r => setTimeout(() => r({ timedOut: true }), timeoutMs));
        const winner = await Promise.race([settled, timeout]);
        return winner.timedOut ? { drained: 0, timedOut: true } : { drained: promises.length };
    }

    // Cancel everything and wait for settlement. Used by !stop and on
    // mode_trigger (Step 5 mode integration).
    async cancelAll() {
        const handles = Array.from(this.handles.keys());
        for (const h of handles) this.cancel(h);
        return await this.drain(5_000);
    }
}
