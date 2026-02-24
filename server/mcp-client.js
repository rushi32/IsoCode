const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class McpClient extends EventEmitter {
    constructor(command, args = []) {
        super();
        this.command = command;
        this.args = args;
        this.process = null;
        this.messageId = 0;
        this.pendingRequests = new Map();
        this.buffer = '';
    }

    async connect() {
        this.process = spawn(this.command, this.args);

        this.process.stdout.on('data', (data) => {
            this.handleData(data);
        });

        this.process.stderr.on('data', (data) => {
            console.error(`[MCP Stderr]: ${data}`);
        });

        return new Promise((resolve) => {
            // Basic initialization handshake would go here if strict MCP
            // For now, assume process start is enough
            resolve();
        });
    }

    handleData(data) {
        this.buffer += data.toString();
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (line.trim()) {
                try {
                    const message = JSON.parse(line);
                    this.handleMessage(message);
                } catch (e) {
                    // Ignore non-JSON lines (maybe initial generic output)
                    // console.log("Non-JSON line:", line);
                }
            }
        }
    }

    handleMessage(message) {
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            if (message.error) {
                reject(message.error);
            } else {
                resolve(message.result);
            }
        }
    }

    async request(method, params) {
        const id = this.messageId++;
        const request = { jsonrpc: "2.0", id, method, params };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            if (this.process) {
                const data = JSON.stringify(request) + "\n";
                this.process.stdin.write(data);
            } else {
                reject(new Error("Not connected"));
            }
        });
    }

    async initialize() {
        return this.request("initialize", {
            protocolVersion: "0.1.0",
            capabilities: { tools: {} },
            clientInfo: { name: "isocode-local", version: "0.1.0" }
        });
    }

    async listTools() {
        return this.request("tools/list", {});
    }

    async callTool(name, args) {
        return this.request("tools/call", { name, arguments: args });
    }
}

module.exports = { McpClient };
