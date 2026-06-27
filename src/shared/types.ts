// Shared data schema imported by both the extension host and the webview.

export type NodeType = 'file' | 'class' | 'function' | 'method';
export type EdgeType = 'contains' | 'imports' | 'calls';

export interface LineRange {
  start: number; // 1-indexed
  end: number; // 1-indexed
}

export interface GraphNode {
  id: string; // Stable unique ID: e.g. "file::src/foo.py", "fn::src/foo.py::MyClass::my_method"
  type: NodeType;
  label: string; // Display name: filename, class name, function name
  filePath: string; // Absolute path to the source file
  lineRange: LineRange | null; // null for file nodes (whole file)
  parentId: string | null; // ID of the containing node (null for file nodes)
  language: string; // 'python' | 'javascript' | 'typescript'
  collapsed: boolean; // UI state: whether children are hidden (true by default for file nodes)
}

export interface GraphEdge {
  id: string; // e.g. "contains::src/foo.py::src/foo.py::MyClass"
  type: EdgeType;
  sourceId: string; // ID of the source GraphNode
  targetId: string; // ID of the target GraphNode
  label?: string; // Optional display label (e.g. import alias)
}

export interface RepoGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootPath: string; // Absolute path to workspace root
  generatedAt: number; // Unix timestamp (ms)
}

// Message types for extension-host <-> webview postMessage protocol
export type ExtensionToWebviewMessage =
  | { type: 'graph'; payload: RepoGraph }
  | { type: 'error'; payload: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'requestRefresh' }
  | { type: 'nodeExpand'; nodeId: string }
  | { type: 'nodeCollapse'; nodeId: string };
