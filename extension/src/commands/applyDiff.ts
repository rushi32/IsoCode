import * as vscode from 'vscode';
import { applyUnifiedDiff } from '../utils/applyUnifiedDiff';

export function registerApplyDiffCommand(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('isocode.applyDiff', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('IsoCode: Open a file and select code to apply diff.');
                return;
            }
            
            const selection = editor.selection;
            const text = editor.document.getText(selection);
            
            if (!text || !text.trim()) {
                vscode.window.showInformationMessage('IsoCode: Select some diff text first, then run Apply Diff.');
                return;
            }
            
            try {
                // Get the current file path
                const filePath = editor.document.fileName;
                
                // Apply the diff to the current file
                await applyUnifiedDiff(filePath, text);
                
                vscode.window.showInformationMessage('IsoCode: Diff applied successfully!');
            } catch (error) {
                vscode.window.showErrorMessage(`IsoCode: Error applying diff - ${error}`);
            }
        })
    );
}