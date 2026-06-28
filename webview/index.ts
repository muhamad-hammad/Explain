// Webview entry: boots Cytoscape, wires the toolbar, and handles the
// postMessage protocol with the extension host.

import './styles.css';
import { CytoscapeManager, BreadcrumbItem } from './CytoscapeManager';
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

const breadcrumbEl = document.getElementById('breadcrumb');
function renderBreadcrumb(path: BreadcrumbItem[]): void {
  if (!breadcrumbEl) {
    return;
  }
  breadcrumbEl.replaceChildren();
  if (path.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'crumb-hint';
    hint.textContent = 'click a node to see its path';
    breadcrumbEl.appendChild(hint);
    return;
  }
  path.forEach((item, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '▸';
      breadcrumbEl.appendChild(sep);
    }
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = `crumb crumb-${item.type}`;
    crumb.textContent = item.label;
    crumb.addEventListener('click', () => manager.centerOn(item.id));
    breadcrumbEl.appendChild(crumb);
  });
}

const manager = new CytoscapeManager(container, renderBreadcrumb);
renderBreadcrumb([]);

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

let searchTimer: ReturnType<typeof setTimeout> | undefined;
document.getElementById('search')?.addEventListener('input', (e) => {
  const value = (e.target as HTMLInputElement).value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => manager.search(value), 180);
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
