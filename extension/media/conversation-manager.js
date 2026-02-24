/**
 * Conversation Manager - Handles conversation history and switching
 */

class ConversationManager {
    constructor(vscode) {
        this.vscode = vscode;
        this.conversations = [];
        this.currentConversationId = null;
        this.loadConversations();
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /**
     * Create a new conversation
     */
    createConversation(title = 'New Chat') {
        const conversation = {
            id: this.generateId(),
            title: title,
            messages: [],
            artifacts: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        this.conversations.push(conversation);
        this.currentConversationId = conversation.id;
        this.saveConversations();

        return conversation;
    }

    /**
     * Get current conversation
     */
    getCurrentConversation() {
        let conv = this.conversations.find(c => c.id === this.currentConversationId);
        if (!conv) {
            conv = this.createConversation('Chat ' + (this.conversations.length + 1));
        }
        return conv;
    }

    /**
     * Switch to a different conversation
     */
    switchConversation(conversationId) {
        const conversation = this.conversations.find(c => c.id === conversationId);
        if (conversation) {
            this.currentConversationId = conversationId;
            this.saveConversations();
            return conversation;
        }
        return null;
    }

    /**
     * Add message to current conversation
     */
    addMessage(sender, content) {
        const conversation = this.getCurrentConversation();
        conversation.messages.push({
            id: this.generateId(),
            sender,
            content,
            timestamp: Date.now()
        });
        conversation.updatedAt = Date.now();
        this.saveConversations();
    }

    /**
     * Delete a conversation
     */
    deleteConversation(conversationId) {
        this.conversations = this.conversations.filter(c => c.id !== conversationId);
        if (this.currentConversationId === conversationId) {
            this.currentConversationId = this.conversations[0]?.id || null;
        }
        this.saveConversations();
    }

    /**
     * Update conversation title
     */
    updateTitle(conversationId, title) {
        const conversation = this.conversations.find(c => c.id === conversationId);
        if (conversation) {
            conversation.title = title;
            this.saveConversations();
        }
    }

    /**
     * Get all conversations sorted by update time
     */
    getAllConversations() {
        return [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    /**
     * Save conversations to state
     */
    saveConversations() {
        if (!this.vscode) return;
        try {
            const state = this.vscode.getState() || {};
            state.conversations = this.conversations;
            state.currentConversationId = this.currentConversationId;
            this.vscode.setState(state);
        } catch (e) {
            console.error('Failed to save conversations:', e);
        }
    }

    /**
     * Load conversations from state
     */
    loadConversations() {
        if (!this.vscode) return;
        try {
            const state = this.vscode.getState() || {};
            this.conversations = state.conversations || [];
            this.currentConversationId = state.currentConversationId || (this.conversations[0]?.id || null);

            if (this.conversations.length === 0) {
                this.createConversation('Chat 1');
            }
        } catch (e) {
            console.error('Failed to load conversations:', e);
            this.conversations = [];
            this.createConversation('Chat 1');
        }
    }

    /**
     * Render conversation history sidebar
     */
    renderHistorySidebar() {
        const existing = document.querySelector('.conversation-sidebar');
        if (existing) existing.remove();

        const sidebar = document.createElement('div');
        sidebar.className = 'conversation-sidebar';
        sidebar.style.cssText = `
            position: fixed;
            top: 0;
            right: -300px;
            width: 300px;
            height: 100%;
            background: var(--md-sys-color-surface);
            border-left: 1px solid var(--border-color);
            transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            box-shadow: var(--md-elevation-4);
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            padding: 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `
            <span style="font-weight: 500; font-size: 16px;">Chat History</span>
            <button class="md-icon-button close-sidebar-btn">
                <span class="material-symbols-outlined">close</span>
            </button>
        `;

        const list = document.createElement('div');
        list.style.cssText = 'flex: 1; overflow-y: auto; padding: 12px;';

        const conversations = this.getAllConversations();
        conversations.forEach(conv => {
            const item = document.createElement('div');
            const isActive = conv.id === this.currentConversationId;
            item.style.cssText = `
                padding: 12px 16px;
                border-radius: 12px;
                cursor: pointer;
                margin-bottom: 8px;
                background: ${isActive ? 'var(--md-sys-color-primary-container)' : 'transparent'};
                color: ${isActive ? 'var(--md-sys-color-on-primary-container)' : 'var(--text-primary)'};
                transition: all 0.2s ease;
                position: relative;
                border: 1px solid ${isActive ? 'var(--accent)' : 'transparent'};
            `;

            const date = new Date(conv.updatedAt);
            const timeStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            item.innerHTML = `
                <div style="font-weight: 500; font-size: 14px; margin-bottom: 4px; padding-right: 24px;">
                    ${conv.title}
                </div>
                <div style="font-size: 12px; opacity: 0.7; display: flex; justify-content: space-between;">
                    <span>${conv.messages.length} messages</span>
                    <span>${timeStr}</span>
                </div>
            `;

            item.onclick = () => {
                if (conv.id !== this.currentConversationId) {
                    this.switchConversation(conv.id);
                    if (typeof window.onIsoCodeSwitchConversation === 'function') {
                        window.onIsoCodeSwitchConversation(conv.id, conv.messages);
                    } else {
                        location.reload();
                    }
                }
            };

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'md-icon-button';
            deleteBtn.style.cssText = 'position: absolute; top: 12px; right: 8px; width: 32px; height: 32px; opacity: 0;';
            deleteBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 18px;">delete</span>';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm('Delete this conversation?')) {
                    this.deleteConversation(conv.id);
                    this.renderHistorySidebar();
                }
            };

            item.onmouseenter = () => { deleteBtn.style.opacity = '1'; };
            item.onmouseleave = () => { deleteBtn.style.opacity = '0'; };
            item.appendChild(deleteBtn);
            list.appendChild(item);
        });

        const newBtn = document.createElement('button');
        newBtn.className = 'md-button-filled';
        newBtn.style.cssText = 'margin: 16px;';
        newBtn.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
                <span class="material-symbols-outlined">add</span>
                <span>New Chat</span>
            </div>
        `;
        newBtn.onclick = () => {
            this.createConversation(`Chat ${this.conversations.length + 1}`);
            if (typeof window.onIsoCodeNewConversation === 'function') {
                window.onIsoCodeNewConversation();
            } else {
                location.reload();
            }
        };

        sidebar.appendChild(header);
        sidebar.appendChild(list);
        sidebar.appendChild(newBtn);

        header.querySelector('.close-sidebar-btn').onclick = () => {
            sidebar.style.right = '-300px';
            setTimeout(() => sidebar.remove(), 300);
        };

        document.body.appendChild(sidebar);
        setTimeout(() => { sidebar.style.right = '0'; }, 10);
    }

    /**
     * Export conversation as JSON
     */
    exportConversation(conversationId) {
        const conversation = this.conversations.find(c => c.id === conversationId);
        if (conversation) {
            const data = JSON.stringify(conversation, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${conversation.title.replace(/\s+/g, '-')}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }
    }
}

// Global export
window.ConversationManager = ConversationManager;
