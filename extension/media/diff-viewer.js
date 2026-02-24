/**
 * Diff Viewer Module - Renders code diffs with syntax highlighting
 */

class DiffViewer {
    constructor() {
        this.currentDiff = null;
    }

    /**
     * Parse unified diff format
     */
    parseDiff(diffText) {
        const lines = diffText.split('\n');
        const chunks = [];
        let currentChunk = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('@@')) {
                // New chunk header
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = { header: line, lines: [] };
            } else if (currentChunk) {
                // Parse line type
                const type = line[0] === '+' ? 'add' :
                    line[0] === '-' ? 'remove' : 'context';
                const content = line.substring(1);
                currentChunk.lines.push({ type, content });
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    }

    /**
     * Create diff from before/after code
     */
    createDiff(before, after, filename = 'file') {
        const beforeLines = before.split('\n');
        const afterLines = after.split('\n');

        const diff = {
            filename,
            chunks: [{
                header: `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
                lines: []
            }]
        };

        // Simple line-by-line comparison
        const maxLines = Math.max(beforeLines.length, afterLines.length);
        for (let i = 0; i < maxLines; i++) {
            const beforeLine = beforeLines[i];
            const afterLine = afterLines[i];

            if (beforeLine === afterLine) {
                diff.chunks[0].lines.push({ type: 'context', content: beforeLine || '' });
            } else {
                if (beforeLine !== undefined) {
                    diff.chunks[0].lines.push({ type: 'remove', content: beforeLine });
                }
                if (afterLine !== undefined) {
                    diff.chunks[0].lines.push({ type: 'add', content: afterLine });
                }
            }
        }

        return diff;
    }

    /**
     * Render diff viewer UI
     */
    renderDiff(diff, options = {}) {
        const container = document.createElement('div');
        container.className = 'diff-viewer md-card';

        // Header
        const header = document.createElement('div');
        header.className = 'diff-header';
        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <span style="font-weight: 500;">📝 ${diff.filename || 'Changes'}</span>
                <div style="flex: 1;"></div>
                ${options.showActions !== false ? `
                    <button class="md-button-outlined diff-accept-btn">
                        ✓ Accept
                    </button>
                    <button class="md-button-text diff-reject-btn">
                        ✕ Reject
                    </button>
                ` : ''}
            </div>
        `;
        container.appendChild(header);

        // Diff content
        const diffContent = document.createElement('div');
        diffContent.className = 'diff-content';
        diffContent.style.maxHeight = '400px';
        diffContent.style.overflowY = 'auto';
        diffContent.style.background = 'var(--vscode-editor-background)';
        diffContent.style.borderRadius = '4px';

        diff.chunks.forEach(chunk => {
            // Chunk header
            const chunkHeader = document.createElement('div');
            chunkHeader.className = 'diff-chunk-header';
            chunkHeader.style.padding = '4px 8px';
            chunkHeader.style.background = 'var(--vscode-editorWidget-background)';
            chunkHeader.style.color = 'var(--text-secondary)';
            chunkHeader.style.fontSize = '11px';
            chunkHeader.style.fontFamily = 'monospace';
            chunkHeader.textContent = chunk.header;
            diffContent.appendChild(chunkHeader);

            // Chunk lines
            let lineNumBefore = 1;
            let lineNumAfter = 1;

            chunk.lines.forEach(line => {
                const lineEl = document.createElement('div');
                lineEl.className = `diff-line diff-line-${line.type}`;

                const lineNumbers = document.createElement('div');
                lineNumbers.className = 'diff-line-number';
                lineNumbers.style.display = 'flex';
                lineNumbers.style.gap = '8px';

                if (line.type === 'remove') {
                    lineNumbers.innerHTML = `<span>${lineNumBefore++}</span><span>-</span>`;
                } else if (line.type === 'add') {
                    lineNumbers.innerHTML = `<span>-</span><span>${lineNumAfter++}</span>`;
                } else {
                    lineNumbers.innerHTML = `<span>${lineNumBefore++}</span><span>${lineNumAfter++}</span>`;
                }

                const content = document.createElement('div');
                content.className = 'diff-line-content';
                content.textContent = line.content;

                lineEl.appendChild(lineNumbers);
                lineEl.appendChild(content);
                diffContent.appendChild(lineEl);
            });
        });

        container.appendChild(diffContent);

        // Event listeners
        if (options.showActions !== false) {
            const acceptBtn = header.querySelector('.diff-accept-btn');
            const rejectBtn = header.querySelector('.diff-reject-btn');

            if (acceptBtn) {
                acceptBtn.onclick = () => {
                    if (options.onAccept) options.onAccept(diff);
                };
            }

            if (rejectBtn) {
                rejectBtn.onclick = () => {
                    if (options.onReject) options.onReject(diff);
                };
            }
        }

        return container;
    }

    /**
     * Show diff modal
     */
    showDiffModal(before, after, filename, onAccept, onReject) {
        const diff = this.createDiff(before, after, filename);

        const modal = document.createElement('div');
        modal.className = 'diff-modal';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.right = '0';
        modal.style.bottom = '0';
        modal.style.background = 'rgba(0, 0, 0, 0.5)';
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modal.style.zIndex = '10000';
        modal.style.padding = '20px';

        const modalContent = document.createElement('div');
        modalContent.style.maxWidth = '800px';
        modalContent.style.width = '100%';
        modalContent.style.maxHeight = '80vh';
        modalContent.style.overflowY = 'auto';

        const diffViewer = this.renderDiff(diff, {
            showActions: true,
            onAccept: (diff) => {
                document.body.removeChild(modal);
                if (onAccept) onAccept(diff);
            },
            onReject: (diff) => {
                document.body.removeChild(modal);
                if (onReject) onReject(diff);
            }
        });

        modalContent.appendChild(diffViewer);
        modal.appendChild(modalContent);

        // Close on background click
        modal.onclick = (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
                if (onReject) onReject(diff);
            }
        };

        document.body.appendChild(modal);
    }
}

// Export
if (typeof window !== 'undefined') {
    window.DiffViewer = DiffViewer;
}
