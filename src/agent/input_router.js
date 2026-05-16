// PincerCraft Phase 1: classify each enqueued input as 'interrupt' or 'followup'.
// See docs/queue-design.md §4, §5. Only two modes exist in Phase 1; collect/steer
// arrive in later phases.

const INTERRUPT_KEYWORDS = ['!stop', '!halt', '!cancel'];

export function isPureStopMessage(message) {
    const msg = (message || '').trim().toLowerCase();
    return INTERRUPT_KEYWORDS.includes(msg);
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

        // Player typed an explicit stop keyword.
        const msg = (input.message || '').toLowerCase();
        if (INTERRUPT_KEYWORDS.some(kw => msg.includes(kw))) return 'interrupt';

        return 'followup';
    }
}
