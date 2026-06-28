// Shared data schema imported by both the extension host and the webview.

export type NodeType = 'file' | 'class' | 'function' | 'method';
export type EdgeType = 'contains' | 'imports' | 'calls';

export interface LineRange {
  start: number; // 1-indexed
  end: number; // 1-indexed
}

export interface GraphNode {
  id: string; // stable, e.g. "file::src/foo.py" or "file::src/foo.py::MyClass@4::m@6"
  type: NodeType;
  label: string;
  filePath: string;
  lineRange: LineRange | null; // null for file nodes
  parentId: string | null; // null for file nodes
  language: string;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  sourceId: string;
  targetId: string;
  label?: string;
}

export interface RepoGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootPath: string;
  generatedAt: number;
}

export type ExtensionToWebviewMessage =
  | { type: 'graph'; payload: RepoGraph }
  | { type: 'error'; payload: string };

export type WebviewToExtensionMessage = { type: 'ready' } | { type: 'requestRefresh' };
