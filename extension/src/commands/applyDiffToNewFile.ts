import * as vscode from 'vscode';
import { applyUnifiedDiff } from '../utils/applyUnifiedDiff';

export function registerApplyDiffToNewFileCommand(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('isocode.applyDiffToNewFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('IsoCode: Open a file and select code to apply diff.');
                return;
            }
            
            const selection = editor.selection;
            const text = editor.document.getText(selection);
            
            if (!text || !text.trim()) {
                vscode.window.showInformationMessage('IsoCode: Select some diff text first, then run Apply Diff to New File.');
                return;
            }
            
            try {
                // Get the file path from user input
                const filePath = await vscode.window.showInputBox({
                    prompt: 'Enter path for new file (e.g., src/newFile.ts)',
                    placeHolder: 'src/newFile.ts'
                });
                
                if (!filePath) {
                    vscode.window.showInformationMessage('IsoCode: No file path provided.');
                    return;
                }
                
                // Apply the diff to create a new file
                await applyUnifiedDiff(filePath, text);
                
                vscode.window.showInformationMessage('IsoCode: Diff applied to new file successfully!');
            } catch (error) {
                vscode.window.showErrorMessage(`IsoCode: Error applying diff to new file - ${error}`);
            }
        })
    );
}