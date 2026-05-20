// v2 Step 1 — Resilience wrapper.
//
// Sliding-window per-provider RPM throttle + 429 retry-with-backoff. Sits
// between model wrappers and provider SDKs so a transient 429 burst no
// longer becomes N × "My brain disconnected" wasted turns. Provider-
// neutral; every src/models/<provider>.js routes its API call through
// `client.send(() => sdkCall())`.
//
// Settings (settings.js):
//   use_rate_limit_wrapper: true | false    // master switch, default ON
//   rate_limit.<provider>.rpm: number       // sliding-window cap
//   rate_limit.retry_max_attempts: number   // max retries on 429 (default 3)
//   rate_limit.backoff_max_seconds: number  // ceiling for backoff (default 30)
//
// See docs/agent-blueprint.md §3 Step 1.

import settings from '../../settings.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sliding 60s window: tracks acquire timestamps; blocks new acquires until
// the window has < rpm entries. acquire() is serialized through a promise
// chain so concurrent callers see a consistent window.
class SlidingWindowBucket {
    constructor(rpm) {
        this.rpm = rpm;
        this.timestamps = [];
        this._chain = Promise.resolve();
    }

    async acquire() {
        const next = this._chain.then(() => this._acquireInternal());
        this._chain = next.catch(() => {});
        return next;
    }

    async _acquireInternal() {
        if (!this.rpm || this.rpm <= 0) return;
        while (true) {
            const now = Date.now();
            const cutoff = now - 60_000;
            while (this.timestamps.length && this.timestamps[0] < cutoff) {
                this.timestamps.shift();
            }
            if (this.timestamps.length < this.rpm) {
                this.timestamps.push(now);
                return;
            }
            const waitMs = 60_000 - (now - this.timestamps[0]) + 50;
            await sleep(waitMs);
        }
    }
}

export class RateLimitedClient {
    constructor({ provider, rpm, retryMaxAttempts = 3, backoffMaxSec = 30, log = console.log } = {}) {
        this.provider = provider || 'unknown';
        this.rpm = rpm ?? 0;
        this.retryMaxAttempts = retryMaxAttempts;
        this.backoffMaxSec = backoffMaxSec;
        this.log = log;
        this.bucket = new SlidingWindowBucket(this.rpm);
    }

    async send(fn) {
        await this.bucket.acquire();
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (e) {
                const status = this._status(e);
                if (status !== 429 || attempt >= this.retryMaxAttempts) {
                    throw e;
                }
                const wait = this._backoffMs(e, attempt);
                this.log(`[rate_limit:${this.provider}] 429 on attempt ${attempt + 1}/${this.retryMaxAttempts + 1}, sleeping ${wait}ms`);
                await sleep(wait);
            }
        }
    }

    _status(e) {
        return e?.status ?? e?.statusCode ?? e?.response?.status ?? null;
    }

    _backoffMs(e, attempt) {
        const ra = this._retryAfter(e);
        if (ra != null) return Math.min(ra, this.backoffMaxSec * 1000);
        const base = Math.min(2 ** attempt * 500, this.backoffMaxSec * 1000);
        return Math.floor(base * (0.8 + Math.random() * 0.4));
    }

    _retryAfter(e) {
        const h = e?.headers ?? e?.response?.headers ?? null;
        if (!h) return null;
        const raw = typeof h.get === 'function' ? h.get('retry-after') : h['retry-after'];
        if (raw == null) return null;
        const n = Number(raw);
        if (Number.isFinite(n)) return n * 1000;
        const d = Date.parse(raw);
        if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
        return null;
    }
}

// Conservative defaults; settings.rate_limit.<provider>.rpm overrides.
export const DEFAULT_RPM = {
    anthropic: 50,
    nvidia: 40,
    openai: 60,
    gemini: 10,
    groq: 30,
};

// Factory: read settings, build a wrapper for `provider`. Returns null when
// `use_rate_limit_wrapper` is explicitly false — callers should then fall
// through to a raw SDK call.
export function makeRateLimitedClient(provider) {
    if (settings?.use_rate_limit_wrapper === false) return null;
    const cfg = settings?.rate_limit || {};
    const rpm = cfg[provider]?.rpm ?? DEFAULT_RPM[provider] ?? 0;
    return new RateLimitedClient({
        provider,
        rpm,
        retryMaxAttempts: cfg.retry_max_attempts ?? 3,
        backoffMaxSec: cfg.backoff_max_seconds ?? 30,
    });
}
