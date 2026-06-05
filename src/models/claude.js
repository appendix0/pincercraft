import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { makeRateLimitedClient } from './rate_limited_client.js';
import { toAnthropicTools, fromAnthropicResponse, buildRetryMessage } from './tool_protocol.js';

export class Claude {
    static prefix = 'anthropic';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        // Phase A3: out-of-band usage side-channel. sendRequest stays returning string
        // (prompter.js:250 type-checks it); telemetry callers read this after each call.
        this.last_usage = null;

        // v2 Step 1: our RateLimitedClient owns retry+throttle. Set SDK
        // maxRetries to 0 when the wrapper is active so the two layers
        // don't compound and inflate latency on a 429 burst. When the
        // wrapper is disabled, fall back to a generous SDK retry budget.
        this.rate_limiter = makeRateLimitedClient('anthropic');
        let config = { maxRetries: this.rate_limiter ? 0 : 4 };
        if (url)
            config.baseURL = url;

        config.apiKey = getKey('ANTHROPIC_API_KEY');

        this.anthropic = new Anthropic(config);
    }

    async sendRequest(turns, systemMessage) {
        const messages = strictFormat(turns);
        let res = null;
        this.last_usage = null;
        try {
            console.log(`Awaiting anthropic response from ${this.model_name}...`)
            if (!this.params.max_tokens) {
                if (this.params.thinking?.budget_tokens) {
                    this.params.max_tokens = this.params.thinking.budget_tokens + 1000;
                    // max_tokens must be greater than thinking.budget_tokens
                } else {
                    this.params.max_tokens = 4096;
                }
            }
            const call = () => this.anthropic.messages.create({
                model: this.model_name || "claude-sonnet-4-6",
                system: systemMessage,
                messages: messages,
                ...(this.params || {})
            });
            const resp = this.rate_limiter ? await this.rate_limiter.send(call) : await call();

            console.log('Received.')
            this.last_usage = resp.usage || null;
            // get first content of type text
            const textContent = resp.content.find(content => content.type === 'text');
            if (textContent) {
                res = textContent.text;
            } else {
                console.warn('No text content found in the response.');
                res = 'No response from Claude.';
            }
        }
        catch (err) {
            if (err.message.includes("does not support image input")) {
                res = "Vision is only supported by certain models.";
            } else {
                // SDK already exhausted maxRetries. Add a 2s pause so the
                // player sees the bot is offline rather than getting a
                // sub-second flash from "Awaiting..." to "disconnected".
                await new Promise(r => setTimeout(r, 2000));
                res = "My brain disconnected, try again.";
            }
            console.log(err);
        }
        return res;
    }

    // v2 Step 3: structured tool-use path. Returns the neutral
    // tool-protocol shape (see src/models/tool_protocol.js).
    // Anthropic supports tool_use natively — no tolerant-parse retry needed
    // here (the SDK delivers `input` as a parsed object).
    //
    // `turns` is the Anthropic-native shape (objects with content arrays for
    // tool_use/tool_result blocks). Callers (prompter.promptConvoWithTools)
    // convert from the orchestrator's neutral shape via neutralToAnthropic()
    // before calling. We deliberately skip strictFormat() here — it assumes
    // string content and would mangle the tool_use blocks.
    async sendRequestWithTools(turns, systemMessage, toolDescriptors) {
        this.last_usage = null;
        if (!this.params.max_tokens) {
            this.params.max_tokens = this.params.thinking?.budget_tokens
                ? this.params.thinking.budget_tokens + 1000
                : 4096;
        }
        // Prompt caching. The static system prefix (~10K tokens: conversing
        // template + role + rules + world knowledge) and the tools[] surface
        // (~3K) are stable across turns — mark them ephemeral so Anthropic
        // reuses the prefix (cache_read) instead of re-billing it (cache_creation)
        // each turn. 5-minute TTL; breakpoints stay under the 4-breakpoint limit.
        //
        // systemMessage is either a plain string (single cached block) or a
        // { static, dynamic } pair: the dynamic half (live inventory/stats/queue,
        // which changes every turn) goes in a SEPARATE uncached block AFTER the
        // cache breakpoint, so per-turn state no longer invalidates the cached
        // static prefix.
        const tools = toAnthropicTools(toolDescriptors || []);
        const cachedTools = tools.length > 0
            ? [...tools.slice(0, -1), { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } }]
            : tools;
        let cachedSystem;
        if (systemMessage && typeof systemMessage === 'object') {
            cachedSystem = [{ type: 'text', text: systemMessage.static, cache_control: { type: 'ephemeral' } }];
            if (systemMessage.dynamic) cachedSystem.push({ type: 'text', text: systemMessage.dynamic });
        } else {
            cachedSystem = [{ type: 'text', text: systemMessage, cache_control: { type: 'ephemeral' } }];
        }
        const call = () => this.anthropic.messages.create({
            model: this.model_name || "claude-sonnet-4-6",
            system: cachedSystem,
            messages: turns,
            tools: cachedTools,
            ...(this.params || {}),
        });
        try {
            const resp = this.rate_limiter ? await this.rate_limiter.send(call) : await call();
            this.last_usage = resp.usage || null;
            return fromAnthropicResponse(resp);
        } catch (err) {
            console.log('[claude:tool_use] error:', err?.message || err);
            return { text: 'My brain disconnected, try again.', toolCalls: [], stopReason: 'error', parseErrors: [], raw: null };
        }
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const imageMessages = [...turns];
        imageMessages.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: systemMessage
                },
                {
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: "image/jpeg",
                        data: imageBuffer.toString('base64')
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Claude.');
    }
}
