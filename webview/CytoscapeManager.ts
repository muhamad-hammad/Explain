// webview/CytoscapeManager.ts
// Force-directed (fcose) Logseq-style view over the collapse/expand model.
// Elements are added lazily: only file nodes + their import edges up front; a
// node's children are materialized the first time it is expanded, so a large
// repo's canvas only ever holds what the user has drilled into.

import cytoscape, { Core, NodeSingular, ElementDefinition, Collection } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { RepoGraph, GraphNode, GraphEdge } from '../src/shared/types';

cytoscape.use(fcose);

function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

/** One step in a node's ancestor path (file ▸ class ▸ method). */
export interface BreadcrumbItem {
  id: string;
  label: string;
  type: string;
}

/** Persisted UI state (survives refresh and webview reload). */
export interface ViewState {
  expanded: string[];
  importsVisible: boolean;
  callsVisible: boolean;
}

export interface ManagerOptions {
  onSelect?: (path: BreadcrumbItem[]) => void;
  onStateChange?: (state: ViewState) => void;
}

export class CytoscapeManager {
  private cy: Core;

  // Full graph data (plain objects), indexed for lazy element creation.
  private nodeById = new Map<string, GraphNode>();
  private childrenByParent = new Map<string, GraphNode[]>();
  private renderEdges: GraphEdge[] = []; // non-contains edges (imports/calls)
  private edgesByEndpoint = new Map<string, GraphEdge[]>();
  private degreeById = new Map<string, number>();
  private orderById = new Map<string, number>(); // per-file reading order (1-based)

  // What currently exists in the Cytoscape instance.
  private added = new Set<string>();
  private addedEdges = new Set<string>();

  /** Node IDs whose children are currently shown. Files collapsed by default. */
  private expanded = new Set<string>();
  private importsVisible = true;
  private callsVisible = false;

  private readonly onSelect?: (path: BreadcrumbItem[]) => void;
  private readonly onStateChange?: (state: ViewState) => void;

  constructor(container: HTMLElement, opts: ManagerOptions = {}) {
    this.onSelect = opts.onSelect;
    this.onStateChange = opts.onStateChange;

    this.cy = cytoscape({
      container,
      style: this.buildStyle(),
      wheelSensitivity: 0.2,
      minZoom: 0.05,
      maxZoom: 4,
    });

    this.cy.on('tap', 'node', (evt) => {
      const node = evt.target as NodeSingular;
      this.select(node);
      if (this.childrenByParent.has(node.id())) {
        this.toggle(node.id());
      }
    });

    this.cy.on('mouseover', 'node', (evt) => this.focus(evt.target as NodeSingular));
    this.cy.on('mouseout', 'node', () => this.clearFocus());
  }

  /** Replace the graph. Restores prior expand/toggle state when provided. */
  setGraph(graph: RepoGraph, saved?: Partial<ViewState>): void {
    this.index(graph);

    if (saved?.importsVisible !== undefined) {
      this.importsVisible = saved.importsVisible;
    }
    if (saved?.callsVisible !== undefined) {
      this.callsVisible = saved.callsVisible;
    }
    // Keep only expanded ids that still exist (stable-id match across refresh).
    const wanted = new Set((saved?.expanded ?? [...this.expanded]).filter((id) => this.nodeById.has(id)));

    this.cy.elements().remove();
    this.added.clear();
    this.addedEdges.clear();
    this.expanded.clear();

    this.cy.startBatch();
    // File nodes (the always-visible top level).
    for (const node of this.nodeById.values()) {
      if (node.parentId === null) {
        this.addNode(node);
      }
    }
    // Restore expansion (parents before children: sort by ancestor depth).
    for (const id of [...wanted].sort((a, b) => this.depth(a) - this.depth(b))) {
      this.expanded.add(id);
      this.ensureChildren(id);
    }
    this.cy.endBatch();

    this.applyVisibility();
    this.relayout(true, false, true); // instant, randomized first render
    this.onSelect?.([]);
    this.notifyState();
  }

  expandAll(): void {
    this.cy.startBatch();
    for (const parentId of this.childrenByParent.keys()) {
      this.expanded.add(parentId);
      this.ensureChildren(parentId);
    }
    this.cy.endBatch();
    this.applyVisibility();
    this.relayout(true, true, true);
    this.notifyState();
  }

  collapseAll(): void {
    this.expanded.clear();
    this.applyVisibility();
    this.relayout(true, true, true);
    this.notifyState();
  }

  /** Recompute viewport after the container is resized (e.g. snippet split). */
  resize(): void {
    this.cy.resize();
  }

  setImportsVisible(visible: boolean): void {
    this.importsVisible = visible;
    this.cy.edges('[type = "imports"]').style('display', visible ? 'element' : 'none');
    this.notifyState();
  }

  setCallsVisible(visible: boolean): void {
    this.callsVisible = visible;
    this.cy.edges('[type = "calls"]').style('display', visible ? 'element' : 'none');
    this.notifyState();
  }

  /** Highlight a node by id, reveal it (adding + expanding ancestors), center. */
  centerOn(id: string): void {
    if (!this.nodeById.has(id)) {
      return;
    }
    this.reveal(id);
    this.applyVisibility();
    this.relayout(false, false);
    const node = this.cy.getElementById(id);
    this.select(node);
    this.cy.animate({ center: { eles: node }, zoom: Math.max(this.cy.zoom(), 0.8) }, { duration: 400 });
  }

  /** Substring search over the full graph: reveal + highlight matches, dim rest. */
  search(term: string): void {
    this.cy.elements().removeClass('search-hit search-dim');
    const t = term.trim().toLowerCase();
    if (!t) {
      return;
    }
    const matchIds: string[] = [];
    for (const node of this.nodeById.values()) {
      if (node.label.toLowerCase().includes(t)) {
        matchIds.push(node.id);
      }
    }
    if (matchIds.length === 0) {
      this.cy.nodes().addClass('search-dim');
      return;
    }
    this.cy.startBatch();
    for (const id of matchIds) {
      this.reveal(id);
    }
    this.cy.endBatch();
    this.applyVisibility();
    this.relayout(false, false);

    let matches = this.cy.collection();
    for (const id of matchIds) {
      matches = matches.union(this.cy.getElementById(id));
    }
    this.cy.batch(() => {
      this.cy.elements().addClass('search-dim');
      matches.union(matches.ancestors()).removeClass('search-dim');
      matches.addClass('search-hit');
    });
    this.cy.animate({ fit: { eles: matches, padding: 60 } }, { duration: 400 });
    this.notifyState();
  }

  // ---- lazy element creation ------------------------------------------

  private index(graph: RepoGraph): void {
    this.nodeById.clear();
    this.childrenByParent.clear();
    this.edgesByEndpoint.clear();
    this.degreeById.clear();
    this.orderById.clear();
    this.renderEdges = [];

    for (const node of graph.nodes) {
      this.nodeById.set(node.id, node);
      if (node.parentId) {
        const arr = this.childrenByParent.get(node.parentId);
        if (arr) {
          arr.push(node);
        } else {
          this.childrenByParent.set(node.parentId, [node]);
        }
      }
    }

    // Number definitions in reading order: per file, top-to-bottom by start line.
    const defsByFile = new Map<string, GraphNode[]>();
    for (const node of this.nodeById.values()) {
      if (!node.lineRange) {
        continue; // file nodes carry no range and stay unnumbered
      }
      const fileId = this.fileRootOf(node.id);
      const arr = defsByFile.get(fileId);
      if (arr) {
        arr.push(node);
      } else {
        defsByFile.set(fileId, [node]);
      }
    }
    for (const defs of defsByFile.values()) {
      defs.sort((a, b) => a.lineRange!.start - b.lineRange!.start);
      defs.forEach((n, i) => this.orderById.set(n.id, i + 1));
    }

    for (const edge of graph.edges) {
      // Degree (Logseq sizing) counts every relationship, contains included.
      bump(this.degreeById, edge.sourceId);
      bump(this.degreeById, edge.targetId);
      if (edge.type === 'contains') {
        continue;
      }
      this.renderEdges.push(edge);
      pushEdge(this.edgesByEndpoint, edge.sourceId, edge);
      pushEdge(this.edgesByEndpoint, edge.targetId, edge);
    }
  }

  private addNode(node: GraphNode): void {
    if (this.added.has(node.id)) {
      return;
    }
    const order = this.orderById.get(node.id);
    this.cy.add({
      group: 'nodes',
      data: {
        id: node.id,
        label: order ? `${order}. ${node.label}` : node.label,
        type: node.type,
        parent: node.parentId ?? undefined,
        deg: this.degreeById.get(node.id) ?? 0,
        filePath: node.filePath,
        startLine: node.lineRange?.start ?? null,
        endLine: node.lineRange?.end ?? null,
      },
    } as ElementDefinition);
    this.added.add(node.id);

    // Add any edges whose other endpoint is already present.
    for (const edge of this.edgesByEndpoint.get(node.id) ?? []) {
      const other = edge.sourceId === node.id ? edge.targetId : edge.sourceId;
      if (this.added.has(other)) {
        this.addEdge(edge);
      }
    }
  }

  private addEdge(edge: GraphEdge): void {
    if (this.addedEdges.has(edge.id)) {
      return;
    }
    const visible = edge.type === 'calls' ? this.callsVisible : this.importsVisible;
    this.cy.add({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        type: edge.type,
        label: edge.label ?? '',
      },
      style: visible ? undefined : { display: 'none' },
    } as ElementDefinition);
    this.addedEdges.add(edge.id);
  }

  private ensureChildren(parentId: string): void {
    for (const child of this.childrenByParent.get(parentId) ?? []) {
      this.addNode(child);
    }
  }

  /** Add elements + expand ancestors so node `id` becomes visible. */
  private reveal(id: string): void {
    const chain: string[] = [];
    let cur: string | null = id;
    while (cur) {
      chain.unshift(cur);
      cur = this.nodeById.get(cur)?.parentId ?? null;
    }
    // Walk root -> id, expanding + materializing children along the way.
    for (let i = 0; i < chain.length; i++) {
      this.addNode(this.nodeById.get(chain[i])!);
      if (i < chain.length - 1) {
        this.expanded.add(chain[i]);
        this.ensureChildren(chain[i]);
      }
    }
  }

  private fileRootOf(id: string): string {
    let cur: GraphNode | undefined = this.nodeById.get(id);
    while (cur && cur.parentId) {
      cur = this.nodeById.get(cur.parentId);
    }
    return cur ? cur.id : id;
  }

  private depth(id: string): number {
    let d = 0;
    let cur = this.nodeById.get(id)?.parentId ?? null;
    while (cur) {
      d++;
      cur = this.nodeById.get(cur)?.parentId ?? null;
    }
    return d;
  }

  // ---- interaction -----------------------------------------------------

  private toggle(id: string): void {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
      this.ensureChildren(id);
    }
    this.applyVisibility();
    this.relayout(false);
    this.notifyState();
  }

  private select(node: NodeSingular): void {
    this.cy.nodes('.selected').removeClass('selected');
    node.addClass('selected');
    this.emitBreadcrumb(node.id());
  }

  private emitBreadcrumb(id: string): void {
    const path: BreadcrumbItem[] = [];
    let cur: string | null = id;
    while (cur) {
      const node = this.nodeById.get(cur);
      if (!node) {
        break;
      }
      path.unshift({ id: node.id, label: node.label, type: node.type });
      cur = node.parentId;
    }
    this.onSelect?.(path);
  }

  private focus(node: NodeSingular): void {
    const hood: Collection = node
      .closedNeighborhood()
      .union(node.ancestors())
      .union(node.descendants());
    this.cy.batch(() => {
      this.cy.elements().addClass('dim');
      hood.removeClass('dim').addClass('focus');
    });
  }

  private clearFocus(): void {
    this.cy.batch(() => {
      this.cy.elements().removeClass('dim focus');
    });
  }

  /** A node is visible iff every ancestor is expanded. */
  private applyVisibility(): void {
    this.cy.batch(() => {
      this.cy.nodes().forEach((n) => {
        n.style('display', this.isVisible(n.id()) ? 'element' : 'none');
      });
      this.cy.edges('[type = "imports"]').style('display', this.importsVisible ? 'element' : 'none');
      this.cy.edges('[type = "calls"]').style('display', this.callsVisible ? 'element' : 'none');
    });
  }

  private isVisible(id: string): boolean {
    let parent = this.nodeById.get(id)?.parentId ?? null;
    while (parent) {
      if (!this.expanded.has(parent)) {
        return false;
      }
      parent = this.nodeById.get(parent)?.parentId ?? null;
    }
    return true;
  }

  private relayout(fit: boolean, animate = true, randomize = false): void {
    this.cy
      .elements(':visible')
      .layout({
        name: 'fcose',
        quality: 'default',
        animate,
        animationDuration: 500,
        animationEasing: 'ease-out',
        randomize,
        fit,
        padding: 50,
        nodeSeparation: 90,
        idealEdgeLength: () => 90,
        nodeRepulsion: () => 6000,
        gravity: 0.25,
        gravityCompound: 1.0,
        nestingFactor: 0.1,
        packComponents: true,
      } as cytoscape.LayoutOptions)
      .run();
  }

  private notifyState(): void {
    this.onStateChange?.({
      expanded: [...this.expanded],
      importsVisible: this.importsVisible,
      callsVisible: this.callsVisible,
    });
  }

  private buildStyle(): cytoscape.StylesheetStyle[] {
    const fg = themeColor('--vscode-foreground', '#ccc');
    const bg = themeColor('--vscode-editor-background', '#1e1e1e');
    const border = themeColor('--vscode-panel-border', '#555');
    const fileColor = themeColor('--vscode-charts-blue', '#4daafc');
    const classColor = themeColor('--vscode-charts-orange', '#e2a45e');
    const fnColor = themeColor('--vscode-charts-green', '#89d185');
    const methodColor = themeColor('--vscode-charts-purple', '#b180d7');
    const importColor = themeColor('--vscode-charts-foreground', '#8a8a8a');
    const hitColor = themeColor('--vscode-charts-yellow', '#e2c08d');

    const sizeByDegree = 'mapData(deg, 0, 10, 14, 46)';

    return [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          color: fg,
          'font-size': 10,
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 3,
          'text-wrap': 'ellipsis',
          'text-max-width': '140px',
          'text-outline-width': 2,
          'text-outline-color': bg,
          'text-outline-opacity': 0.9,
          'border-width': 0,
          width: sizeByDegree,
          height: sizeByDegree,
        },
      },
      { selector: 'node[type = "file"]', style: { shape: 'ellipse', 'background-color': fileColor } },
      { selector: 'node[type = "class"]', style: { shape: 'ellipse', 'background-color': classColor } },
      { selector: 'node[type = "function"]', style: { shape: 'ellipse', 'background-color': fnColor } },
      { selector: 'node[type = "method"]', style: { shape: 'ellipse', 'background-color': methodColor } },
      {
        selector: ':parent',
        style: {
          shape: 'round-rectangle',
          'background-opacity': 0.07,
          'background-color': fg,
          'border-width': 1,
          'border-color': border,
          'border-opacity': 0.4,
          'text-valign': 'top',
          'font-size': 11,
          'font-weight': 'bold',
          padding: '16px',
        },
      },
      {
        selector: 'edge',
        style: {
          width: 1,
          'line-color': importColor,
          'line-opacity': 0.5,
          'curve-style': 'bezier',
          'target-arrow-color': importColor,
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.7,
        },
      },
      {
        selector: 'edge[type = "calls"]',
        style: { 'line-color': '#e06c75', 'line-style': 'dashed', 'target-arrow-color': '#e06c75' },
      },
      { selector: '.dim', style: { opacity: 0.12 } },
      {
        selector: 'node.focus',
        style: { 'border-width': 2, 'border-color': fileColor, 'border-opacity': 1 },
      },
      {
        selector: 'edge.focus',
        style: { width: 2, 'line-opacity': 1, 'line-color': fileColor, 'target-arrow-color': fileColor },
      },
      {
        selector: 'node.selected',
        style: { 'border-width': 3, 'border-color': fileColor, 'border-opacity': 1 },
      },
      { selector: '.search-dim', style: { opacity: 0.08 } },
      {
        selector: 'node.search-hit',
        style: {
          'border-width': 3,
          'border-color': hitColor,
          'border-opacity': 1,
          'font-weight': 'bold',
          'z-index': 100,
        },
      },
    ];
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function pushEdge(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const arr = map.get(key);
  if (arr) {
    arr.push(edge);
  } else {
    map.set(key, [edge]);
  }
}
