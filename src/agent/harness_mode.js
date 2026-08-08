// Field-trial ablation switch for the deterministic harness.
//
// Two granularities, both driven by flag files under .runtime/ (relative to the
// bot's working directory, like the other .runtime flags):
//
//   .runtime/harness_off              every layer off — the A-OFF arm, a stock
//                                     LLM agent
//   .runtime/harness_off_<layer>      one layer off — the B arms, which isolate
//                                     what each layer contributes
//
// The layers:
//   perception   CAPABILITIES craft-gap block, TASK-PROGRESS line
//   gates        precondition checks (craft preflight, redundant-acquire)
//   reflexes     tool-break guard, inventory tidy
//   verify       the bot CHECKS the end_factor: finishTask gate, loop/verify
//                coaching, end_factor echo in the drive nudge. Blocks unearned
//                finishes; never closes a task itself.
//   autofinish   the bot CLOSES the task in code once the end_factor is met:
//                drive-loop auto-finish, give/deliver auto-finish. Never
//                blocks anything.
//
// verify and autofinish were one `measurement` layer through seeds 1-2. That
// arm dropped verified success 61.1pp — the largest effect in the campaign —
// but bundled "don't let it claim done" with "close it when it is done", so
// the number was not attributable. Seeds 1-2 also showed the arm STALLING
// (2.0 steps/run, half the tokens of A-ON, 259 s wall clock), which points at
// the autofinish half; splitting them tests that directly.
//
// NOT part of any ablation:
//   - Player-facing safety (stop reflex, death handler, CoC) stays on in every
//     arm. Ablating it would be a hazard, not an experiment.
//   - The eval referee (eval/referee.mjs). It is the measuring instrument, not
//     a component under test: it scores every arm, including A-OFF, from
//     outside the bot. Ablating the harness must never ablate the scorer
//     (docs/paper/preregistration.md §4). Note the deliberate split between
//     `verify` above — the bot's own finish verification, which IS ablated —
//     and the external referee, which is not.
//
// Checked live via existsSync on every call — cheap, and it lets an arm flip
// without a bot restart (though the trial restarts between arms for clean
// history anyway).
import fs from 'fs';
import path from 'path';

export const LAYERS = ['perception', 'gates', 'reflexes', 'verify', 'autofinish'];

// Compound flags: one file ablating several layers at once. `measurement` is
// what seeds 1-2 ran, kept so that published data stays reproducible from this
// code — without it, `harness_off_measurement` would match no layer, silently
// read as fully-ON, and report an ablation that never happened.
const COMPOUND = { measurement: ['verify', 'autofinish'] };

// Resolved per call, not at import: the flags are read live anyway, and a path
// captured at load time would disagree with one resolved later if cwd ever
// differed — including under test.
function exists(name) {
    try { return fs.existsSync(path.resolve(`./.runtime/${name}`)); } catch { return false; }
}

// True when `layer` is active: the global ablation wins, then the per-layer
// flag. An unknown layer name would silently read as "on" and quietly disable
// an ablation, so it throws instead — a typo in an arm's flag must not look
// like a null result.
export function layerOn(layer) {
    if (!LAYERS.includes(layer)) throw new Error(`unknown harness layer: ${layer}`);
    if (exists('harness_off')) return false;
    if (exists(`harness_off_${layer}`)) return false;
    for (const [flag, members] of Object.entries(COMPOUND)) {
        if (members.includes(layer) && exists(`harness_off_${flag}`)) return false;
    }
    return true;
}
