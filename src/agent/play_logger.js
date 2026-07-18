// Best-effort capture of PLAYER-driven task attempts.
//
// Fires on task finish during normal play. Skipped during eval sessions —
// eval/loop.sh logs those (as task_source 'llm'). Writes a JSONL row
// SYNCHRONOUSLY in-process (fs.appendFileSync) — no child process, so none of
// the PATH / systemd-cgroup-kill / spawn fragility that made the earlier
// spawn('python3', ...) approach silently capture 0 rows. Ingest into
// pincercraft_evals.db on demand with:
//   python3 eval/eval_db.py ingest-jsonl
// Fully wrapped: any failure is swallowed so logging never disturbs the bot.
import fs from 'fs';
import path from 'path';
import { verifyEndFactor } from './verify.js';

// Owned by eval/session.sh; present iff an automated eval session is running.
const CYCLE_FLAG = path.resolve('./.runtime/cycle_active');
const PLAY_LOG = path.resolve('./eval/play_attempts.jsonl');

export function logPlayAttempt(agent, task) {
    try {
        if (!task) return;
        if (fs.existsSync(CYCLE_FLAG)) return; // eval session -> loop.sh owns logging

        // Best-effort success: trust only programmatic verification, the same
        // honesty bar the eval gate uses. Unverifiable finishes are recorded as
        // not-success with an explicit marker rather than honor-system credit.
        let success = 0;
        let failure_mode = 'unverified_play';
        let programmatic = false;
        try {
            const v = verifyEndFactor(agent, task);
            if (v && v.programmatic) {
                programmatic = true;
                success = v.verified ? 1 : 0;
                failure_mode = v.verified ? null : 'referee_delta_short';
            }
        } catch { failure_mode = 'verify_error'; }

        const wall = (task.createdAt && task.finishedAt)
            ? (task.finishedAt - task.createdAt) / 1000 : 0;

        const row = {
            task_id: task.id,
            task_name: task.description || '',
            difficulty_tier: 'play',
            task_set: 'play',
            task_source: 'player',
            success,
            wall_clock_seconds: wall,
            end_factor: task.endFactor || null,
            label_source: programmatic ? 'referee' : 'honor_system',
            timestamp: new Date().toISOString(),
        };
        if (!success && failure_mode) row.failure_mode = failure_mode;

        // Synchronous, in-process append. Completes before this returns, so it
        // survives an immediate bot restart and needs no external process.
        fs.appendFileSync(PLAY_LOG, JSON.stringify(row) + '\n');
    } catch { /* never let logging disturb the bot */ }
}
