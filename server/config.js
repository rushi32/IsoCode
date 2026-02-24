require('dotenv').config();
const fs = require('fs');
const path = require('path');

let userConfig = {};
const userConfigPath = path.join(process.cwd(), 'user-config.json');
try { userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8')); } catch (e) { }

/**
 * Auto-detect the LLM provider based on API base URL.
 *   - Port 11434 or url containing 'ollama' → 'ollama'
 *   - Port 1234 or url containing 'lmstudio'/'lm-studio' → 'lmstudio'
 *   - Otherwise → 'openai' (generic OpenAI-compatible)
 */
function detectProvider(base) {
    if (!base) return 'ollama';
    const lower = base.toLowerCase();
    if (lower.includes(':11434') || lower.includes('ollama')) return 'ollama';
    if (lower.includes(':1234') || lower.includes('lmstudio') || lower.includes('lm-studio')) return 'lmstudio';
    if (lower.includes('openai.com')) return 'openai';
    return 'openai';
}

function loadMcpServers() {
    const envServers = process.env.MCP_SERVERS ? (() => { try { return JSON.parse(process.env.MCP_SERVERS); } catch { return []; } })() : null;
    if (envServers && envServers.length) return envServers;
    const projectPath = path.join(process.cwd(), '.isocode', 'mcp-servers.json');
    try {
        const raw = fs.readFileSync(projectPath, 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { }
    return [];
}

const LLM_API_BASE = process.env.LLM_API_BASE || userConfig.LLM_API_BASE || 'http://localhost:11434/v1';
const LLM_PROVIDER = process.env.LLM_PROVIDER || userConfig.LLM_PROVIDER || detectProvider(LLM_API_BASE);

function getDefaultModel(provider) {
    if (process.env.LLM_MODEL_ID) return process.env.LLM_MODEL_ID;
    switch (provider) {
        // Empty string means "use whatever model is selected in the UI dropdown"
        // This avoids hardcoding a model name the user may not have pulled
        case 'ollama': return '';
        case 'lmstudio': return '';
        default: return 'gpt-4o-mini';
    }
}

function getDefaultApiKey(provider) {
    if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
    switch (provider) {
        case 'ollama': return 'ollama';
        case 'lmstudio': return 'lm-studio';
        default: return process.env.OPENAI_API_KEY || 'no-key';
    }
}

/**
 * Build the raw (non-/v1) base URL for provider-native API calls.
 * For Ollama: http://localhost:11434
 * For LM Studio: http://localhost:1234
 */
function getNativeBase(apiBase) {
    return (apiBase || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

module.exports = {
    ...userConfig,

    LLM_API_BASE,
    LLM_PROVIDER,
    LLM_MODEL_ID: userConfig.LLM_MODEL_ID || getDefaultModel(LLM_PROVIDER),
    LLM_API_KEY: userConfig.LLM_API_KEY || getDefaultApiKey(LLM_PROVIDER),
    LLM_NATIVE_BASE: getNativeBase(LLM_API_BASE),

    PORT: process.env.PORT || userConfig.PORT || 3000,

    PERMISSIONS: {
        run_shell: process.env.PERMISSIONS_SHELL || 'ask',
        write_file: process.env.PERMISSIONS_WRITE || 'ask',
        replace_in_file: process.env.PERMISSIONS_EDIT || 'ask',
        ...(userConfig.PERMISSIONS || {})
    },

    MCP_SERVERS: loadMcpServers(),

    CONTEXT_WINDOW_SIZE: process.env.CONTEXT_WINDOW_SIZE || userConfig.CONTEXT_WINDOW_SIZE || 16384,
    MAX_HISTORY_MESSAGES: process.env.MAX_HISTORY_MESSAGES || userConfig.MAX_HISTORY_MESSAGES || 30,
    TEMPERATURE: process.env.TEMPERATURE || userConfig.TEMPERATURE || 0.7,
    SYSTEM_PROMPT_PATH: process.env.SYSTEM_PROMPT_PATH || userConfig.SYSTEM_PROMPT_PATH || null,

    detectProvider,
    getNativeBase
};
