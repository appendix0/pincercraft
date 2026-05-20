import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';

export class Claude {
    static prefix = 'anthropic';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        // Phase A3: out-of-band usage side-channel. sendRequest stays returning string
        // (prompter.js:250 type-checks it); telemetry callers read this after each call.
        this.last_usage = null;

        // SDK default is 2 retries with ~0.5s/1s exponential backoff. Bump to
        // 4 so a transient blip (chunk-loading WAN hiccup, brief 5xx) doesn't
        // instantly flash "brain disconnected" to the player. With backoff
        // the SDK will spend ~7-8s retrying before giving up.
        let config = { maxRetries: 4 };
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
            const resp = await this.anthropic.messages.create({
                model: this.model_name || "claude-sonnet-4-6",
                system: systemMessage,
                messages: messages,
                ...(this.params || {})
            });

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
