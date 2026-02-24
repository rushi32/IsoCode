import * as vscode from "vscode";
import axios from "axios";
import { applyPatch } from 'diff';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { applyUnifiedDiff } from './utils/applyUnifiedDiff';


export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private output!: vscode.OutputChannel;
    private liveSyncDisposables: vscode.Disposable[] = [];
    private activeContextDebounce?: NodeJS.Timeout;
    private lastUsedModel?: string;
    private lastUsedAgentPlus: boolean = false;
    _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {
        this.output = vscode.window.createOutputChannel('IsoCode');
    }

    dispose(): void {
        if (this.activeContextDebounce) {
            clearTimeout(this.activeContextDebounce);
            this.activeContextDebounce = undefined;
        }
        for (const d of this.liveSyncDisposables) d.dispose();
        this.liveSyncDisposables = [];
        this.output?.dispose();
    }

    getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /** Get the agent server URL from configuration. */
    private getServerUrl(): string {
        const a = vscode.workspace.getConfiguration('isocode').get<string>('serverUrl');
        const b = vscode.workspace.getConfiguration('isocode-local').get<string>('serverUrl');
        return (a || b || 'http://localhost:3000').replace(/\/$/, '');
    }

    /** Fetch model list from server. Supports Ollama, LM Studio, and OpenAI backends. */
    private async fetchModels(): Promise<Array<{ id: string; displayName: string }>> {
        try {
            const serverUrl = this.getServerUrl();
            const response = await axios.get(`${serverUrl}/models`, { timeout: 15000 });
            const raw = response.data?.models;
            const provider = response.data?.provider || 'unknown';
            const list = Array.isArray(raw) ? raw : [];
            this.output.appendLine(`IsoCode: fetched ${list.length} models from ${provider} provider`);
            if (response.data?.error) {
                this.output.appendLine(`IsoCode: model fetch warning: ${response.data.error}`);
            }
            return list.map((m: any) => ({
                id: m.id || m.name || m.model || String(m),
                displayName: m.displayName || m.id || m.name || m.model || String(m)
            }));
        } catch (e: any) {
            this.output.appendLine(`IsoCode: fetch models failed - ${e?.message || String(e)}`);
            if (e?.code === 'ECONNREFUSED') {
                this.output.appendLine('IsoCode: Agent server is not running. Start it with: npm start (from project root)');
            }
            return [];
        }
    }

    /** Check if the agent server and LLM backend are healthy. */
    private async checkHealth(): Promise<{ ok: boolean; provider?: string; error?: string }> {
        try {
            const serverUrl = this.getServerUrl();
            const response = await axios.get(`${serverUrl}/health`, { timeout: 8000 });
            return response.data || { ok: false };
        } catch (e: any) {
            return { ok: false, error: e?.code === 'ECONNREFUSED' ? 'Agent server not running' : e?.message };
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
        };

        // Same as extension_old: set full HTML once (no loading, no replace). Models come via get-models.
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, []);

        const fetchAndPushModels = async () => {
            const list = await this.fetchModels();
            webviewView.webview.postMessage({ type: 'models', value: list });
            // Also check health and inform the UI
            const health = await this.checkHealth();
            webviewView.webview.postMessage({ type: 'health', value: health });
        };

        const postDocumentAsContext = (doc: vscode.TextDocument) => {
            try {
                if (doc.isUntitled || doc.uri.scheme !== 'file') return;
                const maxChars = 12000;
                const text = doc.getText();
                const content = text.length > maxChars ? text.slice(0, maxChars) + '\n...[truncated]' : text;
                webviewView.webview.postMessage({
                    type: "add-context-blob",
                    value: { name: path.basename(doc.fileName), content, path: doc.fileName }
                });
            } catch (_) {
                // Ignore transient editor/doc errors.
            }
        };

        const postActiveEditorContext = () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            postDocumentAsContext(editor.document);
        };

        const maxContextChars = 12000;
        const getOpenEditorFiles = (): { path: string; name: string; content: string }[] => {
            const files: { path: string; name: string; content: string }[] = [];
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.isUntitled || doc.uri.scheme !== 'file') continue;
                const text = doc.getText();
                const content = text.length > maxContextChars ? text.slice(0, maxContextChars) + '\n...[truncated]' : text;
                files.push({ path: doc.fileName, name: path.basename(doc.fileName), content });
            }
            return files;
        };

        const postSidebarOpened = () => {
            const openEditorFiles = getOpenEditorFiles();
            webviewView.webview.postMessage({ type: 'sidebar-opened', openEditorFiles });
        };

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                setTimeout(() => postSidebarOpened(), 150);
            }
        });

        // Re-register live-sync listeners each time this view resolves.
        for (const d of this.liveSyncDisposables) d.dispose();
        this.liveSyncDisposables = [];
        this.liveSyncDisposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) postDocumentAsContext(editor.document);
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                const active = vscode.window.activeTextEditor;
                if (!active) return;
                if (event.document.uri.toString() !== active.document.uri.toString()) return;
                if (this.activeContextDebounce) clearTimeout(this.activeContextDebounce);
                this.activeContextDebounce = setTimeout(() => postDocumentAsContext(event.document), 350);
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                const active = vscode.window.activeTextEditor;
                if (!active) return;
                if (doc.uri.toString() !== active.document.uri.toString()) return;
                postDocumentAsContext(doc);
            })
        );
        // Don't push active editor on resolve; sidebar-opened (on visibility) sets context to open editors only

        webviewView.webview.onDidReceiveMessage(async (data) => {
            this.output.appendLine(`IsoCode: received message type=${data?.type ?? 'undefined'}`);
            if (data?.type === 'ask') this.output.show();
            switch (data?.type) {
                case "ask": {
                    if (!data.value) {
                        webviewView.webview.postMessage({ type: 'addResponse', value: '❌ No message to send.' });
                        return;
                    }
                    const serverUrl = this.getServerUrl();
                    const endpoint = serverUrl + '/chat';
                    // Track the model and mode for agent resume
                    if (data.model) { this.lastUsedModel = data.model; }
                    this.lastUsedAgentPlus = !!(data as any).agentPlus;
                    const payload: any = {
                        message: data.value,
                        autoMode: !!data.autoMode,
                        agentPlus: this.lastUsedAgentPlus,
                        model: data.model || undefined,
                        sessionId: (data as any).sessionId || 'default',
                        workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
                    };
                    if ((data as any).contextBlobs && Array.isArray((data as any).contextBlobs)) {
                        payload.context = (data as any).contextBlobs;
                    }
                    this.output.appendLine(`IsoCode: POST ${endpoint} (agent=${payload.autoMode}, model=${payload.model || 'default'})`);
                    try {
                        if (!payload.autoMode) {
                            // --- STREAMING BASIC CHAT ---
                            try {
                                const streamRes = await axios.request({
                                    url: endpoint,
                                    method: 'post',
                                    data: payload,
                                    responseType: 'stream',
                                    timeout: 120000,
                                    headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' }
                                });
                                let fullResponse = '';
                                let streamBubbleCreated = false;
                                const processChatChunk = (eventText: string) => {
                                    const lines = eventText.split(/\r?\n/).filter((l: string) => l.startsWith('data:'));
                                    for (const line of lines) {
                                        const raw = line.replace(/^data:\s*/, '').trim();
                                        if (!raw || raw === '[DONE]') continue;
                                        try {
                                            const parsed = JSON.parse(raw);
                                            if (parsed.type === 'chunk' && parsed.content) {
                                                fullResponse += parsed.content;
                                                webviewView.webview.postMessage({ type: 'stream-chunk', content: parsed.content, first: !streamBubbleCreated });
                                                streamBubbleCreated = true;
                                            } else if (parsed.type === 'done') {
                                                webviewView.webview.postMessage({ type: 'stream-end', content: fullResponse });
                                            } else if (parsed.type === 'error') {
                                                webviewView.webview.postMessage({ type: 'addResponse', value: '❌ ' + parsed.content });
                                            }
                                        } catch { }
                                    }
                                };
                                await new Promise<void>((resolve, reject) => {
                                    let pending = '';
                                    streamRes.data.on('data', (chunk: Buffer) => {
                                        pending += chunk.toString();
                                        const events = pending.split(/\r?\n\r?\n/);
                                        pending = events.pop() || '';
                                        for (const ev of events) processChatChunk(ev);
                                    });
                                    streamRes.data.on('end', () => {
                                        if (pending.trim()) processChatChunk(pending);
                                        if (!streamBubbleCreated) {
                                            // Fallback: streaming didn't work, server returned normal JSON
                                        }
                                        resolve();
                                    });
                                    streamRes.data.on('error', reject);
                                });
                            } catch (streamErr: any) {
                                // Fallback to non-streaming if SSE fails
                                this.output.appendLine('IsoCode: stream failed, falling back to non-streaming: ' + streamErr.message);
                                const response = await axios.post(endpoint, payload, {
                                    timeout: 120000,
                                    headers: { 'Content-Type': 'application/json' }
                                });
                                const resData = response.data;
                                const text = typeof resData === 'string' ? resData
                                    : resData?.response || resData?.output
                                    || (resData?.choices?.[0]?.text || resData?.choices?.[0]?.message?.content)
                                    || JSON.stringify(resData);
                                webviewView.webview.postMessage({ type: 'addResponse', value: text });
                            }
                        } else if (payload.autoMode) {
                            const agentTimeout = payload.agentPlus ? 600000 : 300000;
                            const streamRes = await axios.request({
                                url: endpoint,
                                method: 'post',
                                data: payload,
                                responseType: 'stream',
                                timeout: agentTimeout,
                                headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' }
                            });
                            let pending = '';
                            let sawFinal = false;
                            let sawDiffRequest = false;
                            const processSseEvent = (eventChunk: string) => {
                                const lines = eventChunk.split(/\r?\n/).filter((l: string) => l.startsWith('data:'));
                                for (const line of lines) {
                                    const raw = line.replace(/^data:\s*/, '').trim();
                                    if (!raw || raw === '[DONE]') continue;
                                    try {
                                        const parsed = JSON.parse(raw);
                                        if (parsed.type === 'final' && parsed.content != null) {
                                            sawFinal = true;
                                            webviewView.webview.postMessage({ type: 'addResponse', value: String(parsed.content) });
                                            continue;
                                        }
                                        if (parsed.type === 'diff_request') {
                                            sawDiffRequest = true;
                                        }
                                        webviewView.webview.postMessage(parsed);
                                    } catch {
                                        // ignore malformed SSE item
                                    }
                                }
                            };
                            await new Promise<void>((resolve, reject) => {
                                streamRes.data.on('data', (chunk: Buffer) => {
                                    pending += chunk.toString();
                                    const events = pending.split(/\r?\n\r?\n/);
                                    pending = events.pop() || '';
                                    for (const ev of events) processSseEvent(ev);
                                });
                                streamRes.data.on('end', () => {
                                    if (pending.trim()) processSseEvent(pending);
                                    // diff_request is expected to end without final (waiting for user approval)
                                    if (!sawFinal && !sawDiffRequest) {
                                        webviewView.webview.postMessage({ type: 'addResponse', value: '⚠️ Agent stream ended unexpectedly. Try again or use /compact to free context.' });
                                    }
                                    resolve();
                                });
                                streamRes.data.on('error', reject);
                            });
                        }
                    } catch (error: any) {
                        const details = error.response?.data?.details;
                        const errObj = error.response?.data?.error;
                        const hint = error.response?.data?.hint || '';
                        const msg = (typeof details === 'string' ? details : details ? JSON.stringify(details) : undefined)
                            ?? (typeof errObj === 'string' ? errObj : errObj ? JSON.stringify(errObj) : undefined)
                            ?? error.message
                            ?? String(error);
                        let userMsg = msg;
                        if (error.code === 'ECONNREFUSED') {
                            userMsg = 'Cannot connect to agent server. Make sure it is running (npm start from project root).';
                        } else if (hint) {
                            userMsg = `${msg}\n\n${hint}`;
                        }
                        this.output.appendLine(`IsoCode: chat error: ${userMsg}`);
                        webviewView.webview.postMessage({ type: 'addResponse', value: '❌ ' + userMsg });
                    }
                    break;
                }
                case "search-files": {
                    const query = (data.value as string).toLowerCase();

                    // Respect .isoexclude patterns (IsoCode)
                    const excludePatterns: string[] = [];
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        for (const folder of workspaceFolders) {
                            try {
                                const excludeUri = vscode.Uri.joinPath(folder.uri, '.isoexclude');
                                const doc = await vscode.workspace.openTextDocument(excludeUri);
                                const lines = doc.getText().split('\n');
                                for (const line of lines) {
                                    const trimmed = line.trim();
                                    if (trimmed && !trimmed.startsWith('#')) {
                                        excludePatterns.push(trimmed);
                                        excludePatterns.push(`**/${trimmed}`);
                                    }
                                }
                            } catch {
                                // no .isoexclude, ignore
                            }
                        }
                    }

                    const excludeGlob = excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : undefined;
                    const files = await vscode.workspace.findFiles('**/*', excludeGlob);
                    const matches = files
                        .filter(f =>
                            f.fsPath.toLowerCase().includes(query) ||
                            f.fsPath.split(/[\\/]/).pop()?.toLowerCase().includes(query)
                        )
                        .slice(0, 10)
                        .map(f => ({
                            label: f.fsPath.split(/[\\/]/).pop(),
                            path: f.fsPath
                        }));

                    webviewView.webview.postMessage({
                        type: "search-results",
                        value: matches
                    });
                    break;
                }
                case "get-active-file": {
                    postActiveEditorContext();
                    break;
                }
                case "select-context-files": {
                    const files = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        openLabel: 'Add to Context',
                        canSelectFiles: true,
                        canSelectFolders: true
                    });

                    if (files && files.length > 0) {
                        const maxFiles = 50;
                        const maxCharsPerFile = 12000;
                        let added = 0;
                        for (const uri of files) {
                            if (added >= maxFiles) break;
                            try {
                                const stat = await vscode.workspace.fs.stat(uri);
                                if (stat.type === vscode.FileType.Directory) {
                                    const pattern = new vscode.RelativePattern(uri, '**/*');
                                    const folderFiles = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 80);
                                    for (const f of folderFiles) {
                                        if (added >= maxFiles) break;
                                        try {
                                            const doc = await vscode.workspace.openTextDocument(f);
                                            const text = doc.getText();
                                            const content = text.length > maxCharsPerFile ? text.slice(0, maxCharsPerFile) + '\n...[truncated]' : text;
                                            webviewView.webview.postMessage({
                                                type: "add-context-blob",
                                                value: { name: f.fsPath.split(/[\\/]/).pop(), content, path: f.fsPath }
                                            });
                                            added++;
                                        } catch (_) { /* skip binary/large */ }
                                    }
                                } else {
                                    const doc = await vscode.workspace.openTextDocument(uri);
                                    const text = doc.getText();
                                    const content = text.length > maxCharsPerFile ? text.slice(0, maxCharsPerFile) + '\n...[truncated]' : text;
                                    webviewView.webview.postMessage({
                                        type: "add-context-blob",
                                        value: { name: uri.fsPath.split(/[\\/]/).pop(), content, path: uri.fsPath }
                                    });
                                    added++;
                                }
                            } catch (e) {
                                console.error("Error reading file/folder:", e);
                            }
                        }
                    }
                    break;
                }
                case "add-workspace-folder-context": {
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
                    if (!root) break;
                    const pattern = new vscode.RelativePattern(root, '**/*');
                    const allFiles = await vscode.workspace.findFiles(pattern, '**/node_modules/**,**/.git/**,**/dist/**,**/out/**', 100);
                    const maxChars = 8000;
                    let count = 0;
                    for (const f of allFiles) {
                        if (count >= 60) break;
                        try {
                            const doc = await vscode.workspace.openTextDocument(f);
                            const text = doc.getText();
                            const content = text.length > maxChars ? text.slice(0, maxChars) + '\n...[truncated]' : text;
                            webviewView.webview.postMessage({
                                type: "add-context-blob",
                                value: { name: f.fsPath.split(/[\\/]/).pop(), content, path: f.fsPath }
                            });
                            count++;
                        } catch (_) { }
                    }
                    vscode.window.showInformationMessage(`Added ${count} files from workspace to context.`);
                    break;
                }
                case "read-file-context": {
                    const filePath = data.value as string;
                    try {
                        const uri = vscode.Uri.file(filePath);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        webviewView.webview.postMessage({
                            type: "add-context-blob",
                            value: { name: filePath.split(/[\\/]/).pop(), content: doc.getText(), path: filePath }
                        });
                    }
                    catch (e) {
                        console.error("Error reading context file:", e);
                    }
                    break;
                }
                case "insert-at-cursor": {
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        const text = data.value as string;
                        editor.edit((editBuilder) => {
                            editBuilder.replace(editor.selection, text);
                        });
                    }
                    else {
                        vscode.window.showWarningMessage("No active editor found to insert code");
                    }
                    break;
                }
                case "create-new-session": {
                    // Clear old agent session on the server
                    const oldSessionId = (data as any).oldSessionId;
                    if (oldSessionId) {
                        try {
                            const serverUrl = this.getServerUrl();
                            await axios.post(`${serverUrl}/clear-session`, { sessionId: oldSessionId }, { timeout: 5000 });
                        } catch { }
                    }
                    webviewView.webview.postMessage({ type: "clear-chat" });
                    break;
                }
                case "close-sidebar": {
                    vscode.commands.executeCommand("workbench.action.closeSidebar");
                    break;
                }
                case "get-settings": {
                    const config = vscode.workspace.getConfiguration('isocode');
                    const shellPerm = config.get<string>('shellPermissions', 'ask');
                    const editPerm = config.get<string>('editPermissions', 'ask');
                    const mcpCfg = config.get<string>('mcpConfig', '');
                    const sysPrompt = config.get<string>('systemPrompt', '');
                    const historyLimit = config.get<number>('historyLimit', 50);
                    const contextWindow = config.get<number>('contextWindow', 10);
                    const mcpEnabled = config.get<boolean>('mcpEnabled', false);
                    webviewView.webview.postMessage({
                        type: "settings",
                        value: {
                            shellPerm,
                            editPerm,
                            mcpConfig: mcpCfg,
                            sysPrompt,
                            historyLimit,
                            contextWindow,
                            mcpEnabled
                        }
                    });
                    break;
                }
                case "save-settings": {
                    const settings = data.value as {
                        shellPerm: string;
                        editPerm: string;
                        mcpConfig: string;
                        sysPrompt: string;
                        historyLimit: number;
                        contextWindow: number;
                        mcpEnabled: boolean;
                    };
                    const config = vscode.workspace.getConfiguration('isocode');
                        await config.update('shellPermissions', settings.shellPerm, vscode.ConfigurationTarget.Global);
                        await config.update('editPermissions', settings.editPerm, vscode.ConfigurationTarget.Global);
                        await config.update('mcpConfig', settings.mcpConfig, vscode.ConfigurationTarget.Global);
                        await config.update('systemPrompt', settings.sysPrompt, vscode.ConfigurationTarget.Global);
                        await config.update('historyLimit', settings.historyLimit, vscode.ConfigurationTarget.Global);
                        await config.update('contextWindow', settings.contextWindow, vscode.ConfigurationTarget.Global);
                        await config.update('mcpEnabled', settings.mcpEnabled, vscode.ConfigurationTarget.Global);

                        // Push runtime settings to local server (critical for MCP to actually work)
                        try {
                            const serverUrl = this.getServerUrl();
                            let parsedMcp: any[] = [];
                            if (settings.mcpConfig?.trim()) {
                                try {
                                    let configText = settings.mcpConfig.trim();
                                    // Auto-wrap in array if user provided a single object
                                    if (configText.startsWith('{')) configText = '[' + configText + ']';
                                    const parsed = JSON.parse(configText);
                                    if (Array.isArray(parsed)) {
                                        parsedMcp = parsed.filter((s: any) => s && s.name && s.command);
                                    }
                                    if (parsedMcp.length > 0) {
                                        this.output.appendLine(`IsoCode: MCP config parsed successfully: ${parsedMcp.length} server(s) — ${parsedMcp.map((s: any) => s.name).join(', ')}`);
                                    }
                                } catch (e: any) {
                                    this.output.appendLine(`IsoCode: MCP config parse failed: ${e.message}. Make sure it's valid JSON.`);
                                    webviewView.webview.postMessage({ type: 'addResponse', value: `⚠️ MCP config is not valid JSON: ${e.message}` });
                                }
                            }
                            const contextWindowValue = settings.contextWindow ? settings.contextWindow * 1024 : undefined;
                            await axios.post(`${serverUrl}/config`, {
                                PERMISSIONS: {
                                    run_shell: settings.shellPerm,
                                    write_file: settings.editPerm,
                                    replace_in_file: settings.editPerm
                                },
                                MCP_SERVERS: parsedMcp,
                                MAX_HISTORY_MESSAGES: settings.historyLimit,
                                CONTEXT_WINDOW_SIZE: contextWindowValue,
                                SYSTEM_PROMPT: settings.sysPrompt || undefined
                            }, { timeout: 10000 });
                            this.output.appendLine(`IsoCode: pushed settings to server (${serverUrl}/config), MCP servers=${parsedMcp.length}`);
                            if (parsedMcp.length > 0) {
                                webviewView.webview.postMessage({ type: 'addResponse', value: `MCP servers configured: ${parsedMcp.map((s: any) => s.name).join(', ')}` });
                            }
                        } catch (e: any) {
                            this.output.appendLine(`IsoCode: failed to push settings to server: ${e?.message || String(e)}`);
                            webviewView.webview.postMessage({ type: 'addResponse', value: '⚠️ Failed to push settings to server. Is it running?' });
                        }

                        vscode.window.showInformationMessage('IsoCode settings saved');
                    break;
                }
                case "get-models": {
                    await fetchAndPushModels();
                    break;
                }
                case "webview-ready": {
                    this.output.appendLine('IsoCode: webview ready');
                    await fetchAndPushModels();
                    break;
                }
                case 'preview-diff': {
                const { filePath, diff } = data;
                await this.previewDiff(filePath, diff);
                break;
                }
                case 'agent-decision': {
                const { sessionId, decision, filePath, diff } = data;
                if (decision === 'approve' && filePath) {
                    await this.applyDiffLocally(filePath, diff || '');
                } else if (decision === 'reject' && filePath) {
                    await this.rejectDiffLocally(filePath);
                }
                const modelForResume = (data as any).model || this.lastUsedModel;
                this.resumeAgentStream(sessionId, webviewView, decision || 'reject', modelForResume);
                break;
                }
                case 'chat-apply-code': {
                    // Chat mode: user wants to apply a code block to a context file
                    const targetPath = data.filePath as string;
                    const newCode = data.code as string;
                    if (!targetPath || !newCode) break;
                    try {
                        const absPath = path.isAbsolute(targetPath)
                            ? targetPath
                            : path.join(vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '', targetPath);
                        let original = '';
                        try { original = fs.readFileSync(absPath, 'utf8'); } catch { }

                        const { createTwoFilesPatch } = require('diff');
                        const patch = createTwoFilesPatch(
                            path.basename(absPath), path.basename(absPath),
                            original, newCode, '', '', { context: 3 }
                        );

                        // Show VS Code diff preview
                        await this.previewDiff(targetPath, patch);

                        // Also send as diff_request to the webview so user gets Accept/Reject
                        webviewView.webview.postMessage({
                            type: 'diff_request',
                            filePath: targetPath,
                            diff: patch,
                            sessionId: 'chat'
                        });
                    } catch (e: any) {
                        this.output.appendLine('IsoCode: chat-apply-code error: ' + e.message);
                        webviewView.webview.postMessage({
                            type: 'addResponse',
                            value: '❌ Could not generate diff: ' + e.message
                        });
                    }
                    break;
                }
                case 'compact': {
                    // Compact conversation context (like /compact command)
                    const compactSessionId = (data as any).sessionId || 'default';
                    try {
                        const serverUrl = this.getServerUrl();
                        const result = await axios.post(`${serverUrl}/compact`, {
                            sessionId: compactSessionId,
                            model: this.lastUsedModel || undefined
                        }, { timeout: 60000 });
                        const r = result.data;
                        if (r?.ok) {
                            webviewView.webview.postMessage({
                                type: 'addResponse',
                                value: `Context compacted: ${r.before} → ${r.after} messages (removed ${r.removedCount || 0} old messages)`
                            });
                        } else {
                            webviewView.webview.postMessage({
                                type: 'addResponse',
                                value: r?.message || r?.error || 'Nothing to compact'
                            });
                        }
                    } catch (e: any) {
                        webviewView.webview.postMessage({
                            type: 'addResponse',
                            value: '❌ Compact failed: ' + (e?.message || String(e))
                        });
                    }
                    break;
                }
                case 'switch-model': {
                    // User switched model mid-chat — summarize context for new model
                    const newModel = (data as any).model as string;
                    const switchSessionId = (data as any).sessionId || 'default';
                    if (!newModel) break;
                    this.lastUsedModel = newModel;
                    try {
                        const serverUrl = this.getServerUrl();
                        const result = await axios.post(`${serverUrl}/switch-model`, {
                            sessionId: switchSessionId,
                            model: newModel
                        }, { timeout: 30000 });
                        if (result.data?.ok) {
                            webviewView.webview.postMessage({
                                type: 'addResponse',
                                value: `Switched to ${newModel}. Context summarized for the new model.`
                            });
                        }
                    } catch (e: any) {
                        this.output.appendLine('IsoCode: model switch failed: ' + e.message);
                    }
                    break;
                }
                case 'get-sessions': {
                    try {
                        const serverUrl = this.getServerUrl();
                        const result = await axios.get(`${serverUrl}/sessions`, { timeout: 8000 });
                        webviewView.webview.postMessage({
                            type: 'sessions',
                            value: result.data
                        });
                    } catch (e: any) {
                        webviewView.webview.postMessage({
                            type: 'sessions',
                            value: { active: [], saved: [] }
                        });
                    }
                    break;
                }

            }
        });

        setTimeout(() => fetchAndPushModels(), 600);
    }


    /**
     * Pending diffs: original content saved so Reject can restore it.
     * The proposed content is written directly to the real file for live preview.
     */
    private pendingDiffBackups: Map<string, { absPath: string; original: string }> = new Map();

    /**
     * IsoCode live diff preview:
     * 1. Save original content as backup
     * 2. Write proposed content directly to the real file
     * 3. Open vscode.diff with backup (left) vs real file (right)
     * The user sees the diff inline on the actual file.
     */
    private async previewDiff(filePath: string, diff: string): Promise<void> {
        try {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
            const absPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(wsRoot, filePath);

            this.output.appendLine(`IsoCode: previewDiff file=${filePath} absPath=${absPath}`);

            // Read the current file content (the original)
            let original = '';
            if (fs.existsSync(absPath)) {
                try { original = fs.readFileSync(absPath, 'utf8'); } catch { }
            }

            // Compute proposed content by applying the patch
            let proposed = this.tryApplyPatch(original, diff, filePath);
            if (proposed === null) {
                this.output.appendLine('IsoCode: all applyPatch attempts failed');
                const doc = await vscode.workspace.openTextDocument({
                    content: diff, language: 'diff'
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                return;
            }

            // Save backup of original (for Reject)
            this.pendingDiffBackups.set(filePath, { absPath, original });

            // Write proposed content directly to the real file
            const dir = path.dirname(absPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absPath, proposed, 'utf8');

            // Save original to a temp file for the left side of the diff
            const tmpDir = path.join(os.tmpdir(), 'isocode-diff');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const backupFile = path.join(tmpDir, `original_${path.basename(filePath)}`);
            fs.writeFileSync(backupFile, original, 'utf8');

            // Open diff: left = original (temp), right = real file (now has proposed)
            await vscode.commands.executeCommand(
                'vscode.diff',
                vscode.Uri.file(backupFile),
                vscode.Uri.file(absPath),
                `${path.basename(filePath)} — Proposed Changes`
            );
        } catch (err: any) {
            this.output.appendLine(`IsoCode: previewDiff error: ${err?.message || String(err)}`);
            vscode.window.showErrorMessage('Diff preview failed: ' + (err?.message || String(err)));
        }
    }

    /**
     * Try multiple strategies to apply a patch (LLMs produce inconsistent diff headers).
     */
    private tryApplyPatch(original: string, diff: string, filePath: string): string | null {
        const basename = path.basename(filePath);
        const attempts = [
            diff,
            diff.replace(/^---\s+.+$/m, `--- a/${basename}`).replace(/^\+\+\+\s+.+$/m, `+++ b/${basename}`),
            diff.replace(/^(---|\+\+\+)\s+\S+/gm, (_, prefix) => `${prefix} ${basename}`),
            diff.replace(/^(---|\+\+\+)\s+[a-z]\/\S+/gm, (_, prefix) => `${prefix} ${basename}`),
        ];
        for (const attempt of attempts) {
            const result = applyPatch(original, attempt);
            if (result !== false) return result;
        }
        return null;
    }

    /**
     * Accept: file already has proposed content. Just close diff and clean up.
     */
    private async applyDiffLocally(filePath: string, _diff: string) {
        try {
            // File already has the proposed content from previewDiff.
            // Just clean up the backup and close the diff tab.
            this.pendingDiffBackups.delete(filePath);

            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
            const absPath = path.isAbsolute(filePath)
                ? filePath
                : path.join(wsRoot, filePath);

            this.output.appendLine(`IsoCode: accepted changes on ${absPath}`);

            // Close diff editor and open the file normally
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            const uri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e: any) {
            this.output.appendLine(`IsoCode: accept error: ${e?.message || String(e)}`);
        }
    }

    /**
     * Reject: restore original content from backup.
     */
    private async rejectDiffLocally(filePath: string) {
        try {
            const backup = this.pendingDiffBackups.get(filePath);
            if (backup) {
                fs.writeFileSync(backup.absPath, backup.original, 'utf8');
                this.pendingDiffBackups.delete(filePath);
                this.output.appendLine(`IsoCode: rejected changes, restored ${backup.absPath}`);

                // Close diff editor and open the restored file
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                const uri = vscode.Uri.file(backup.absPath);
                const doc = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(doc, { preview: false });
            }
        } catch (e: any) {
            this.output.appendLine(`IsoCode: reject restore error: ${e?.message || String(e)}`);
        }
    }


    private async resumeAgentStream(
    sessionId: string,
    webviewView: vscode.WebviewView,
    decision: 'approve' | 'reject',
    model?: string
    ) {
    try {
        const serverUrl = this.getServerUrl();
        this.output.appendLine(`IsoCode: resuming agent session=${sessionId} decision=${decision} model=${model || 'session-default'} agentPlus=${this.lastUsedAgentPlus}`);
        const res = await axios.request({
            url: `${serverUrl}/chat`,
        method: 'post',
        data: {
            sessionId,
            decision,
            autoMode: true,
            agentPlus: this.lastUsedAgentPlus,
            model: model || undefined
        },
        responseType: 'stream',
        headers: { accept: 'text/event-stream' },
        timeout: this.lastUsedAgentPlus ? 600000 : 300000
        });

        const stream = res.data;
        let buffer = '';

        stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';

        for (const part of parts) {
            const m = part.match(/data:\s*(.*)/s);
            if (!m) continue;

            try {
            const parsed = JSON.parse(m[1]);
            webviewView.webview.postMessage(parsed);
            } catch {
            // ignore
            }
        }
        });

        stream.on('end', () => {
            if (buffer.trim()) {
                const m = buffer.match(/data:\s*(.*)/s);
                if (m) {
                    try {
                        const parsed = JSON.parse(m[1]);
                        webviewView.webview.postMessage(parsed);
                    } catch { }
                }
            }
        });

        stream.on('error', (err: any) => {
        this.output.appendLine('Resume stream error: ' + String(err));
        webviewView.webview.postMessage({ type: 'addResponse', value: '❌ Agent resume failed: ' + String(err) });
        });
    } catch (err: any) {
        const msg = err?.response?.data ? JSON.stringify(err.response.data) : String(err);
        this.output.appendLine('Failed to resume agent: ' + msg);
        webviewView.webview.postMessage({ type: 'addResponse', value: '❌ Agent resume failed: ' + msg });
    }
    }


    private _getLoadingHtml(webview: vscode.Webview): string {
        const nonce = this.getNonce();
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <style>body{display:flex;align-items:center;justify-content:center;min-height:200px;margin:0;font-family:system-ui;color:var(--vscode-foreground,#ccc);}
            .dot{width:8px;height:8px;background:currentColor;border-radius:50%;animation:bounce 1.4s ease-in-out infinite both;}
            .dot:nth-child(1){animation-delay:-0.32s}.dot:nth-child(2){animation-delay:-0.16s}
            @keyframes bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
            .loader{display:flex;gap:6px;align-items:center;}</style></head>
            <body><div class="loader"><span>Loading IsoCode</span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></body></html>`;
    }

    private _getHtmlForWebview(webview: vscode.Webview, initialModels: Array<{ id: string; displayName: string }> = []) {
        const nonce = this.getNonce();
        const styleResetUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "reset.css")
        );
        const styleMainUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "styles.css")
        );
        const styleComponentsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "components.css")
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
        );
        const artifactsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "artifacts.js")
        );
        const diffViewerUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "diff-viewer.js")
        );
        const toolTimelineUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "tool-timeline.js")
        );
        const conversationManagerUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "conversation-manager.js")
        );
        const workflowCommandsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "workflow-commands.js")
        );
        const codeActionsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "code-actions.js")
        );
        const iconUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "icon.png")
        );

        const modelsJson = JSON.stringify(initialModels);

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy"
                content="default-src 'none';
                    style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com;
                    font-src ${webview.cspSource} https://fonts.gstatic.com;
                    img-src ${webview.cspSource} https: data:;
                    script-src ${webview.cspSource} 'nonce-${nonce}';">
                <link href="https://fonts.googleapis.com/icon?family=Material+Symbols+Outlined" rel="stylesheet">
                <link href="${styleResetUri}" rel="stylesheet">
                <link href="${styleMainUri}" rel="stylesheet">
                <link href="${styleComponentsUri}" rel="stylesheet">
                <title>IsoCode</title>
                <script nonce="${nonce}">
                    window.iconUri = "${iconUri}";
                    window.__INITIAL_MODELS__ = ${modelsJson};
                </script>
            </head>
            <body>
                <div class="chat-container">
                    <div class="header-controls">
                         <div class="logo-area">
                            <img src="${iconUri}" alt="IsoCode" class="app-logo">
                            <span>IsoCode</span>
                         </div>
                         <div class="session-controls">
                             <button id="new-chat-btn" class="md-icon-button" title="New Chat">
                                <span class="material-symbols-outlined">add_comment</span>
                             </button>
                             <button id="history-btn" class="md-icon-button" title="History">
                                <span class="material-symbols-outlined">history</span>
                             </button>
                             <button id="close-window-btn" class="md-icon-button" title="Close">
                                <span class="material-symbols-outlined">close</span>
                             </button>
                         </div>
                    </div>

                    <div id="chat-history"></div>
                    <div id="loading-indicator" class="loading-hidden">
                        <div class="thinking-bubble">
                            <div class="typing-indicator">
                                <span></span><span></span><span></span>
                            </div>
                            <span class="thinking-label" id="thinking-label">Thinking...</span>
                        </div>
                    </div>
                    
                    <div class="input-area">
                        <div id="context-chips"></div>
                        <div id="autocomplete-overlay" class="hidden"></div>

                        <div class="controls">
                            <div class="left-controls">
                                <div class="mode-switch" id="agent-mode-switch" role="tablist" aria-label="Assistant mode">
                                    <button class="mode-pill active" data-mode="chat" type="button" title="Direct Q&A with streaming. No tools, no file edits. Fast answers.">Chat</button>
                                    <button class="mode-pill" data-mode="agent" type="button" title="Multi-step agent with tools. Reads files, proposes diffs for review. You approve each change.">Agent</button>
                                    <button class="mode-pill" data-mode="agent_plus" type="button" title="Full autonomy. More steps, proactive exploration, aggressive tool use. For complex tasks.">Agent+</button>
                                </div>
                                <select id="model-select" class="mini-select">
                                    <option value="local">Local Model</option>
                                </select>
                            </div>
                            <div class="right-controls">
                                <button id="add-context-btn" class="md-icon-button" title="Add files, folder, or workspace to context">
                                    <span class="material-symbols-outlined">add_circle_outline</span>
                                </button>
                                <button id="settings-btn" class="md-icon-button" title="Settings">
                                    <span class="material-symbols-outlined">settings</span>
                                </button>
                            </div>
                        </div>

                         <div id="settings-panel" class="md-card-elevated">
                            <div class="settings-header">
                                <h3>Configuration</h3>
                                <button id="close-settings-btn" class="md-icon-button">
                                    <span class="material-symbols-outlined">close</span>
                                </button>
                            </div>
                            <div class="setting-group">
                                <h4>Permissions</h4>
                                <div class="setting-item">
                                    <label>Shell Permissions</label>
                                    <select id="perm-shell">
                                        <option value="ask">Ask Me</option>
                                        <option value="always">Always Allow</option>
                                        <option value="never">Block</option>
                                    </select>
                                </div>
                                <div class="setting-item">
                                    <label>File Edit Permissions</label>
                                    <select id="perm-edit">
                                        <option value="ask">Ask Me</option>
                                        <option value="always">Always Allow</option>
                                    </select>
                                </div>
                            </div>
                            <div class="setting-group">
                                <h4>Memory & History</h4>
                                <div class="setting-item">
                                    <label>Chat History Limit</label>
                                    <input type="number" id="history-limit" min="10" max="500" value="50">
                                </div>
                                <div class="setting-item">
                                    <label>Context Window (messages)</label>
                                    <input type="number" id="context-window" min="1" max="50" value="10">
                                </div>
                            </div>
                            <div class="setting-group">
                                <h4>MCP (Model Context Protocol)</h4>
                                <p style="font-size: 11px; opacity: 0.7; margin: 4px 0 8px 0;">External tool servers the agent can use. Paste valid JSON array below.</p>
                                <div class="setting-item checkbox-item">
                                    <label class="checkbox-label">
                                        <input type="checkbox" id="mcp-enabled">
                                        <span>Enable MCP Servers</span>
                                    </label>
                                </div>
                                <div class="setting-item">
                                    <label>MCP Server Configuration (JSON)</label>
                                    <textarea id="mcp-config" rows="6" style="font-family: monospace; font-size: 12px;" placeholder='[
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/projects"]
  }
]'></textarea>
                                    <p style="font-size: 10px; opacity: 0.5; margin-top: 4px;">Each server needs: name, command, args (array). Save to apply.</p>
                                </div>
                            </div>
                            <div class="setting-group">
                                <h4>Agent Configuration</h4>
                                <div class="setting-item">
                                    <label>System Prompt</label>
                                    <textarea id="sys-prompt" rows="3" placeholder="Custom instructions for the AI agent..."></textarea>
                                </div>
                            </div>
                            <button id="save-settings-btn" class="md-button-filled" style="width: 100%; margin-top: 16px;">Save Settings</button>
                        </div>
                        
                        <div class="input-wrapper">
                            <textarea id="prompt-input" placeholder="Ask IsoCode or type @ for context..."></textarea>
                            <button id="send-btn" class="md-icon-button">
                                <span class="material-symbols-outlined">send</span>
                            </button>
                        </div>
                    </div>
                </div>
                <script nonce="${nonce}" src="${artifactsUri}"></script>
                <script nonce="${nonce}" src="${diffViewerUri}"></script>
                <script nonce="${nonce}" src="${toolTimelineUri}"></script>
                <script nonce="${nonce}" src="${conversationManagerUri}"></script>
                <script nonce="${nonce}" src="${workflowCommandsUri}"></script>
                <script nonce="${nonce}" src="${codeActionsUri}"></script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
