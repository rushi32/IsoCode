// server/llm.js
// Multi-provider LLM client: Ollama, LM Studio, OpenAI-compatible.
// Supports both OpenAI-compat /v1/chat/completions and Ollama native /api/chat.

const axios = require('axios');
const config = require('./config.js');

/**
 * Call a chat-completions endpoint.
 * Automatically routes to the correct provider API.
 *
 * @param {object} params
 * @param {string} [params.model] - Model override
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {object} [params.options] - temperature, max_tokens, timeout, expect_json, tools, tool_choice
 * @returns {Promise<string|object>} - Response content string, or object with tool_calls if native tool calling
 */
async function callLLM({ model, messages, options = {} }) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages must be a non-empty array');
    }

    const provider = config.LLM_PROVIDER || 'ollama';
    const resolvedModel = model || config.LLM_MODEL_ID || '';
    const timeoutMs = options.timeout ?? 180000;

    if (!resolvedModel) {
        throw new Error('No model specified. Select a model from the dropdown or set LLM_MODEL_ID in your .env file. For Ollama, pull a model first: ollama pull qwen3-coder');
    }

    console.log(`[LLM] Provider: ${provider}, Model: ${resolvedModel}, Messages: ${messages.length}`);

    if (provider === 'ollama' && !options.forceOpenAI) {
        return callOllama({ model: resolvedModel, messages, options, timeoutMs });
    }

    return callOpenAICompat({ model: resolvedModel, messages, options, timeoutMs });
}

/**
 * Call Ollama's OpenAI-compatible endpoint (/v1/chat/completions).
 * Falls back to native /api/chat if the compat endpoint fails.
 */
async function callOllama({ model, messages, options, timeoutMs }) {
    const base = (config.LLM_API_BASE || '').replace(/\/$/, '');
    const nativeBase = config.LLM_NATIVE_BASE || base.replace(/\/v1$/, '');

    // Try OpenAI-compatible first (preferred - better tool calling support)
    try {
        const result = await callOpenAICompat({ model, messages, options, timeoutMs });
        if (result && String(result).trim()) return result;
    } catch (compatErr) {
        console.log('[LLM] OpenAI-compat endpoint failed, trying Ollama native:', compatErr.message);
    }

    // Fallback: Ollama native /api/chat
    const endpoint = `${nativeBase}/api/chat`;
    console.log('[LLM] Ollama native POST', endpoint);

    const payload = {
        model,
        messages: messages.map(m => ({
            role: m.role === 'tool' ? 'assistant' : m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        })),
        stream: false,
        options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.max_tokens ?? 4096
        }
    };

    if (options.expect_json) {
        payload.format = 'json';
    }

    const res = await axios.post(endpoint, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs
    });

    const data = res.data || {};
    const content = data.message?.content || data.response || '';

    if (content && String(content).trim()) {
        console.log('[LLM] Ollama native response OK, length:', String(content).length);
        return String(content).trim();
    }

    return options.expect_json
        ? JSON.stringify({ type: 'final', content: 'Model returned empty content. Try another model or retry.' })
        : 'Model returned empty content. Try another model or retry.';
}

/**
 * Call an OpenAI-compatible chat/completions endpoint.
 * Works with: Ollama /v1, LM Studio, OpenAI, and other compatible servers.
 */
async function callOpenAICompat({ model, messages, options, timeoutMs }) {
    const base = (config.LLM_API_BASE || '').replace(/\/$/, '');
    const endpoint = base.endsWith('/chat/completions')
        ? base
        : `${base}/chat/completions`;

    const payload = {
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        stream: false
    };

    if (options.max_tokens && options.max_tokens > 0) {
        payload.max_tokens = options.max_tokens;
    }

    if (options.expect_json) {
        payload.response_format = { type: 'json_object' };
    }

    // Native tool calling support
    if (options.tools && Array.isArray(options.tools) && options.tools.length > 0) {
        payload.tools = options.tools;
        if (options.tool_choice) {
            payload.tool_choice = options.tool_choice;
        }
    }

    console.log('[LLM] POST', endpoint, 'model:', model, 'messages:', messages.length);

    const emptyFallback = 'Model returned empty content. Try another model or retry.';

    for (let attempt = 0; attempt < 3; attempt++) {
        const currentPayload = { ...payload };
        if (attempt === 1) {
            currentPayload.max_tokens = 4096;
            currentPayload.temperature = (payload.temperature ?? 0.6);
            delete currentPayload.response_format;
        } else if (attempt === 2) {
            currentPayload.max_tokens = 8192;
            currentPayload.temperature = 0.8;
            delete currentPayload.response_format;
            delete currentPayload.tools;
        }

        let res;
        try {
            res = await axios.post(endpoint, currentPayload, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.LLM_API_KEY}`
                },
                timeout: timeoutMs
            });
        } catch (err) {
            const errData = err.response?.data;
            const msg = errData ? (typeof errData === 'string' ? errData : JSON.stringify(errData)) : err.message;
            const status = err.response?.status;
            console.error('[LLM] Request failed:', status || err.code || err.message, msg);

            // Don't retry on "model not found" — it won't fix itself
            if (msg.includes('not found') || msg.includes('does not exist')) {
                const e = new Error(`Model "${model}" not found. Make sure it is pulled/loaded. For Ollama: ollama pull ${model}`);
                e.response = err.response;
                throw e;
            }

            if (attempt < 2 && (status === 400 || status === 422)) {
                console.warn(`[LLM] Got ${status}, retrying with simpler payload (attempt ${attempt + 2}/3)`);
                continue;
            }
            throw err;
        }

        const data = res.data || {};
        const choice = Array.isArray(data.choices) ? data.choices[0] : null;

        if (!choice) {
            if (attempt < 2) {
                console.warn('[LLM] No choices returned, retrying...');
                continue;
            }
            throw new Error('No choices returned from model');
        }

        // Check for native tool calls
        if (choice.message?.tool_calls && Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) {
            console.log('[LLM] Response contains tool_calls:', choice.message.tool_calls.length);
            return {
                tool_calls: choice.message.tool_calls,
                content: choice.message.content || ''
            };
        }

        const content = extractContent(choice, data);
        if (content && String(content).trim()) {
            console.log('[LLM] Response OK, content length:', String(content).length);
            return String(content);
        }

        if (attempt < 2) {
            console.warn(`[LLM] Empty content, retrying (attempt ${attempt + 2}/3)`);
        }
    }

    return options.expect_json
        ? JSON.stringify({ type: 'final', content: emptyFallback })
        : emptyFallback;
}

/**
 * Exhaustive content extraction for various backend response formats.
 */
function extractContent(choice, fullData) {
    if (!choice) return '';
    const msg = choice.message || choice;

    if (typeof msg?.content === 'string' && msg.content.trim()) return msg.content.trim();

    if (Array.isArray(msg?.content)) {
        const out = msg.content
            .map((p) => {
                if (typeof p === 'string') return p;
                if (p?.type === 'text' && typeof p.text === 'string') return p.text;
                return p?.text ?? p?.content ?? '';
            })
            .filter(Boolean)
            .join('')
            .trim();
        if (out) return out;
    }

    if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
    if (typeof choice.text === 'string' && choice.text.trim()) return choice.text.trim();
    if (typeof msg?.text === 'string' && msg.text.trim()) return msg.text.trim();
    if (fullData && typeof fullData.output === 'string' && fullData.output.trim()) return fullData.output.trim();
    if (fullData && typeof fullData.text === 'string' && fullData.text.trim()) return fullData.text.trim();

    if (fullData?.choices?.[0] && fullData.choices[0] !== choice) {
        const fromFirst = extractContent(fullData.choices[0], null);
        if (fromFirst) return fromFirst;
    }

    for (const v of Object.values(msg || {})) {
        if (typeof v === 'string' && v.trim().length > 0 && v.length < 500000) return v.trim();
    }
    for (const v of Object.values(choice)) {
        if (typeof v === 'string' && v.trim().length > 0 && v.length < 500000) return v.trim();
    }
    return '';
}

/**
 * List models from the provider.
 * Returns array of { id, displayName }.
 */
async function listModels() {
    const provider = config.LLM_PROVIDER || 'ollama';
    const nativeBase = config.LLM_NATIVE_BASE || config.LLM_API_BASE.replace(/\/v1$/, '').replace(/\/$/, '');
    const v1Base = (config.LLM_API_BASE || '').replace(/\/$/, '');

    const results = [];

    // Try Ollama native /api/tags
    if (provider === 'ollama') {
        try {
            const res = await axios.get(`${nativeBase}/api/tags`, { timeout: 8000 });
            const models = res.data?.models || [];
            for (const m of models) {
                const id = m.name || m.model || '';
                if (id) {
                    results.push({
                        id,
                        displayName: m.name || id,
                        size: m.size,
                        modified: m.modified_at
                    });
                }
            }
            if (results.length > 0) {
                console.log(`[LLM] Listed ${results.length} Ollama models`);
                return results;
            }
        } catch (e) {
            console.log('[LLM] Ollama /api/tags failed:', e.message);
        }
    }

    // Fallback: OpenAI-compat /v1/models (works for LM Studio, Ollama /v1, OpenAI)
    try {
        const res = await axios.get(`${v1Base}/models`, {
            headers: { 'Authorization': `Bearer ${config.LLM_API_KEY}` },
            timeout: 8000,
            validateStatus: () => true
        });
        const data = res.data || {};
        let list = data.data || data.models;
        if (!Array.isArray(list)) list = Array.isArray(data) ? data : [];

        for (const m of list) {
            if (typeof m === 'string') {
                results.push({ id: m, displayName: m });
            } else {
                const id = m.id || m.name || m.model || String(m);
                results.push({
                    id,
                    displayName: m.displayName || m.id || m.name || m.model || String(m)
                });
            }
        }
        console.log(`[LLM] Listed ${results.length} models via /v1/models`);
    } catch (e) {
        console.log('[LLM] /v1/models failed:', e.message);
    }

    return results;
}

/**
 * Health check: can we reach the LLM server?
 */
async function healthCheck() {
    const provider = config.LLM_PROVIDER || 'ollama';
    const nativeBase = config.LLM_NATIVE_BASE || config.LLM_API_BASE.replace(/\/v1$/, '').replace(/\/$/, '');

    try {
        if (provider === 'ollama') {
            const res = await axios.get(nativeBase, { timeout: 5000 });
            return { ok: true, provider, message: typeof res.data === 'string' ? res.data.trim() : 'Connected' };
        }
        const res = await axios.get(`${(config.LLM_API_BASE || '').replace(/\/$/, '')}/models`, {
            headers: { 'Authorization': `Bearer ${config.LLM_API_KEY}` },
            timeout: 5000
        });
        return { ok: true, provider, models: (res.data?.data || res.data?.models || []).length };
    } catch (e) {
        return { ok: false, provider, error: e.code === 'ECONNREFUSED' ? `Cannot reach ${provider} server` : e.message };
    }
}

/**
 * Streaming chat — returns an async generator yielding content chunks.
 * For token-by-token streaming in basic chat mode (non-agent).
 */
async function* streamChat({ model, messages, options = {} }) {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('messages must be a non-empty array');
    }

    const provider = config.LLM_PROVIDER || 'ollama';
    const resolvedModel = model || config.LLM_MODEL_ID || '';
    const timeoutMs = options.timeout ?? 120000;

    if (!resolvedModel) {
        throw new Error('No model specified. Select a model from the dropdown.');
    }

    const nativeBase = config.LLM_NATIVE_BASE || config.LLM_API_BASE.replace(/\/v1$/, '').replace(/\/$/, '');

    // Use Ollama native streaming (most reliable for local)
    if (provider === 'ollama') {
        const endpoint = `${nativeBase}/api/chat`;
        const payload = {
            model: resolvedModel,
            messages: messages.map(m => ({
                role: m.role === 'tool' ? 'assistant' : m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            })),
            stream: true,
            options: {
                temperature: options.temperature ?? 0.7,
                num_predict: options.max_tokens ?? 4096
            }
        };

        const res = await axios.post(endpoint, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: timeoutMs,
            responseType: 'stream'
        });

        let buffer = '';
        for await (const chunk of res.data) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const data = JSON.parse(line);
                    if (data.message?.content) {
                        yield data.message.content;
                    }
                    if (data.done) return;
                } catch { }
            }
        }
        return;
    }

    // OpenAI-compatible streaming
    const base = (config.LLM_API_BASE || '').replace(/\/$/, '');
    const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const payload = {
        model: resolvedModel,
        messages,
        temperature: options.temperature ?? 0.7,
        stream: true
    };
    if (options.max_tokens) payload.max_tokens = options.max_tokens;

    const res = await axios.post(endpoint, payload, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLM_API_KEY}`
        },
        timeout: timeoutMs,
        responseType: 'stream'
    });

    let buffer = '';
    for await (const chunk of res.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.replace(/^data:\s*/, '').trim();
            if (!trimmed || trimmed === '[DONE]') continue;
            try {
                const data = JSON.parse(trimmed);
                const delta = data.choices?.[0]?.delta?.content;
                if (delta) yield delta;
                if (data.choices?.[0]?.finish_reason === 'stop') return;
            } catch { }
        }
    }
}

/**
 * Call LLM with an image for visual analysis (vision/multimodal models).
 * Supports Ollama vision models (llava, qwen-vl, etc.) and OpenAI vision.
 */
async function callVisionLLM({ model, prompt, imageBase64, mimeType = 'image/png', options = {} }) {
    const provider = config.LLM_PROVIDER || 'ollama';
    const resolvedModel = model || config.LLM_MODEL_ID || '';
    const timeoutMs = options.timeout ?? 120000;

    if (!resolvedModel) throw new Error('No model specified');

    const nativeBase = config.LLM_NATIVE_BASE || config.LLM_API_BASE.replace(/\/v1$/, '').replace(/\/$/, '');

    if (provider === 'ollama') {
        // Ollama native vision: /api/chat with images array
        const endpoint = `${nativeBase}/api/chat`;
        const payload = {
            model: resolvedModel,
            messages: [{
                role: 'user',
                content: prompt,
                images: [imageBase64]
            }],
            stream: false,
            options: {
                temperature: options.temperature ?? 0.5,
                num_predict: options.max_tokens ?? 2048
            }
        };

        try {
            const res = await axios.post(endpoint, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: timeoutMs
            });
            return res.data?.message?.content || res.data?.response || '';
        } catch (nativeErr) {
            console.log('[LLM] Ollama native vision failed, trying OpenAI-compat:', nativeErr.message);
        }
    }

    // OpenAI-compatible vision format
    const base = (config.LLM_API_BASE || '').replace(/\/$/, '');
    const endpoint = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;

    const payload = {
        model: resolvedModel,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
            ]
        }],
        temperature: options.temperature ?? 0.5,
        max_tokens: options.max_tokens ?? 2048,
        stream: false
    };

    const res = await axios.post(endpoint, payload, {
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.LLM_API_KEY}`
        },
        timeout: timeoutMs
    });

    const choice = res.data?.choices?.[0];
    return choice?.message?.content || '';
}

module.exports = {
    callLLM,
    callVisionLLM,
    streamChat,
    listModels,
    healthCheck,
    extractContent
};
