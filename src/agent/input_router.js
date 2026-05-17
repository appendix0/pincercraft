// PincerCraft Phase 1: classify each enqueued input as 'interrupt' or 'followup'.
// See docs/queue-design.md §4, §5. Only two modes exist in Phase 1; collect/steer
// arrive in later phases.

const INTERRUPT_COMMANDS = ['!stop', '!halt', '!cancel'];
// Natural-language stop intents. Word-boundary so "stopped by the lake" or
// "I waited an hour" don't trigger. Matched on the full lowercased message.
const INTERRUPT_PHRASES = /\b(stop everything|stop please|stop now|please stop|just stop|halt|abort|cancel that|nevermind|never mind|hold on|hold up|pause that)\b/i;
// Standalone single-word stops must start the message: "stop", "stop.", "wait!"
const STANDALONE_STOP = /^(stop|wait|pause|cancel)\b/i;

export function isPureStopMessage(message) {
    const msg = (message || '').trim().toLowerCase();
    return INTERRUPT_COMMANDS.includes(msg);
}

export class InputRouter {
    classify(input) {
        // Critical game events (low health, on fire, drowning) — life-threatening,
        // drop everything.
        if (input.kind === 'game_event_critical') return 'interrupt';

        // Mode-driven auto-reprompts: self_preservation is the only critical mode
        // in Phase 1. Other modes (e.g. item_collecting, hunting) auto-reprompt
        // as a normal followup.
        if (input.kind === 'mode_auto' && input.mode_name === 'self_preservation') {
            return 'interrupt';
        }

        // Player typed an explicit stop command or a natural-language stop intent.
        const msg = (input.message || '').toLowerCase();
        if (INTERRUPT_COMMANDS.some(kw => msg.includes(kw))) return 'interrupt';
        if (INTERRUPT_PHRASES.test(msg)) return 'interrupt';
        if (STANDALONE_STOP.test(msg.trim())) return 'interrupt';

        return 'followup';
    }
}
