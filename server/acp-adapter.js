#!/usr/bin/env node
/**
 * IsoCode ACP (Agent Client Protocol) Adapter
 *
 * Runs as a subprocess. Reads JSON-RPC 2.0 from stdin (newline-delimited),
 * writes JSON-RPC 2.0 to stdout. Translates ACP methods to IsoCode server HTTP/SSE.
 *
 * Enables any ACP-compatible IDE (Zed, JetBrains with ACP, Neovim, Emacs) to use
 * IsoCode without a custom plugin.
 *
 * Usage:
 *   ISOCODE_SERVER_URL=http://localhost:3000 node server/acp-adapter.js
 *   Or from ACP client: command = "node", args = ["/path/to/server/acp-adapter.js"]
 *
 * Environment:
 *   ISOCODE_SERVER_URL - Base URL of IsoCode server (default http://localhost:3000)
 */

const readline = require('readline');
const axios = require('axios');

const SERVER_URL = (process.env.ISOCODE_SERVER_URL || process.env.ISOCODE_SERVER || 'http://localhost:3000').replace(/\/$/, '');
const PROTOCOL_VERSION = 1;

// Session state: sessionId -> { cwd, mcpServers }
const sessions = new Map();
let nextSessionNum = 1;
// In-flight prompt state: jsonrpc id -> { sessionId, cancelled }
const inflightPrompts = new Map();

function send(msg) {
    const line = JSON.stringify(msg) + '\n';
    process.stdout.write(line);
}

function sendNotification(method, params) {
    send({ jsonrpc: '2.0', method, params });
}

function sendResponse(id, result, error) {
    const msg = { jsonrpc: '2.0', id };
    if (error) msg.error = error;
    else msg.result = result;
    send(msg);
}

function parsePromptContent(prompt) {
    if (!Array.isArray(prompt)) return '';
    const parts = [];
    for (const block of prompt) {
        if (block.type === 'text' && block.text) parts.push(block.text);
        if (block.type === 'resource' && block.resource) {
            const r = block.resource;
            if (r.text) parts.push(r.text);
            else if (r.uri) parts.push(`[Resource: ${r.uri}]`);
        }
    }
    return parts.join('\n\n').trim();
}

async function handleInitialize(params, id) {
    const clientVersion = params?.protocolVersion ?? 1;
    const version = Math.min(PROTOCOL_VERSION, clientVersion);
    sendResponse(id, {
        protocolVersion: version,
        agentCapabilities: {
            loadSession: false,
            promptCapabilities: {
                text: true,
                embeddedContext: true
            },
            mcpCapabilities: { http: false, sse: false }
        },
        agentInfo: {
            name: 'isocode',
            title: 'IsoCode',
            version: '0.0.9'
        },
        authMethods: []
    });
}

async function handleSessionNew(params, id) {
    const cwd = params?.cwd || process.cwd();
    const mcpServers = params?.mcpServers || [];
    const sessionId = 'isocode_' + String(nextSessionNum++);
    sessions.set(sessionId, { cwd, mcpServers });
    sendResponse(id, { sessionId });
}

async function handleSessionLoad(params, id) {
    sendResponse(id, null, { code: -32601, message: 'session/load not supported' });
}

async function handleSessionPrompt(params, id) {
    const sessionId = params?.sessionId;
    const prompt = params?.prompt;
    if (!sessionId || !prompt) {
        sendResponse(id, null, { code: -32602, message: 'sessionId and prompt required' });
        return;
    }

    const session = sessions.get(sessionId);
    const workspaceRoot = session?.cwd || process.cwd();
    const message = parsePromptContent(prompt);

    inflightPrompts.set(id, { sessionId, cancelled: false });
    let responded = false;

    try {
        const res = await axios({
            method: 'POST',
            url: `${SERVER_URL}/chat`,
            data: {
                message,
                autoMode: true,
                agentPlus: true,
                sessionId,
                workspaceRoot,
                context: []
            },
            responseType: 'stream',
            headers: { Accept: 'text/event-stream' },
            timeout: 0,
            validateStatus: () => true
        });

        if (res.status !== 200) {
            let errMsg = 'Request failed';
            try {
                const body = await streamToBuffer(res.data);
                errMsg = body.toString('utf8');
                const j = JSON.parse(errMsg);
                errMsg = j.error || j.details || errMsg;
            } catch (_) {}
            responded = true;
            sendResponse(id, null, { code: -32000, message: errMsg });
            inflightPrompts.delete(id);
            return;
        }

        let buffer = '';
        let toolCallCounter = 0;
        let currentToolCallId = null;

        res.data.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const payload = JSON.parse(line.slice(6));
                        const type = payload.type;
                        const sid = sessionId;

                        if (type === 'thought' && payload.content) {
                            sendNotification('session/update', {
                                sessionId: sid,
                                update: {
                                    sessionUpdate: 'agent_message_chunk',
                                    content: { type: 'text', text: payload.content }
                                }
                            });
                        } else if (type === 'action' && payload.tool) {
                            currentToolCallId = 'call_' + (++toolCallCounter);
                            sendNotification('session/update', {
                                sessionId: sid,
                                update: {
                                    sessionUpdate: 'tool_call',
                                    toolCallId: currentToolCallId,
                                    title: payload.tool,
                                    kind: 'other',
                                    status: 'pending'
                                }
                            });
                            sendNotification('session/update', {
                                sessionId: sid,
                                update: {
                                    sessionUpdate: 'tool_call_update',
                                    toolCallId: currentToolCallId,
                                    status: 'in_progress'
                                }
                            });
                        } else if (type === 'observation') {
                            const content = typeof payload.content === 'string'
                                ? payload.content
                                : JSON.stringify(payload.content);
                            if (currentToolCallId) {
                                sendNotification('session/update', {
                                    sessionId: sid,
                                    update: {
                                        sessionUpdate: 'tool_call_update',
                                        toolCallId: currentToolCallId,
                                        status: 'completed',
                                        content: [{ type: 'content', content: { type: 'text', text: content } }]
                                    }
                                });
                                currentToolCallId = null;
                            } else {
                                sendNotification('session/update', {
                                    sessionId: sid,
                                    update: {
                                        sessionUpdate: 'agent_message_chunk',
                                        content: { type: 'text', text: content }
                                    }
                                });
                            }
                        } else if (type === 'diff_request') {
                            sendNotification('session/update', {
                                sessionId: sid,
                                update: {
                                    sessionUpdate: 'agent_message_chunk',
                                    content: {
                                        type: 'text',
                                        text: `[Diff proposed for ${payload.filePath || 'file'}; Agent+ auto-applies]`
                                    }
                                }
                            });
                        } else if (type === 'final') {
                            if (payload.content) {
                                sendNotification('session/update', {
                                    sessionId: sid,
                                    update: {
                                        sessionUpdate: 'agent_message_chunk',
                                        content: { type: 'text', text: payload.content }
                                    }
                                });
                            }
                            if (!responded) {
                                const st = inflightPrompts.get(id);
                                const stopReason = st?.cancelled ? 'cancelled' : 'end_turn';
                                responded = true;
                                sendResponse(id, { stopReason });
                                inflightPrompts.delete(id);
                            }
                        }
                    } catch (_) {}
                }
            }
        });

        res.data.on('end', () => {
            if (responded) return;
            const state = inflightPrompts.get(id);
            if (!state) return;
            responded = true;
            sendResponse(id, { stopReason: state.cancelled ? 'cancelled' : 'end_turn' });
            inflightPrompts.delete(id);
        });

        res.data.on('error', (err) => {
            if (responded) return;
            const state = inflightPrompts.get(id);
            if (!state) return;
            responded = true;
            sendResponse(id, null, { code: -32001, message: err.message });
            inflightPrompts.delete(id);
        });
    } catch (err) {
        if (!responded) responded = true;
        const message = err.response?.data?.message || err.message || String(err);
        sendResponse(id, null, { code: -32002, message });
        inflightPrompts.delete(id);
    }
}

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

async function handleSessionCancel(params, id) {
    const sessionId = params?.sessionId;
    if (!sessionId) {
        if (id !== undefined) sendResponse(id, null, { code: -32602, message: 'sessionId required' });
        return;
    }
    for (const [promptId, state] of inflightPrompts.entries()) {
        if (state.sessionId === sessionId) {
            state.cancelled = true;
        }
    }
    try {
        await axios.post(`${SERVER_URL}/stop-agent`, { sessionId }, { timeout: 5000 });
    } catch (_) {}
    if (id !== undefined) sendResponse(id, { cancelled: true });
}

const methodHandlers = {
    initialize: handleInitialize,
    'session/new': handleSessionNew,
    'session/load': handleSessionLoad,
    'session/prompt': handleSessionPrompt,
    'session/cancel': handleSessionCancel
};

function main() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', async (line) => {
        line = line.trim();
        if (!line) return;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
        }
        if (msg.jsonrpc !== '2.0') return;
        const method = msg.method;
        const id = msg.id;
        const params = msg.params || {};

        if (method) {
            const handler = methodHandlers[method];
            if (handler) {
                try {
                    await handler(params, id);
                } catch (err) {
                    if (id !== undefined) {
                        sendResponse(id, null, { code: -32603, message: err.message || String(err) });
                    }
                }
            } else if (id !== undefined) {
                sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
            }
        }
    });
}

main();
