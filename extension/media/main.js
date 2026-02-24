// Main webview script for IsoCode sidebar
// Provides an IsoCode-style agent pane with:
// - Agent mode toggle (Chat / Agent / Agent+)
// - Dynamic model list from Ollama, LM Studio, or OpenAI
// - @-based context picker and chips
// - Settings panel integration
// - Health check and provider status
let pendingDiffs = [];

console.log('IsoCode webview JS loaded');

/** Normalize addResponse value: if it's JSON with type+content, return content only. */
function normalizeResponseValue(value) {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : String(value);
  let t = s.trim();

  // Recover wrapped assistant payloads like:
  // <|channel|>final <|constrain|>json<|message|>{"type":"final","content":"..."}
  // and malformed fragments like:
  // <|channel|>final <|constrain|>type":"observation","content":"..."}
  const msgMatch = t.match(/<\|message\|>\s*([\s\S]+)$/);
  if (msgMatch) t = msgMatch[1].trim();
  // strip token wrappers first
  t = t.replace(/<\|[^|>]+?\|>/g, ' ').trim();
  if (!t.startsWith('{')) {
    const typeIdx = t.indexOf('"type"');
    if (typeIdx >= 0) {
      t = t.slice(typeIdx);
      t = `{${t}`;
      if (!t.endsWith('}')) t += '}';
    }
  }

  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const o = JSON.parse(t);
      if (o && (o.type === 'thought' || o.type === 'action' || o.type === 'observation')) {
        return '';
      }
      if (o && o.content != null) return String(o.content).trim();
    } catch (_) {}
  }
  return t;
}

/** Escape for HTML to prevent XSS. */
function escapeHtml(text) {
  if (text == null) return '';
  const s = String(text);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render markdown-like text to safe HTML (IsoCode-style: code blocks, bold, inline code). */
function renderMarkdownToHtml(text) {
  if (text == null || text === '') return '';
  const parts = String(text).split('```');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      let seg = escapeHtml(parts[i]);
      seg = seg.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      seg = seg.replace(/\*(.+?)\*/g, '<em>$1</em>');
      seg = seg.replace(/`([^`]+)`/g, '<code class="agent-inline-code">$1</code>');
      seg = seg.replace(/\n/g, '<br>');
      out += seg;
    } else {
      const block = parts[i];
      const firstNewline = block.indexOf('\n');
      const lang = firstNewline >= 0 ? block.slice(0, firstNewline).trim() : '';
      const code = firstNewline >= 0 ? block.slice(firstNewline + 1) : block;
      if (!String(code || '').trim()) continue;
      out += '<pre class="agent-code-block"><code class="agent-code language-' + escapeHtml(lang) + '">' + escapeHtml(code) + '</code></pre>';
    }
  }
  return out;
}

function renderUnifiedDiff(diff) {
  const pre = document.createElement('pre');
  pre.className = 'diff-preview';

  diff.split('\n').forEach(line => {
    const div = document.createElement('div');
    div.textContent = line;

    if (line.startsWith('+')) div.className = 'diff-add';
    else if (line.startsWith('-')) div.className = 'diff-remove';
    else if (line.startsWith('@@')) div.className = 'diff-hunk';
    else if (line.startsWith('diff') || line.startsWith('index')) div.className = 'diff-meta';

    pre.appendChild(div);
  });

  return pre;
}


(() => {
  const vscode = acquireVsCodeApi();

  /** @type {HTMLTextAreaElement | null} */
  const promptInput = document.getElementById('prompt-input');
  /** @type {HTMLButtonElement | null} */
  const sendBtn = document.getElementById('send-btn');
  /** @type {HTMLButtonElement | null} */
  const stopBtn = document.getElementById('stop-btn');
  /** @type {HTMLDivElement | null} */
  const chatHistory = document.getElementById('chat-history');
  /** @type {HTMLDivElement | null} */
  const loadingIndicator = document.getElementById('loading-indicator');
  /** @type {HTMLDivElement | null} */
  const modeSwitch = document.getElementById('agent-mode-switch');
  /** @type {NodeListOf<HTMLButtonElement>} */
  const modePills = modeSwitch ? modeSwitch.querySelectorAll('.mode-pill') : [];
  /** @type {HTMLSelectElement | null} */
  const modelSelect = document.getElementById('model-select');
  /** @type {HTMLDivElement | null} */
  const autocompleteOverlay = document.getElementById('autocomplete-overlay');
  /** @type {HTMLDivElement | null} */
  const contextChipsEl = document.getElementById('context-chips');
  /** @type {HTMLDivElement | null} */
  const settingsBackdrop = document.createElement('div');
  settingsBackdrop.id = 'settings-backdrop';
  settingsBackdrop.className = 'settings-backdrop hidden';
  document.body.appendChild(settingsBackdrop);

  /** @type {HTMLButtonElement | null} */
  const addContextBtn = document.getElementById('add-context-btn');
  /** @type {HTMLButtonElement | null} */
  const settingsBtn = document.getElementById('settings-btn');
  /** @type {HTMLButtonElement | null} */
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  /** @type {HTMLButtonElement | null} */
  const closeWindowBtn = document.getElementById('close-window-btn');
  /** @type {HTMLButtonElement | null} */
  const newChatBtn = document.getElementById('new-chat-btn');
  /** @type {HTMLButtonElement | null} */
  const historyBtn = document.getElementById('history-btn');

  // Populate model dropdown from LM Studio list injected by extension (no postMessage race)
  const initialModels = typeof window.__INITIAL_MODELS__ !== 'undefined' && Array.isArray(window.__INITIAL_MODELS__) ? window.__INITIAL_MODELS__ : [];
  if (modelSelect) {
    modelSelect.innerHTML = '';
    if (initialModels.length > 0) {
      initialModels.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m.id || m.name || m.model || String(m);
        opt.textContent = m.displayName || m.id || m.name || m.model || String(m);
        modelSelect.appendChild(opt);
      });
      modelSelect.value = initialModels[0].id || initialModels[0].name || String(initialModels[0]);
    } else {
      const def = document.createElement('option');
      def.value = 'local';
      def.textContent = 'Local Model';
      modelSelect.appendChild(def);
    }
  }

  // Settings controls
  /** @type {HTMLSelectElement | null} */
  const permShell = document.getElementById('perm-shell');
  /** @type {HTMLSelectElement | null} */
  const permEdit = document.getElementById('perm-edit');
  /** @type {HTMLTextAreaElement | null} */
  const mcpConfig = document.getElementById('mcp-config');
  /** @type {HTMLTextAreaElement | null} */
  const sysPrompt = document.getElementById('sys-prompt');
  /** @type {HTMLInputElement | null} */
  const historyLimit = document.getElementById('history-limit');
  /** @type {HTMLInputElement | null} */
  const contextWindow = document.getElementById('context-window');
  /** @type {HTMLInputElement | null} */
  const mcpEnabled = document.getElementById('mcp-enabled');
  /** @type {HTMLButtonElement | null} */
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  /** @type {HTMLDivElement | null} */
  const settingsPanel = document.getElementById('settings-panel');

  const state = vscode.getState() || {};

  /** @type {{name:string; content:string; path:string}[]} */
  let contextBlobs = state.contextBlobs || [];

  // Last sent prompt state (must be declared before any function uses it)
  let lastUserMessage = '';
  let lastFullPrompt = '';
  let currentMode = 'chat'; // 'chat' | 'agent' | 'agent_plus'
  let lastAskOptions = { autoMode: false, agentPlus: false, model: undefined };

  let lastAtQuery = '';
  let atSearchTimeout = null;
  let pendingPermissionEl = null;
  let autocompleteIndex = -1;
  let autocompleteItems = [];

  // Optional helpers from other files
  const ArtifactManager = window.ArtifactManager;
  const ConversationManager = window.ConversationManager;
  const WorkflowCommands = window.WorkflowCommands;
  const CodeActions = window.CodeActions;

  function safeCreate(name, factory) {
    try {
      return factory();
    } catch (e) {
      console.error('[IsoCode] Failed to init ' + name + ':', e);
      return null;
    }
  }

  const artifactManager = ArtifactManager
    ? safeCreate('ArtifactManager', () => new ArtifactManager())
    : null;
  const conversationManager = ConversationManager
    ? safeCreate('ConversationManager', () => new ConversationManager(vscode))
    : null;
  const workflowCommands = WorkflowCommands
    ? safeCreate('WorkflowCommands', () => new WorkflowCommands())
    : null;
  const codeActions = CodeActions
    ? safeCreate('CodeActions', () => new CodeActions(vscode))
    : null;

  const thinkingLabel = document.getElementById('thinking-label');

  function setLoading(isLoading, label) {
    if (!loadingIndicator) return;
    loadingIndicator.classList.toggle('loading-hidden', !isLoading);
    if (thinkingLabel && label) {
      thinkingLabel.textContent = label;
    } else if (thinkingLabel && isLoading) {
      thinkingLabel.textContent = 'Thinking...';
    }
    if (stopBtn) stopBtn.classList.toggle('stop-btn-hidden', !isLoading);
    if (sendBtn) sendBtn.classList.toggle('send-btn-hidden', isLoading);
    // Auto-scroll so the indicator is visible
    if (isLoading) scrollChatToBottom();
  }

  function persistState() {
    vscode.setState({
      contextBlobs,
      selectedModel: modelSelect ? modelSelect.value : undefined,
      assistantMode: currentMode,
    });
  }

  function setAssistantMode(mode) {
    if (!mode || !['chat', 'agent', 'agent_plus'].includes(mode)) return;
    currentMode = mode;
    if (modePills && modePills.length) {
      modePills.forEach((btn) => {
        const isActive = btn.dataset.mode === currentMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }
    persistState();
  }

  function getModeFlags() {
    const autoMode = currentMode === 'agent' || currentMode === 'agent_plus';
    const agentPlus = currentMode === 'agent_plus';
    return { autoMode, agentPlus };
  }

  const CONTEXT_CHIPS_COLLAPSE_THRESHOLD = 2; // Always consolidate when 2+ files

  function clearAllContext() {
    contextBlobs = [];
    renderContextChips();
    persistState();
  }

  function makeClearAllButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-clear-all';
    btn.textContent = 'Clear all';
    btn.title = 'Remove all files from context';
    btn.onclick = (e) => { e.stopPropagation(); clearAllContext(); };
    return btn;
  }

  function renderContextChips() {
    if (!contextChipsEl) return;
    contextChipsEl.innerHTML = '';
    const n = contextBlobs.length;
    if (n === 0) return;

    function makeChip(blob, index) {
      const chip = document.createElement('div');
      chip.className = 'md-chip';
      const label = document.createElement('span');
      label.textContent = blob.name || blob.path;
      const remove = document.createElement('span');
      remove.className = 'md-chip-remove';
      remove.textContent = '×';
      remove.title = 'Remove from context';
      remove.onclick = () => {
        contextBlobs.splice(index, 1);
        renderContextChips();
        persistState();
      };
      chip.appendChild(label);
      chip.appendChild(remove);
      return chip;
    }

    if (n < CONTEXT_CHIPS_COLLAPSE_THRESHOLD) {
      // 1 file: single chip + Clear all
      const wrap = document.createElement('div');
      wrap.className = 'context-chips-inline';
      contextBlobs.forEach((blob, index) => wrap.appendChild(makeChip(blob, index)));
      wrap.appendChild(makeClearAllButton());
      contextChipsEl.appendChild(wrap);
      return;
    }

    // 2+ files: collapsible group (always consolidated) + Clear all in toggle row
    const group = document.createElement('div');
    group.className = 'agent-steps-group context-chips-group';

    const toggle = document.createElement('div');
    toggle.className = 'agent-steps-toggle context-chips-toggle';
    const left = document.createElement('span');
    left.className = 'context-chips-toggle-left';
    const arrow = document.createElement('span');
    arrow.className = 'toggle-arrow';
    arrow.textContent = '▶';
    const label = document.createElement('span');
    label.textContent = `${n} files in context — click to expand`;
    left.appendChild(arrow);
    left.appendChild(label);
    left.onclick = () => {
      const isExpanded = body.classList.contains('expanded');
      body.classList.toggle('expanded', !isExpanded);
      arrow.classList.toggle('expanded', !isExpanded);
      arrow.textContent = isExpanded ? '▶' : '▼';
      label.textContent = isExpanded ? `${n} files in context — click to expand` : `${n} files in context — click to collapse`;
    };
    toggle.appendChild(left);
    toggle.appendChild(makeClearAllButton());

    const body = document.createElement('div');
    body.className = 'agent-steps-body context-chips-body';
    const chipsWrap = document.createElement('div');
    chipsWrap.className = 'context-chips-wrap';
    contextBlobs.forEach((blob, index) => chipsWrap.appendChild(makeChip(blob, index)));
    body.appendChild(chipsWrap);

    group.appendChild(toggle);
    group.appendChild(body);
    contextChipsEl.appendChild(group);
  }

  function scrollChatToBottom() {
    if (!chatHistory) return;
    chatHistory.scrollTop = chatHistory.scrollHeight;
  }

  function createMessageRow(sender, content) {
    if (!chatHistory) return;

    const row = document.createElement('div');
    row.className = `message-row ${sender === 'user' ? 'user' : 'agent'}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    const img = document.createElement('img');
    if (sender === 'user') {
      img.alt = 'You';
      img.src = window.iconUri || '';
    } else {
      img.alt = 'IsoCode';
      img.src = window.iconUri || '';
    }
    avatar.appendChild(img);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble md-card agent-message-content';
    if (sender === 'user') {
      bubble.innerText = content;
    } else {
      const normalized = normalizeResponseValue(content);
      bubble.innerHTML = renderMarkdownToHtml(normalized);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    chatHistory.appendChild(row);
    if (sender === 'assistant') {
      lastAssistantRow = row;
      lastAssistantBubble = bubble;
    }
    scrollChatToBottom();

    return { row, bubble };
  }

  function switchVersion(bubble, version) {
    const panels = bubble.querySelectorAll('.version-panel');
    const tabs = bubble.querySelectorAll('.version-tab');
    panels.forEach((p) => p.classList.toggle('version-active', p.dataset.version === version));
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.v === version));
  }

  function addVersionToLastAssistant(newContentHtml) {
    if (!lastAssistantRow || !lastAssistantBubble) return;
    const bubble = lastAssistantBubble;
    if (bubble.querySelector('.version-tabs')) {
      const panel2 = bubble.querySelector('.version-panel[data-version="2"]');
      if (panel2) {
        panel2.innerHTML = newContentHtml;
        switchVersion(bubble, '2');
      }
      return;
    }
    const currentContent = bubble.innerHTML;
    bubble.innerHTML = '';
    const tabs = document.createElement('div');
    tabs.className = 'version-tabs';
    const btn1 = document.createElement('button');
    btn1.className = 'version-tab active';
    btn1.dataset.v = '1';
    btn1.textContent = 'v1';
    const btn2 = document.createElement('button');
    btn2.className = 'version-tab';
    btn2.dataset.v = '2';
    btn2.textContent = 'v2';
    btn1.onclick = () => switchVersion(bubble, '1');
    btn2.onclick = () => switchVersion(bubble, '2');
    tabs.appendChild(btn1);
    tabs.appendChild(btn2);
    const panel1 = document.createElement('div');
    panel1.className = 'version-panel version-active';
    panel1.dataset.version = '1';
    panel1.innerHTML = currentContent;
    const panel2 = document.createElement('div');
    panel2.className = 'version-panel';
    panel2.dataset.version = '2';
    panel2.innerHTML = newContentHtml;
    bubble.appendChild(tabs);
    bubble.appendChild(panel1);
    bubble.appendChild(panel2);
    switchVersion(bubble, '2');
  }

  function prepareLastAssistantForStreamingV2() {
    if (!lastAssistantRow || !lastAssistantBubble) return null;
    const bubble = lastAssistantBubble;
    if (bubble.querySelector('.version-tabs')) {
      const panel2 = bubble.querySelector('.version-panel[data-version="2"]');
      if (panel2) {
        panel2.innerHTML = '';
        switchVersion(bubble, '2');
        return panel2;
      }
      return null;
    }
    const currentContent = bubble.innerHTML;
    bubble.innerHTML = '';
    const tabs = document.createElement('div');
    tabs.className = 'version-tabs';
    const btn1 = document.createElement('button');
    btn1.className = 'version-tab active';
    btn1.dataset.v = '1';
    btn1.textContent = 'v1';
    const btn2 = document.createElement('button');
    btn2.className = 'version-tab';
    btn2.dataset.v = '2';
    btn2.textContent = 'v2';
    btn1.onclick = () => switchVersion(bubble, '1');
    btn2.onclick = () => switchVersion(bubble, '2');
    tabs.appendChild(btn1);
    tabs.appendChild(btn2);
    const panel1 = document.createElement('div');
    panel1.className = 'version-panel version-active';
    panel1.dataset.version = '1';
    panel1.innerHTML = currentContent;
    const panel2 = document.createElement('div');
    panel2.className = 'version-panel';
    panel2.dataset.version = '2';
    bubble.appendChild(tabs);
    bubble.appendChild(panel1);
    bubble.appendChild(panel2);
    switchVersion(bubble, '2');
    return panel2;
  }

  // Track current collapsible steps group
  let currentStepsGroup = null;
  let currentStepsBody = null;
  let currentStepsCount = 0;
  let currentStepsLabel = null;
  let lastThoughtKey = ''; // avoid repeating the same thought/plan step in UI

  // Retry versioning (ChatGPT-style: show 2nd version on same message)
  let isRetryResponse = false;
  let lastAssistantRow = null;
  let lastAssistantBubble = null;

  function getOrCreateStepsGroup() {
    if (currentStepsGroup && chatHistory && chatHistory.contains(currentStepsGroup)) {
      return currentStepsBody;
    }
    // Create a new collapsible group
    const group = document.createElement('div');
    group.className = 'agent-steps-group';

    const toggle = document.createElement('div');
    toggle.className = 'agent-steps-toggle';
    const arrow = document.createElement('span');
    arrow.className = 'toggle-arrow';
    arrow.textContent = '▶';
    const label = document.createElement('span');
    label.textContent = 'Working...';
    toggle.appendChild(arrow);
    toggle.appendChild(label);

    const body = document.createElement('div');
    body.className = 'agent-steps-body'; // starts collapsed (no 'expanded' class)

    toggle.onclick = () => {
      const isExpanded = body.classList.contains('expanded');
      body.classList.toggle('expanded', !isExpanded);
      arrow.classList.toggle('expanded', !isExpanded);
      arrow.textContent = isExpanded ? '▶' : '▼';
    };

    group.appendChild(toggle);
    group.appendChild(body);
    if (chatHistory) chatHistory.appendChild(group);

    currentStepsGroup = group;
    currentStepsBody = body;
    currentStepsCount = 0;
    currentStepsLabel = label;
    return body;
  }

  function updateStepsLabel() {
    if (currentStepsLabel) {
      currentStepsLabel.textContent = `${currentStepsCount} step${currentStepsCount !== 1 ? 's' : ''} completed`;
    }
  }

  function closeStepsGroup() {
    if (currentStepsLabel && currentStepsCount > 0) {
      currentStepsLabel.textContent = `${currentStepsCount} step${currentStepsCount !== 1 ? 's' : ''} — click to expand`;
    }
    currentStepsGroup = null;
    currentStepsBody = null;
    currentStepsCount = 0;
    currentStepsLabel = null;
    lastThoughtKey = '';
  }

  /**
   * Detect code blocks in a chat response that might be file content,
   * and add "Apply to <filename>" buttons.
   */
  function addCodeApplyButtons(bubble, text) {
    if (!text || !contextBlobs || contextBlobs.length === 0) return;
    const codeBlocks = bubble.querySelectorAll('pre.agent-code-block');
    if (codeBlocks.length === 0) return;

    // If we have a context file, offer to apply each code block to it
    const ctxFile = contextBlobs[0];
    if (!ctxFile || !ctxFile.path) return;
    const fileName = ctxFile.name || ctxFile.path.split(/[\\/]/).pop() || 'file';

    codeBlocks.forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code) return;
      const codeText = code.textContent || '';
      if (codeText.trim().length < 10) return;

      const btn = document.createElement('button');
      btn.className = 'code-apply-btn';
      btn.textContent = `Apply to ${fileName}`;
      btn.onclick = () => {
        vscode.postMessage({
          type: 'chat-apply-code',
          filePath: ctxFile.path,
          code: codeText
        });
        btn.textContent = 'Applied ✓';
        btn.disabled = true;
        btn.style.opacity = '0.5';
      };
      pre.parentElement.insertBefore(btn, pre.nextSibling);
    });
  }

  function renderAgentMessage(content) {
    if (typeof content === 'object' && content.type === 'diff_request') {
      renderDiffApproval(content);
      return;
    }
    const displayText = typeof content === 'string' ? normalizeResponseValue(content) : (content && content.content != null ? String(content.content) : '');
    if (!displayText || !displayText.trim()) return;

    // Close any open steps group when we get a real message
    closeStepsGroup();

    if (isRetryResponse && lastAssistantRow && lastAssistantBubble) {
      addVersionToLastAssistant(renderMarkdownToHtml(displayText));
      isRetryResponse = false;
      const bubble = lastAssistantBubble;
      const panel2 = bubble.querySelector('.version-panel[data-version="2"]');
      if (panel2 && currentMode === 'chat') addCodeApplyButtons(panel2, displayText);
      return;
    }

    const { row, bubble } = createMessageRow('assistant', displayText) || {};
    if (!row || !bubble) return;

    // Add "Apply to file" buttons on code blocks in chat mode
    if (currentMode === 'chat') {
      addCodeApplyButtons(bubble, displayText);
    }

    // Handle artifacts detection
    if (artifactManager) {
      const detected = artifactManager.detectArtifacts(displayText);
      if (detected.length > 0) {
        detected.forEach((a) => {
          const artifact = artifactManager.createArtifact(a.type, a.content, { filename: a.filename });
          const preview = artifactManager.renderArtifactPreview(artifact);
          row.appendChild(preview);
        });
      }
    }
  }


  function getSessionId() {
    if (conversationManager) {
      const conv = conversationManager.getCurrentConversation?.();
      if (conv && conv.id) return conv.id;
    }
    // Generate a unique fallback ID so we never reuse a stale session
    if (!window._isoSessionId) {
      window._isoSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }
    return window._isoSessionId;
  }

  function sendPrompt() {
    if (!promptInput) return;
    const raw = promptInput.value.trim();
    if (!raw) return;

    // Built-in slash commands (handled before workflow commands)
    if (raw.startsWith('/')) {
      const cmd = raw.split(/\s+/)[0].toLowerCase();

      if (cmd === '/compact') {
        vscode.postMessage({ type: 'compact', sessionId: getSessionId() });
        promptInput.value = '';
        renderAgentMessage('Compacting conversation context...');
        return;
      }
      if (cmd === '/sessions' || cmd === '/history') {
        vscode.postMessage({ type: 'get-sessions' });
        promptInput.value = '';
        return;
      }
      if (cmd === '/help') {
        renderAgentMessage(
          '**IsoCode Commands:**\n\n' +
          '**Conversation:**\n' +
          '- `/new` — Start fresh conversation\n' +
          '- `/compact` — Compress context (frees token space)\n' +
          '- `/sessions` — List conversation history\n' +
          '- `/clear` — Clear chat display\n\n' +
          '**Modes:**\n' +
          '- **Chat** — Direct Q&A with streaming. No tools, no file edits. Fast answers.\n' +
          '- **Agent** — ReAct agent with planning. Plans tasks first, implements one-by-one. Proposes diffs for your approval. Continues after each approval.\n' +
          '- **Agent+** — Full autonomy. 60 steps, auto-approves ALL changes, no permission prompts. Plans and completes end-to-end without stopping.\n\n' +
          '**Agent Tools (38+):**\n' +
          '- File: read, write, replace, apply_diff, batch_read\n' +
          '- Search: codebase_search, search_files, glob_files\n' +
          '- Git: status, diff, log, commit, branch\n' +
          '- Verify: run_lint, run_tests\n' +
          '- Memory: persist facts across sessions\n' +
          '- Shell: execute commands\n' +
          '- Vision: screenshot_url, analyze_image\n' +
          '- Browser: open, click, type, extract, evaluate, wait, screenshot\n' +
          '- MCP: external tool servers\n\n' +
          '**Tips:**\n' +
          '- Use `@` in the input to search and attach files\n' +
          '- Agent auto-gathers relevant context from your codebase\n' +
          '- Create `.isocode/rules.md` for project-specific instructions'
        );
        promptInput.value = '';
        return;
      }
      if (cmd === '/clear') {
        if (chatHistory) chatHistory.innerHTML = '';
        promptInput.value = '';
        return;
      }
      if (cmd === '/new') {
        const oldId = getSessionId();
        vscode.postMessage({ type: 'create-new-session', oldSessionId: oldId });
        window._isoSessionId = null; // Reset so next getSessionId() creates a fresh one
        if (conversationManager) conversationManager.createConversation();
        if (chatHistory) chatHistory.innerHTML = '';
        promptInput.value = '';
        return;
      }

      // Fall through to workflow commands
      if (workflowCommands) {
        const result = workflowCommands.executeCommand(raw);
        if (result) {
          if (result.type === 'help') {
            renderAgentMessage(result.content);
          } else if (result.action === 'clear-chat' && chatHistory) {
            chatHistory.innerHTML = '';
          } else if (result.action === 'new-conversation' && conversationManager) {
            conversationManager.createConversation();
            if (chatHistory) chatHistory.innerHTML = '';
          }
          promptInput.value = '';
          return;
        }
      }
    }

    const userRow = createMessageRow('user', raw);
    if (userRow && userRow.bubble) {
      const inlineRetry = document.createElement('button');
      inlineRetry.className = 'retry-inline-btn';
      inlineRetry.textContent = 'Retry';
      inlineRetry.onclick = () => {
        lastFullPrompt = raw;
        lastAskOptions = { ...getModeFlags(), model: modelSelect ? modelSelect.value : undefined };
        isRetryResponse = true;
        retryLastQuery();
      };
      userRow.bubble.appendChild(inlineRetry);
    }
    if (conversationManager) conversationManager.addMessage('user', raw);

    const finalPrompt = raw;

    const { autoMode, agentPlus } = getModeFlags();
    const selectedModel = modelSelect ? modelSelect.value : undefined;
    console.log('[Frontend] Sending prompt with model:', selectedModel);

    lastUserMessage = raw;
    lastFullPrompt = finalPrompt;
    lastAskOptions = { autoMode, agentPlus, model: selectedModel };

    const loadLabel = agentPlus ? 'Agent+ working...' : autoMode ? 'Agent thinking...' : 'Generating...';
    setLoading(true, loadLabel);
    vscode.postMessage({
      type: 'ask',
      value: finalPrompt,
      autoMode,
      agentPlus,
      model: selectedModel,
      contextBlobs: contextBlobs,
      sessionId: getSessionId(),
    });

    promptInput.value = '';
    persistState();
    if (typeof updateRetryButton === 'function') updateRetryButton();
  }

  function retryLastQuery() {
    if (!lastFullPrompt) return;
    isRetryResponse = true;
    setLoading(true, 'Retrying...');
    vscode.postMessage({
      type: 'ask',
      value: lastFullPrompt,
      autoMode: lastAskOptions.autoMode,
      agentPlus: lastAskOptions.agentPlus,
      model: lastAskOptions.model,
      contextBlobs: contextBlobs,
      sessionId: getSessionId(),
    });
  }

  function handleAtAutocomplete() {
    if (!promptInput || !autocompleteOverlay) return;

    const text = promptInput.value;
    const caret = promptInput.selectionStart || text.length;
    const uptoCaret = text.slice(0, caret);
    const atIndex = uptoCaret.lastIndexOf('@');
    if (atIndex === -1) {
      autocompleteOverlay.classList.add('hidden');
      return;
    }

    const token = uptoCaret.slice(atIndex + 1);
    if (/\s/.test(token)) {
      autocompleteOverlay.classList.add('hidden');
      return;
    }

    lastAtQuery = token;
    if (atSearchTimeout) clearTimeout(atSearchTimeout);
    atSearchTimeout = setTimeout(() => {
      vscode.postMessage({
        type: 'search-files',
        value: lastAtQuery,
      });
    }, 200);
  }

  function renderAutocompleteList(items) {
    if (!autocompleteOverlay) return;
    if (!items || items.length === 0) {
      autocompleteOverlay.classList.add('hidden');
      autocompleteIndex = -1;
      return;
    }

    autocompleteItems = items;
    autocompleteIndex = -1;

    autocompleteOverlay.innerHTML = '';
    const ul = document.createElement('ul');
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.textContent = item.label;
      li.dataset.index = index;
      li.onclick = () => {
        selectAutocompleteItem(index);
      };
      ul.appendChild(li);
    });
    autocompleteOverlay.appendChild(ul);
    autocompleteOverlay.classList.remove('hidden');
  }

  function selectAutocompleteItem(index) {
    const item = autocompleteItems[index];
    if (!item) return;
    vscode.postMessage({
      type: 'read-file-context',
      value: item.path,
    });
    autocompleteOverlay.classList.add('hidden');
    autocompleteIndex = -1;
    // Clear the @ search from input
    if (promptInput) {
      const text = promptInput.value;
      const caret = promptInput.selectionStart || text.length;
      const uptoCaret = text.slice(0, caret);
      const atIndex = uptoCaret.lastIndexOf('@');
      if (atIndex !== -1) {
        promptInput.value = text.slice(0, atIndex) + text.slice(caret);
        promptInput.selectionStart = promptInput.selectionEnd = atIndex;
      }
    }
  }

  function navigateAutocomplete(direction) {
    if (!autocompleteOverlay || autocompleteOverlay.classList.contains('hidden')) return;
    
    const items = autocompleteOverlay.querySelectorAll('li');
    if (items.length === 0) return;

    // Remove previous selection
    items.forEach(item => item.classList.remove('selected'));

    if (direction === 'down') {
      autocompleteIndex = (autocompleteIndex + 1) % items.length;
    } else if (direction === 'up') {
      autocompleteIndex = autocompleteIndex <= 0 ? items.length - 1 : autocompleteIndex - 1;
    } else if (direction === 'enter' && autocompleteIndex >= 0) {
      selectAutocompleteItem(autocompleteIndex);
      return;
    }

    if (autocompleteIndex >= 0 && autocompleteIndex < items.length) {
      items[autocompleteIndex].classList.add('selected');
      items[autocompleteIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function openSettings() {
    if (!settingsPanel) return;
    settingsPanel.style.display = 'flex';
    settingsPanel.classList.remove('hidden');
    settingsBackdrop.classList.remove('hidden');
    vscode.postMessage({ type: 'get-settings' });
  }
  
  function parseUnifiedDiff(diff) {
  const lines = diff.split('\n');
  return lines.map(line => {
    if (line.startsWith('+')) return { type: 'add', text: line };
    if (line.startsWith('-')) return { type: 'del', text: line };
    return { type: 'ctx', text: line };
  });
  }


  function renderDiffApproval(msg) {
  pendingDiffs.push(msg);
  const { row, bubble } = createMessageRow('assistant', '');
  bubble.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'diff-header';
  header.textContent = `Proposed changes: ${msg.filePath}`;
  bubble.appendChild(header);

  const diffContainer = document.createElement('div');
  diffContainer.className = 'diff-container';

  const parsed = parseUnifiedDiff(msg.diff);

  parsed.forEach(l => {
    const line = document.createElement('div');
    line.className = `diff-line ${l.type}`;
    line.textContent = l.text;
    diffContainer.appendChild(line);
  });

  bubble.appendChild(diffContainer);

  const actions = document.createElement('div');
  actions.className = 'diff-actions';

  const approve = document.createElement('button');
  approve.textContent = 'Apply';
  approve.onclick = () => {
    vscode.postMessage({
      type: 'agent-decision',
      decision: 'approve',
      sessionId: msg.sessionId,
      filePath: msg.filePath,
      diff: msg.diff
    });
  };

  const reject = document.createElement('button');
  reject.textContent = 'Reject';
  reject.onclick = () => {
    vscode.postMessage({
      type: 'agent-decision',
      decision: 'reject',
      sessionId: msg.sessionId,
      filePath: msg.filePath
    });
  };

  const applyAll = document.createElement('button');
  applyAll.textContent = 'Apply All';
  applyAll.onclick = () => {
  pendingDiffs.forEach(d => {
    vscode.postMessage({
      type: 'agent-decision',
      decision: 'approve',
      sessionId: d.sessionId,
      filePath: d.filePath,
      diff: d.diff
    });
  });
  pendingDiffs = [];
};


  actions.appendChild(approve);
  actions.appendChild(reject);
  actions.appendChild(applyAll);
  bubble.appendChild(actions);
  }



  function closeSettings() {
    if (!settingsPanel) return;
    settingsPanel.style.display = 'none';
    settingsPanel.classList.add('hidden');
    settingsBackdrop.classList.add('hidden');
  }

  // Event wiring
  if (sendBtn) {
    sendBtn.addEventListener('click', sendPrompt);
  } else {
    console.error('[IsoCode] send button not found');
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'stop-agent', sessionId: getSessionId() });
      setLoading(false, '');
    });
  }
  if (promptInput) {
    promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (autocompleteIndex >= 0) {
          e.preventDefault();
          navigateAutocomplete('enter');
          return;
        }
        e.preventDefault();
        sendPrompt();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!autocompleteOverlay.classList.contains('hidden')) {
          e.preventDefault();
          navigateAutocomplete(e.key === 'ArrowDown' ? 'down' : 'up');
        }
      } else if (e.key === 'Escape') {
        autocompleteOverlay.classList.add('hidden');
        autocompleteIndex = -1;
      }
    });
    promptInput.addEventListener('keyup', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') {
        handleAtAutocomplete();
      }
    });
  } else {
    console.error('[IsoCode] prompt input not found');
  }

  // Model switch mid-chat — notify server to summarize context for new model
  let previousModel = modelSelect ? modelSelect.value : undefined;
  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      const newModel = modelSelect.value;
      if (newModel && newModel !== previousModel && previousModel && previousModel !== 'local') {
        vscode.postMessage({
          type: 'switch-model',
          model: newModel,
          sessionId: getSessionId()
        });
      }
      previousModel = newModel;
      persistState();
    });
  }

  if (addContextBtn) {
    addContextBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'select-context-files' });
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', openSettings);
  }
  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', closeSettings);
  }

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', () => {
      vscode.postMessage({
        type: 'save-settings',
        value: {
          shellPerm: permShell ? permShell.value : 'ask',
          editPerm: permEdit ? permEdit.value : 'ask',
          mcpConfig: mcpConfig ? mcpConfig.value : '',
          sysPrompt: sysPrompt ? sysPrompt.value : '',
          historyLimit: historyLimit ? parseInt(historyLimit.value) : 50,
          contextWindow: contextWindow ? parseInt(contextWindow.value) : 10,
          mcpEnabled: mcpEnabled ? mcpEnabled.checked : false,
        },
      });
      closeSettings();
    });
  }

  if (settingsBackdrop) {
    settingsBackdrop.addEventListener('click', closeSettings);
  }

  // Escape key to close settings
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      if (autocompleteOverlay) autocompleteOverlay.classList.add('hidden');
    }
  });

  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      const oldId = getSessionId();
      vscode.postMessage({ type: 'create-new-session', oldSessionId: oldId });
      window._isoSessionId = null; // Reset for fresh session
      if (conversationManager) conversationManager.createConversation();
      if (chatHistory) chatHistory.innerHTML = '';
    });
  }

  if (historyBtn && conversationManager) {
    historyBtn.addEventListener('click', () => {
      conversationManager.renderHistorySidebar();
    });
  }

  function renderChatFromMessages(messages) {
    if (!chatHistory) return;
    chatHistory.innerHTML = '';
    if (!messages || !messages.length) return;
    messages.forEach((msg) => {
      const sender = msg.sender === 'user' ? 'user' : 'assistant';
      const content = typeof msg.content === 'string' ? msg.content : (msg.content?.content ?? String(msg.content));
      createMessageRow(sender, content);
    });
  }

  window.onIsoCodeSwitchConversation = function (convId, messages) {
    renderChatFromMessages(messages || []);
    const sidebar = document.querySelector('.conversation-sidebar');
    if (sidebar) {
      sidebar.style.right = '-300px';
      setTimeout(() => sidebar.remove(), 300);
    }
  };
  window.onIsoCodeNewConversation = function () {
    if (chatHistory) chatHistory.innerHTML = '';
    const sidebar = document.querySelector('.conversation-sidebar');
    if (sidebar) {
      sidebar.style.right = '-300px';
      setTimeout(() => sidebar.remove(), 300);
    }
  };

  if (closeWindowBtn) {
    closeWindowBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'close-sidebar' });
    });
  }

  // Retry button (re-send last query)
  const retryBtn = document.getElementById('retry-btn');
  function updateRetryButton() {
    if (retryBtn) retryBtn.disabled = !lastFullPrompt;
  }
  if (retryBtn) {
    retryBtn.addEventListener('click', () => retryLastQuery());
    updateRetryButton();
  }

  // Initial state
  if (modePills && modePills.length) {
    modePills.forEach((btn) => {
      btn.addEventListener('click', () => setAssistantMode(btn.dataset.mode || 'chat'));
    });
  }
  const restoredMode =
    (typeof state.assistantMode === 'string' && state.assistantMode) ||
    (state.agentPlusMode ? 'agent_plus' : (state.agentMode ? 'agent' : 'chat'));
  setAssistantMode(restoredMode);
  if (modelSelect && state.selectedModel) {
    modelSelect.value = state.selectedModel;
  }
  renderContextChips();

  // Listen for messages from extension (must be registered BEFORE requesting models)
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'diff_request' && message.filePath) {
      setLoading(false, '');
      renderDiffApproval(message);
      vscode.postMessage({ type: 'preview-diff', filePath: message.filePath, diff: message.diff });
      return;
    }
    if (message && message.type === 'final' && message.content != null) {
      setLoading(false);
      renderAgentMessage(String(message.content));
      if (conversationManager) conversationManager.addMessage('assistant', message.content);
      if (typeof updateRetryButton === 'function') updateRetryButton();
      return;
    }
    switch (message.type) {
      case 'thought': {
        setLoading(true, 'Thinking...');
        if (message.content && chatHistory) {
          const text = String(message.content).slice(0, 150);
          // Skip duplicate compaction messages
          if (text.includes('Compacting conversation')) break;
          // Skip duplicate thought/plan (same content as last) to avoid repeated PLAN steps in Agent+
          const thoughtKey = text.replace(/\s+/g, ' ').trim().slice(0, 100);
          if (thoughtKey && thoughtKey === lastThoughtKey) break;
          lastThoughtKey = thoughtKey;

          const body = getOrCreateStepsGroup();
          const div = document.createElement('div');
          // Detect plan/progress thoughts and style them differently
          const isPlan = text.includes('PLAN:') || text.includes('PLAN\n') || /^\d+\.\s/.test(text);
          const isProgress = text.includes('PROGRESS:') || text.includes('Completed task') || text.includes('Continuing');
          if (isPlan) {
            div.className = 'thought-activity plan-thought';
            div.innerHTML = `<span class="tool-icon">📋</span> <span class="thought-text">${escapeHtml(text)}</span>`;
          } else if (isProgress) {
            div.className = 'thought-activity progress-thought';
            div.innerHTML = `<span class="tool-icon">✅</span> <span class="thought-text">${escapeHtml(text)}</span>`;
          } else {
            div.className = 'thought-activity';
            div.innerHTML = `<span class="tool-icon">💭</span> <span class="thought-text">${escapeHtml(text)}</span>`;
          }
          body.appendChild(div);
          currentStepsCount++;
          updateStepsLabel();
          scrollChatToBottom();
        }
        break;
      }
      case 'action': {
        lastThoughtKey = ''; // new action = allow next thought to show even if similar
        const toolName = message.tool || 'tool';
        const toolLabels = {
          'read_file': 'Reading file...', 'write_file': 'Writing file...',
          'replace_in_file': 'Editing file...', 'apply_diff': 'Applying changes...',
          'search_files': 'Searching code...', 'codebase_search': 'Searching codebase...',
          'list_files': 'Listing files...', 'glob_files': 'Finding files...',
          'batch_read': 'Reading files...', 'run_shell': 'Running command...',
          'run_lint': 'Running linter...', 'run_tests': 'Running tests...',
          'git_status': 'Checking git...', 'git_diff': 'Getting diff...',
          'git_commit': 'Committing...', 'git_log': 'Reading git log...',
          'git_branch': 'Branch operation...', 'memory_read': 'Reading memory...',
          'memory_write': 'Saving to memory...',
          'screenshot_url': 'Capturing screenshot...', 'analyze_image': 'Analyzing image...',
          'browser_open': 'Opening browser...', 'browser_screenshot': 'Taking screenshot...',
          'browser_click': 'Clicking element...', 'browser_type': 'Typing text...',
          'browser_extract': 'Extracting content...', 'browser_evaluate': 'Running JS...',
          'browser_wait': 'Waiting...', 'browser_close': 'Closing browser...',
          'read_url': 'Reading URL...',
        };
        setLoading(true, toolLabels[toolName] || `Running ${toolName}...`);

        if (chatHistory) {
          const argsPreview = message.args
            ? Object.entries(message.args)
                .filter(([k]) => !['content', 'diff'].includes(k))
                .map(([k,v]) => `${k}=${typeof v === 'string' ? v.slice(0,35) : v}`)
                .join(', ').slice(0, 80)
            : '';
          const body = getOrCreateStepsGroup();
          const div = document.createElement('div');
          div.className = 'tool-activity';
          div.innerHTML = `<span class="tool-icon">🔧</span> <span class="tool-name">${escapeHtml(toolName)}</span>${argsPreview ? `<span class="tool-args">${escapeHtml(argsPreview)}</span>` : ''}`;
          body.appendChild(div);
          currentStepsCount++;
          updateStepsLabel();
          scrollChatToBottom();
        }
        break;
      }
      case 'observation': {
        setLoading(true, 'Analyzing...');
        const obs = message.content;
        if (obs && typeof obs === 'object') {
          if (obs.autoApplied) {
            // Agent+ auto-applied a diff
            const body = getOrCreateStepsGroup();
            const div = document.createElement('div');
            div.className = 'thought-activity progress-thought';
            div.innerHTML = `<span class="tool-icon">⚡</span> <span class="thought-text">Changes auto-applied (Agent+ mode)</span>`;
            body.appendChild(div);
            currentStepsCount++;
            updateStepsLabel();
          } else if (obs.error) {
            renderAgentMessage(`⚠️ ${String(obs.error)}`);
          }
        }
        break;
      }
      case 'addResponse': {
        setLoading(false);
        const text = message.value || '';
        const normalized = normalizeResponseValue(text);
        if (normalized && normalized.trim()) {
          renderAgentMessage(normalized);
        }
        if (conversationManager) {
          conversationManager.addMessage('assistant', text);
        }
        if (pendingPermissionEl) {
          pendingPermissionEl = null;
        }
        if (typeof updateRetryButton === 'function') updateRetryButton();
        break;
      }
      case 'search-results': {
        renderAutocompleteList(message.value || []);
        break;
      }
      case 'add-context-blob': {
        const blob = message.value;
        if (blob && blob.path) {
          const idx = contextBlobs.findIndex((b) => b.path === blob.path);
          if (idx >= 0) {
            contextBlobs[idx] = { ...contextBlobs[idx], ...blob };
          } else {
            contextBlobs.push(blob);
          }
          renderContextChips();
          persistState();
        }
        break;
      }
      case 'append-to-prompt': {
        if (promptInput) {
          promptInput.value = `${message.value || ''}\n${promptInput.value}`;
        }
        break;
      }
      case 'clear-chat': {
        if (chatHistory) chatHistory.innerHTML = '';
        break;
      }
      case 'sidebar-opened': {
        // New chat: context = only files currently open in editor
        const openFiles = message.openEditorFiles || [];
        contextBlobs = openFiles.map((f) => ({ name: f.name || f.path, path: f.path, content: f.content || '' }));
        if (chatHistory) chatHistory.innerHTML = '';
        if (conversationManager && typeof conversationManager.createConversation === 'function') {
          conversationManager.createConversation();
        }
        renderContextChips();
        persistState();
        break;
      }
      case 'models': {
        const raw = message.value;
        const models = Array.isArray(raw) ? raw : [];
        if (!modelSelect) break;
        modelSelect.innerHTML = '';
        if (models.length > 0) {
          models.forEach((m) => {
            const opt = document.createElement('option');
            const id = m.id || m.name || m.model || String(m);
            const label = m.displayName || m.id || m.name || m.model || String(m);
            opt.value = id;
            opt.textContent = label;
            modelSelect.appendChild(opt);
          });
          if (state.selectedModel && models.some((m) => (m.id || m.name || m.model) === state.selectedModel)) {
            modelSelect.value = state.selectedModel;
          } else {
            modelSelect.value = models[0].id || models[0].name || models[0].model || String(models[0]);
          }
        } else {
          const def = document.createElement('option');
          def.value = 'local';
          def.textContent = 'No models found — check Ollama/LM Studio';
          modelSelect.appendChild(def);
        }
        break;
      }
      case 'sessions': {
        const { active = [], saved = [] } = message.value || {};
        let html = '**Active sessions:**\n';
        if (active.length === 0) html += '- (none)\n';
        for (const s of active) {
          html += `- \`${s.sessionId}\` — ${s.messageCount} msgs, ~${s.estimatedTokens} tokens, model: ${s.model || 'default'}\n`;
        }
        html += '\n**Saved conversations:**\n';
        if (saved.length === 0) html += '- (none)\n';
        for (const s of saved.slice(0, 10)) {
          html += `- \`${s.sessionId}\` — ${s.messageCount} msgs — ${s.preview || '(no preview)'}\n`;
        }
        renderAgentMessage(html);
        break;
      }
      case 'stream-chunk': {
        const chunk = message.content || '';
        if (message.first) {
          setLoading(false);
          if (isRetryResponse && lastAssistantRow && lastAssistantBubble) {
            const panel2 = prepareLastAssistantForStreamingV2();
            isRetryResponse = false;
            if (panel2) {
              const streamContainer = document.createElement('div');
              streamContainer.id = 'streaming-bubble';
              const textNode = document.createElement('span');
              textNode.className = 'streaming-text';
              textNode.textContent = chunk;
              const cursor = document.createElement('span');
              cursor.className = 'streaming-cursor';
              cursor.textContent = '▌';
              streamContainer.appendChild(textNode);
              streamContainer.appendChild(cursor);
              panel2.appendChild(streamContainer);
            }
          } else {
            isRetryResponse = false;
            const { row, bubble } = createMessageRow('assistant', '') || {};
            if (bubble) {
              bubble.id = 'streaming-bubble';
              bubble.innerHTML = '';
              const textNode = document.createElement('span');
              textNode.className = 'streaming-text';
              textNode.textContent = chunk;
              bubble.appendChild(textNode);
              const cursor = document.createElement('span');
              cursor.className = 'streaming-cursor';
              cursor.textContent = '▌';
              bubble.appendChild(cursor);
            }
          }
        } else {
          const bubble = document.getElementById('streaming-bubble');
          if (bubble) {
            const textNode = bubble.querySelector('.streaming-text');
            if (textNode) textNode.textContent += chunk;
            scrollChatToBottom();
          }
        }
        break;
      }
      case 'stream-end': {
        const bubble = document.getElementById('streaming-bubble');
        if (bubble) {
          const cursor = bubble.querySelector('.streaming-cursor');
          if (cursor) cursor.remove();
          bubble.removeAttribute('id');
          const fullContent = message.content || '';
          bubble.innerHTML = renderMarkdownToHtml(fullContent);
        }
        if (conversationManager) conversationManager.addMessage('assistant', message.content || '');
        break;
      }
      case 'health': {
        const h = message.value || {};
        if (!h.ok && chatHistory) {
          const provider = h.provider || 'LLM';
          const hint = provider === 'ollama'
            ? 'Run <code>ollama serve</code> and pull a model: <code>ollama pull qwen2.5-coder:7b</code>'
            : provider === 'lmstudio'
              ? 'Start LM Studio and load a model.'
              : 'Check your LLM API configuration.';
          const div = document.createElement('div');
          div.className = 'message system-message';
          div.innerHTML = `<div class="message-content" style="color: var(--vscode-errorForeground, #f44); font-size: 0.85rem;">⚠️ ${escapeHtml(provider)} server not reachable. ${hint}</div>`;
          chatHistory.appendChild(div);
          chatHistory.scrollTop = chatHistory.scrollHeight;
        }
        break;
      }
      case 'settings': {
        const v = message.value || {};
        if (permShell && v.shellPerm) permShell.value = v.shellPerm;
        if (permEdit && v.editPerm) permEdit.value = v.editPerm;
        if (mcpConfig && typeof v.mcpConfig === 'string') mcpConfig.value = v.mcpConfig;
        if (sysPrompt && typeof v.sysPrompt === 'string') sysPrompt.value = v.sysPrompt;
        if (historyLimit && v.historyLimit) historyLimit.value = v.historyLimit;
        if (contextWindow && v.contextWindow) contextWindow.value = v.contextWindow;
        if (mcpEnabled && typeof v.mcpEnabled === 'boolean') mcpEnabled.checked = v.mcpEnabled;
        break;
      }
    }
  });

  // Tell extension host that webview boot completed
  vscode.postMessage({ type: 'webview-ready' });

  // Request models after listener is ready so we don't miss the response
  vscode.postMessage({ type: 'get-models' });
  // Retry after 1.5s in case server wasn't ready (e.g. LM Studio / Node just started)
  setTimeout(function () {
    vscode.postMessage({ type: 'get-models' });
  }, 1500);

  // Auto-add currently active editor file to context on startup (can remove with x)
  vscode.postMessage({ type: 'get-active-file' });
})();
