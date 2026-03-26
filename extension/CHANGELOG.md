# Changelog

All notable changes to the IsoCode VS Code extension are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.1] — Current

### Added

- **Adaptive speed vs quality**: Agent detects simple vs long/complex queries. Simple queries use a fast path (lower max_tokens, capped project map, smaller auto-context) for quicker responses; long messages, complex keywords (refactor, review, implement, etc.), multi-step phrasing, or any follow-up turn use the full path (4096 max_tokens, full context) so complex task performance is unchanged.
- **Config**: `MAX_AGENT_RESPONSE_TOKENS` (default 1536) for simple-query reply cap; documented in `.env.example`.
- **ACP adapter command**: Root script `npm run acp-adapter` to run `server/acp-adapter.js` for ACP-compatible IDEs.
- **Secure API key storage**: Paid API key can be saved in VS Code SecretStorage from extension settings (not stored in `.env` or workspace files).
- **`/grasp` command**: Builds a context handoff prompt from recent conversation + context files so a local model can continue after switching.

### Changed

- **Startup**: Project index and project rules load in parallel (`Promise.all`) for faster session init.
- **Simple-query path**: Lower temperature (0.15 Agent / 0.4 Agent+), project map capped at 2000 chars, auto-context 2500 chars, checkpoint 1000 chars when the query is classified as simple.
- **Extension UI refresh**: Buttons and controls updated with modern, higher-contrast styling (mode pills, send/stop, icon buttons, diff actions), improved hover/active/focus states, and cleaner spacing for better usability.
- **README hero**: Switched to a cleaner light banner (`assets/isocode-banner-light.svg`) with centered logo/title.
- **Quota fallback UX**: On quota/rate-limit style failures, extension attempts a context snapshot and guides users to switch local model + run `/grasp`.

### Fixed

- **ACP concurrency stability**: `session/prompt` now responds deterministically per request (including concurrent sessions) and emits proper JSON-RPC results/errors.
- **Cancel behavior under concurrency**: `stop-agent` now aborts in-flight LLM calls for the target session; reduced hangs where one cancelled session could delay/impact another.
- **Agent run bounding for simple tasks**: Fast-path runs now use an internal effective step cap to reduce long loops and improve time-to-final on simple prompts.
- **Security hardening (critical pass)**:
  - Added optional bearer-token auth (`ISOCODE_AUTH_TOKEN`) for sensitive server endpoints.
  - Replaced permissive CORS wildcard with a localhost/configurable allowlist.
  - Hardened workspace path boundary checks (`path.relative` containment) in tool and agent file operations.
  - Constrained codebase root inputs to server workspace-safe paths.
  - ACP adapter now supports forwarding `ISOCODE_AUTH_TOKEN` to protected server endpoints.
  - Dependency audit remediation completed (root + extension): `npm audit` reports 0 vulnerabilities.

### Local test commands

Run from repo root:

```bash
# 1) Install root deps
npm install

# 2) Start server (Terminal A)
npm start

# 3) Health check
node -e "const axios=require('axios');axios.get('http://localhost:3000/health').then(r=>console.log(r.data)).catch(e=>console.error(e.message))"

# 4) Run ACP adapter (Terminal B, optional for multi-IDE/ACP tests)
npm run acp-adapter

# 5) Run automated suite
npm test

# 6) Security audit (prod deps)
npm audit --omit=dev --json
```

Run extension from source (separate step):

```bash
cd extension
npm install
npm run compile
npm audit --json
# then open extension/ in VS Code and press F5
```

---

## [0.0.9]

### Added

- **Adaptive speed vs quality**: Agent detects simple vs long/complex queries. Simple queries use a fast path (lower max_tokens, capped project map, smaller auto-context) for quicker responses; long messages, complex keywords (refactor, review, implement, etc.), multi-step phrasing, or any follow-up turn use the full path (4096 max_tokens, full context) so complex task performance is unchanged.
- **Config**: `MAX_AGENT_RESPONSE_TOKENS` (default 1536) for simple-query reply cap; documented in `.env.example`.
- **ACP adapter command**: Root script `npm run acp-adapter` to run `server/acp-adapter.js` for ACP-compatible IDEs.

### Changed

- **Startup**: Project index and project rules load in parallel (`Promise.all`) for faster session init.
- **Simple-query path**: Lower temperature (0.15 Agent / 0.4 Agent+), project map capped at 2000 chars, auto-context 2500 chars, checkpoint 1000 chars when the query is classified as simple.

---

## [0.0.8]

### Added

- **Explain Selection**: Command "IsoCode: Explain Selection" — select code in the editor, run the command, and the selection is pasted into the prompt with "Explain the following code:" (Command Palette: Ctrl+Shift+P / Cmd+Shift+P).
- **Documentation**: Full docs at `docs/index.html` (Getting Started, Modes, Tools, Configuration, Security).
- **Open created file**: When the agent creates or edits a file (`write_file` or `replace_in_file`), that file opens in the editor automatically (server sends `open_file`; extension handles it).

### Server (v0.0.8)

- **Agent+ Swarm**: In Agent+ mode the model can delegate subtasks via `{"type":"delegate","tasks":["...","..."]}`. Up to 2 workers run in parallel (configurable with `SWARM_MAX_WORKERS`) to avoid GPU bottleneck; results are merged and fed back to the main agent.
- **Swarm model selection**: Vision/screenshot/browser tasks use a capable model (e.g. llava, glm4.7-flash) even when the session model is a coder; per-task ordered list of models to try; on worker failure, retry with the next model so the task completes regardless of which model is used.
- **Security**: Path traversal protection for all file paths in diff_request and file edits; paths are validated to stay inside the workspace.

### Changed

- **Agent behavior**: System prompt updated so the agent sticks to the user's exact request: it does not add tasks the user did not ask for (e.g. no "start server", "create .env", "take screenshot" unless explicitly requested) and does not divert from the given query.

### Fixed

- **Chat panel opacity**: Chat history section and Chat History sidebar (conversation list) are now fully opaque so content behind the panel (buttons, UI) is not visible; opaque background applied to `html`, `body`, `.chat-container`, `#chat-history`, and `.conversation-sidebar` (including header and list area).

---

## [0.0.7]

### Added

- **Modes**: Chat (streaming Q&A), Agent (ReAct + diff approval), Agent+ (autonomous, auto-apply edits).
- **Context**: Add files via button or @-mention; context chips collapse when 2+ files; "Clear all" to remove context; sidebar reopen starts new chat with only currently open editor files.
- **Slash commands**: `/help` (list commands), `/new` (new conversation), `/clear` (clear chat), `/compact` (compress context), `/settings` (open settings), `/get-sessions` (list sessions).
- **Diff workflow**: Approve or reject file edits proposed by the agent; Agent+ auto-applies.
- **Steps UI**: Collapsible step list for agent runs; duplicate thought/plan steps deduplicated in the UI.
- **Model selector**: Dropdown populated from the connected IsoCode server (Ollama / LM Studio / OpenAI).
- **Settings**: Server URL, LLM provider, API base, default model, shell/edit permissions, MCP enable/config, system prompt override, history limit, context window.
- **Conversation history**: Browse and switch between past conversations (when available).
- **Apply to file**: Buttons to apply code blocks to the current context file.

### Changed

- New chat and context reset when the sidebar is closed and reopened; only files open in the editor are re-attached as context.
- Context chips always shown in a compact row when 2+ files (no long inline list).

### Fixed

- Step counter and duplicate "PLAN" steps in Agent+ (deduplication and prompt tweak).
- Context and chat state when reopening the sidebar.

---

## [0.0.6] and earlier

- Initial sidebar chat, file context, and agent mode.
- Basic settings panel and server connection.
- Diff preview and approve/reject for Agent mode.

---

## Installation

- **From source**: Clone repo → `npm install` and `npm run compile` in `extension/` → open folder in VS Code → F5.
- **From VSIX**: Extensions view → ⋯ → Install from VSIX → select `isocode-local-*.vsix`.
- **Server**: Run the IsoCode server from the repo root (`npm start`); set `isocode.serverUrl` in VS Code settings if not `http://localhost:3000`).

---

## Links

- [Repository](https://github.com/rushi32/IsoCode)
- [Root README](../README.md) for full project docs.

[0.0.8]: https://github.com/rushi32/IsoCode/releases/tag/v0.0.8
[0.0.7]: https://github.com/rushi32/IsoCode/releases/tag/v0.0.7
[1.0.0]: https://github.com/rushi32/IsoCode/releases/tag/v1.0.0
[1.0.1]: https://github.com/rushi32/IsoCode/releases/tag/v1.0.1
[0.0.9]: https://github.com/rushi32/IsoCode/releases/tag/v0.0.9
