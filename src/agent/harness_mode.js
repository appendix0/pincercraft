// Field-trial ablation switch for the deterministic harness.
//
// The harness is ON unless the flag file .runtime/harness_off exists (relative
// to the bot's working directory, like the other .runtime flags). With the flag
// present the bot runs as a stock LLM agent for the benchmark's OFF arm:
//   - raw state only (no CAPABILITIES craft-gap, no TASK-PROGRESS line)
//   - no precondition gates (craft preflight, redundant-acquire)
//   - no reflexes (tool-break guard, inventory tidy)
//   - no verified finishes (finish gate, drive auto-finish, give auto-finish,
//     loop/verify coaching) — completion is the LLM's honor-system claim
// Player-facing safety (stop reflex, death handler, CoC) is NOT part of the
// ablation and stays on in both arms.
//
// Checked live via existsSync on every call — cheap, and it lets an arm flip
// without a bot restart (though the trial restarts between arms for clean
// history anyway).
import fs from 'fs';
import path from 'path';

const FLAG = path.resolve('./.runtime/harness_off');

export function harnessOn() {
    try { return !fs.existsSync(FLAG); } catch { return true; }
}
