// Webview entry: boots Cytoscape, wires the toolbar, and handles the
// postMessage protocol with the extension host.

import './styles.css';
import { CytoscapeManager } from './CytoscapeManager';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../src/shared/types';

interface VsCodeApi {
  postMessage(msg: WebviewToExtensionMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

function post(msg: WebviewToExtensionMessage): void {
  vscode.postMessage(msg);
}

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = text;
  }
}

const container = document.getElementById('cy');
if (!container) {
  throw new Error('missing #cy container');
}
const manager = new CytoscapeManager(container);

document.getElementById('refresh')?.addEventListener('click', () => {
  setStatus('refreshing…');
  post({ type: 'requestRefresh' });
});
document.getElementById('expand-all')?.addEventListener('click', () => manager.expandAll());
document.getElementById('collapse-all')?.addEventListener('click', () => manager.collapseAll());
document.getElementById('imports-toggle')?.addEventListener('change', (e) => {
  manager.setImportsVisible((e.target as HTMLInputElement).checked);
});
document.getElementById('calls-toggle')?.addEventListener('change', (e) => {
  manager.setCallsVisible((e.target as HTMLInputElement).checked);
});

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'graph': {
      const { nodes, edges } = msg.payload;
      manager.setGraph(msg.payload);
      const files = nodes.filter((n) => n.type === 'file').length;
      setStatus(`${files} files · ${nodes.length} nodes · ${edges.length} edges`);
      break;
    }
    case 'error':
      setStatus(msg.payload);
      break;
  }
});

// Handshake: signal the host we're ready before it sends the first graph.
post({ type: 'ready' });
