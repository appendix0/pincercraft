// Best-effort capture of PLAYER-driven task attempts into pincercraft_evals.db.
//
// Fires on task finish during normal play. Skipped during eval sessions —
// eval/loop.sh logs those (as task_source 'llm'), and double-logging would
// pollute the eval signal. Fully fire-and-forget: every failure is swallowed
// so logging can never disturb or block the live bot.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { verifyEndFactor } from './verify.js';

// Owned by eval/session.sh; present iff an automated eval session is running.
const CYCLE_FLAG = path.resolve('./.runtime/cycle_active');

export function logPlayAttempt(agent, task) {
    try {
        if (!task) return;
        if (fs.existsSync(CYCLE_FLAG)) return; // eval session -> loop.sh owns logging

        // Best-effort success: trust only programmatic verification, the same
        // honesty bar the eval gate uses. Unverifiable finishes are recorded as
        // not-success with an explicit marker rather than honor-system credit.
        let success = 0;
        let failure_mode = 'unverified_play';
        try {
            const v = verifyEndFactor(agent, task);
            if (v && v.programmatic) {
                success = v.verified ? 1 : 0;
                failure_mode = v.verified ? null : 'unverified_play';
            }
        } catch { failure_mode = 'verify_error'; }

        const wall = (task.createdAt && task.finishedAt)
            ? (task.finishedAt - task.createdAt) / 1000 : 0;

        const row = {
            task_name: task.description || '',
            difficulty_tier: 'play',
            task_set: 'play',
            task_source: 'player',
            success,
            wall_clock_seconds: wall,
        };
        if (!success && failure_mode) row.failure_mode = failure_mode;

        // Detached, output discarded, unref'd: the bot never waits on this and
        // a missing python3 / DB just no-ops via the 'error' handler.
        const child = spawn('python3', ['eval/eval_db.py', 'log-attempt', '--json', JSON.stringify(row)], {
            cwd: process.cwd(), detached: true, stdio: 'ignore',
        });
        child.on('error', () => {});
        child.unref();
    } catch { /* never let logging disturb the bot */ }
}
