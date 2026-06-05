import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically discover model classes in this directory.
// Each model class must export a static `prefix` string.
const apiMap = await (async () => {
    const map = {};
    const files = (await fs.readdir(__dirname))
        .filter(f => f.endsWith('.js') && f !== '_model_map.js' && f !== 'prompter.js');
    for (const file of files) {
        try {
            const moduleUrl = pathToFileURL(path.join(__dirname, file)).href;
            const mod = await import(moduleUrl);
            for (const exported of Object.values(mod)) {
                if (typeof exported === 'function' && Object.prototype.hasOwnProperty.call(exported, 'prefix')) {
                    const prefix = exported.prefix;
                    if (typeof prefix === 'string' && prefix.length > 0) {
                        map[prefix] = exported;
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to load model module:', file, e?.message || e);
        }
    }
    return map;
})();

export function selectAPI(profile) {
    if (typeof profile === 'string' || profile instanceof String) {
        profile = {model: profile};
    }
    // backwards compatibility with local->ollama
    if (profile.api?.includes('local') || profile.model?.includes('local')) {
        profile.api = 'ollama';
        if (profile.model) {
            profile.model = profile.model.replace('local', 'ollama');
        }
    }
    if (!profile.api) {
        const api = Object.keys(apiMap).find(key => profile.model?.startsWith(key));
        if (api) {
            profile.api = api;
        }
        else {
            // check for some common models that do not require prefixes
            if (profile.model.includes('gpt') || profile.model.includes('o1')|| profile.model.includes('o3'))
                profile.api = 'openai';
            else if (profile.model.includes('claude'))
                profile.api = 'anthropic';
            else if (profile.model.includes('gemini'))
                profile.api = "google";
            else if (profile.model.includes('grok'))
                profile.api = 'xai';
            else if (profile.model.includes('mistral'))
                profile.api = 'mistral';
            else if (profile.model.includes('deepseek'))
                profile.api = 'deepseek';
            else if (profile.model.includes('qwen'))
                profile.api = 'qwen';
        }
        if (!profile.api) {
            throw new Error('Unknown model:', profile.model);
        }
    }
    if (!apiMap[profile.api]) {
        throw new Error('Unknown api:', profile.api);
    }
    let model_name = profile.model.replace(profile.api + '/', ''); // remove prefix
    profile.model = model_name === "" ? null : model_name; // if model is empty, set to null
    return profile;
}

// Daedelus404 is Claude-only. We do not use the multi-provider structure
// anymore (the old daedelus404.nvidia.json regime routed to nvidia/llama/groq).
// Every chat/code/vision/embedding client is built through createModel(), so
// guarding here makes it impossible for a stray profile or sub-model to silently
// route to a non-Anthropic provider again — it fails loud at construction.
const ALLOWED_APIS = new Set(['anthropic']);

export function createModel(profile) {
    if (!!apiMap[profile.model]) {
        // if the model value is an api (instead of a specific model name)
        // then set model to null so it uses the default model for that api
        profile.model = null;
    }
    if (!apiMap[profile.api]) {
        throw new Error('Unknown api:', profile.api);
    }
    if (!ALLOWED_APIS.has(profile.api)) {
        throw new Error(`[claude-only] refusing to construct a non-Anthropic model client: api='${profile.api}' model='${profile.model}'. Daedelus404 runs full Claude — fix the profile, do not route to nvidia/llama/groq.`);
    }
    const model = new apiMap[profile.api](profile.model, profile.url, profile.params);
    return model;
}