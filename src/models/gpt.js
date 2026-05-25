import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import { makeRateLimitedClient } from './rate_limited_client.js';
import { toOpenAITools, fromOpenAIResponse, buildRetryMessage } from './tool_protocol.js';

export class GPT {
    static prefix = 'openai';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url; // store so that we know whether a custom URL has been set

        // v2 Step 1: NVIDIA Build is the burst-prone provider (40 RPM, today's
        // 12 × 429s). Pick provider by base URL so the throttle/retry budget
        // matches the real API.
        const provider = (url && url.includes('integrate.api.nvidia.com')) ? 'nvidia' : 'openai';
        this.rate_limiter = makeRateLimitedClient(provider);

        let config = {};
        if (url)
            config.baseURL = url;

        if (hasKey('OPENAI_ORG_ID'))
            config.organization = getKey('OPENAI_ORG_ID');

        // NVIDIA Build is OpenAI-compatible but needs its own key so it doesn't collide with real OpenAI usage.
        if (url && url.includes('integrate.api.nvidia.com') && hasKey('NVIDIA_API_KEY'))
            config.apiKey = getKey('NVIDIA_API_KEY');
        else
            config.apiKey = getKey('OPENAI_API_KEY');

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = strictFormat(turns);
        messages = messages.map(message => {
            message.content += stop_seq;
            return message;
        });
        let model = this.model_name || "gpt-5.4-mini";

        let res = null;

        try {
            console.log('Awaiting openai api response from model', model);
            // if a custom URL is set, use chat.completions
            // because custom "OpenAI-compatible" endpoints likely do not have responses endpoint
            if (this.url) {
                let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
                messages = strictFormat(messages);
                const pack = {
                    model: model,
                    messages,
                    stop: stop_seq,
                    ...(this.params || {})
                };
                if (model.includes('o1') || model.includes('o3') || model.includes('5')) {
                    delete pack.stop;
                }
                const chatCall = () => this.openai.chat.completions.create(pack);
                let completion = this.rate_limiter ? await this.rate_limiter.send(chatCall) : await chatCall();
                if (completion.choices[0].finish_reason == 'length')
                    throw new Error('Context length exceeded');
                console.log('Received.');
                res = completion.choices[0].message.content;
            }
            // otherwise, use responses
            else {
                let messages = strictFormat(turns);
                messages = messages.map(message => {
                    message.content += stop_seq;
                    return message;
                });
                const respCall = () => this.openai.responses.create({
                    model: model,
                    instructions: systemMessage,
                    input: messages,
                    ...(this.params || {})
                });
                const response = this.rate_limiter ? await this.rate_limiter.send(respCall) : await respCall();
                console.log('Received.');
                res = response.output_text;
                let stop_seq_index = res.indexOf(stop_seq);
                res = stop_seq_index !== -1 ? res.slice(0, stop_seq_index) : res;
            }
        }
        catch (err) {
            if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else if (err.message.includes('image_url')) {
                console.log(err);
                res = 'Vision is only supported by certain models.';
            } else if (err?.status === 429) {
                // Distinct from a true brain-disconnect — the rate limiter
                // exhausted its retry budget. Don't say "disconnected": the
                // bot is fine, just throttled. The phrasing here lands in
                // history, so keep it factual to avoid the model adopting
                // a panicked tone next turn.
                console.warn('[gpt] 429 budget exhausted, falling through');
                res = "(rate limited, give me a sec)";
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    // v2 Step 3: structured tool-use path for OpenAI-compatible providers.
    // Returns the neutral tool-protocol shape. Tolerant of NVIDIA llama
    // emitting malformed JSON in tool_calls.arguments: ONE structured
    // re-prompt with the parse error in context, then surface.
    // See docs/agent-blueprint.md §3 Step 3 rev-2.
    //
    // `turns` is the OpenAI-native shape (assistant turns may carry
    // tool_calls[]; tool_result turns are role:'tool' with tool_call_id).
    // Callers convert from the orchestrator's neutral shape via
    // neutralToOpenAI() before calling. strictFormat() is skipped here —
    // it normalizes string content but mangles the tool_calls structure.
    async sendRequestWithTools(turns, systemMessage, toolDescriptors) {
        const model = this.model_name || "gpt-5.4-mini";
        const tools = toOpenAITools(toolDescriptors || []);
        const baseMessages = [{ role: 'system', content: systemMessage }, ...(turns || [])];

        const callWith = (msgs) => this.openai.chat.completions.create({
            model,
            messages: msgs,
            tools,
            tool_choice: 'auto',
            ...(this.params || {}),
        });

        try {
            const resp1 = this.rate_limiter
                ? await this.rate_limiter.send(() => callWith(baseMessages))
                : await callWith(baseMessages);
            let parsed = fromOpenAIResponse(resp1);
            if (parsed.parseErrors.length === 0) return parsed;

            // One retry budget. Inject a system explanation of what failed,
            // ask the model to re-emit. Surface whatever comes back next.
            console.warn(`[gpt:tool_use] ${parsed.parseErrors.length} parse error(s); retrying once`);
            const retryMsg = buildRetryMessage(parsed.parseErrors);
            const retryMessages = [...baseMessages, { role: 'assistant', content: parsed.text || '' }, retryMsg];
            const resp2 = this.rate_limiter
                ? await this.rate_limiter.send(() => callWith(retryMessages))
                : await callWith(retryMessages);
            return fromOpenAIResponse(resp2);
        } catch (err) {
            console.log('[gpt:tool_use] error:', err?.message || err);
            return { text: 'My brain disconnected, try again.', toolCalls: [], stopReason: 'error', parseErrors: [], raw: null };
        }
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "input_text", text: systemMessage },
                {
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || "text-embedding-3-small",
            input: text,
            encoding_format: "float",
        });
        return embedding.data[0].embedding;
    }

}

const sendAudioRequest = async (text, model, voice, url) => {
    const payload = {
        model: model,
        voice: voice,
        input: text
    }

    let config = {};

    if (url)
        config.baseURL = url;

    if (hasKey('OPENAI_ORG_ID'))
        config.organization = getKey('OPENAI_ORG_ID');

    config.apiKey = getKey('OPENAI_API_KEY');

    const openai = new OpenAIApi(config);

    const mp3 = await openai.audio.speech.create(payload);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const base64 = buffer.toString("base64");
    return base64;
}

export const TTSConfig = {
    sendAudioRequest: sendAudioRequest,
    baseUrl: 'https://api.openai.com/v1',
}
