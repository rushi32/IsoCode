/**
 * Artifacts Module - Handles creation, storage, and display of artifacts
 * (task lists, implementation plans, walkthroughs)
 */

class ArtifactManager {
    constructor() {
        this.artifacts = [];
        this.conversationId = this.generateId();
        this.loadArtifacts();
    }

    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    /**
     * Parse agent response for artifact markers
     * Looks for patterns like:
     * - # task.md
     * - # implementation_plan.md
     * - # walkthrough.md
     */
    detectArtifacts(text) {
        const artifactPatterns = [
            { type: 'task', pattern: /# task\.md\n([\s\S]*?)(?=\n#|$)/i },
            { type: 'implementation_plan', pattern: /# implementation_plan\.md\n([\s\S]*?)(?=\n#|$)/i },
            { type: 'walkthrough', pattern: /# walkthrough\.md\n([\s\S]*?)(?=\n#|$)/i }
        ];

        const detected = [];

        for (const { type, pattern } of artifactPatterns) {
            const match = text.match(pattern);
            if (match) {
                detected.push({
                    type,
                    content: match[1].trim(),
                    filename: `${type}.md`
                });
            }
        }

        return detected;
    }

    /**
     * Create and store an artifact
     */
    createArtifact(type, content, metadata = {}) {
        const artifact = {
            id: this.generateId(),
            type,
            content,
            filename: metadata.filename || `${type}.md`,
            timestamp: Date.now(),
            conversationId: this.conversationId,
            metadata
        };

        this.artifacts.push(artifact);
        this.saveArtifacts();

        return artifact;
    }

    /**
     * Get all artifacts for current conversation
     */
    getArtifacts() {
        return this.artifacts.filter(a => a.conversationId === this.conversationId);
    }

    /**
     * Get artifact by ID
     */
    getArtifact(id) {
        return this.artifacts.find(a => a.id === id);
    }

    /**
     * Delete artifact
     */
    deleteArtifact(id) {
        this.artifacts = this.artifacts.filter(a => a.id !== id);
        this.saveArtifacts();
    }

    /**
     * Save artifacts to localStorage
     */
    saveArtifacts() {
        try {
            const state = vscode.getState() || {};
            state.artifacts = this.artifacts;
            vscode.setState(state);
        } catch (e) {
            console.error('Failed to save artifacts:', e);
        }
    }

    /**
     * Load artifacts from localStorage
     */
    loadArtifacts() {
        try {
            const state = vscode.getState() || {};
            this.artifacts = state.artifacts || [];
        } catch (e) {
            console.error('Failed to load artifacts:', e);
            this.artifacts = [];
        }
    }

    /**
     * Render artifact preview card
     */
    renderArtifactPreview(artifact) {
        const iconMap = {
            task: '✅',
            implementation_plan: '📋',
            walkthrough: '🚶',
            other: '📄'
        };

        const preview = document.createElement('div');
        preview.className = 'artifact-preview md-card';
        preview.innerHTML = `
            <div class="artifact-header">
                <span class="artifact-icon">${iconMap[artifact.type] || iconMap.other}</span>
                <span class="artifact-title">${artifact.filename}</span>
                <div class="artifact-actions">
                    <button class="md-icon-button artifact-view-btn" title="View">
                        👁️
                    </button>
                    <button class="md-icon-button artifact-download-btn" title="Download">
                        💾
                    </button>
                </div>
            </div>
            <div class="artifact-content">
                ${this.renderMarkdownPreview(artifact.content)}
            </div>
        `;

        // Event listeners
        preview.querySelector('.artifact-view-btn').onclick = () => {
            this.openArtifactViewer(artifact);
        };

        preview.querySelector('.artifact-download-btn').onclick = () => {
            this.downloadArtifact(artifact);
        };

        return preview;
    }

    /**
     * Simple markdown preview (basic rendering)
     */
    renderMarkdownPreview(content) {
        // Take first 200 chars for preview
        const preview = content.substring(0, 200);

        return preview
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/^### (.+)$/gm, '<strong>$1</strong>')
            .replace(/^## (.+)$/gm, '<strong>$1</strong>')
            .replace(/^# (.+)$/gm, '<strong>$1</strong>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>')
            + (content.length > 200 ? '...' : '');
    }

    /**
     * Open full artifact viewer in a modal/panel
     */
    openArtifactViewer(artifact) {
        // Send message to extension to open artifact in editor or new panel
        if (typeof vscode !== 'undefined') {
            vscode.postMessage({
                type: 'view-artifact',
                value: artifact
            });
        }
    }

    /**
     * Download artifact as file
     */
    downloadArtifact(artifact) {
        const blob = new Blob([artifact.content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = artifact.filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Render artifacts list panel
     */
    renderArtifactsList() {
        const artifacts = this.getArtifacts();
        const container = document.createElement('div');
        container.className = 'artifacts-list';

        if (artifacts.length === 0) {
            container.innerHTML = '<p style="color: var(--text-secondary); padding: 16px; text-align: center;">No artifacts yet</p>';
            return container;
        }

        artifacts.forEach(artifact => {
            container.appendChild(this.renderArtifactPreview(artifact));
        });

        return container;
    }
}

// Export for use in main.js
if (typeof window !== 'undefined') {
    window.ArtifactManager = ArtifactManager;
}
