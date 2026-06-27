import * as vscode from 'vscode';
import { GraphPanel } from './panel/GraphPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('repoGraph.showGraph', async () => {
      try {
        await GraphPanel.show(context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Repo Graph: ${message}`);
      }
    })
  );
}

export function deactivate(): void {
  // The panel disposes itself; nothing to clean up here.
}
