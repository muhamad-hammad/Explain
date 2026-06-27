// Converts tree-sitter captures for one file into GraphNode[] with stable IDs
// and parentId derived from AST nesting.

import * as path from 'node:path';
import { GraphNode, NodeType } from '../shared/types';
import { Capture } from '../parser/QueryRunner';

export interface FileInput {
  relPath: string; // repo-root-relative, '/'-separated
  absPath: string;
  language: string; // display language ('python' | 'javascript' | 'typescript')
}

/** A resolved definition, keyed by its tree-sitter node id, for call resolution. */
export interface DefIndexEntry {
  tsNodeId: number; // tree-sitter Node.id of the definition node
  graphId: string; // GraphNode.id
  name: string | null;
  type: NodeType;
}

export interface FileNodes {
  fileNode: GraphNode;
  nodes: GraphNode[]; // definitions only (excludes the file node)
  defIndex: DefIndexEntry[]; // for CallResolver (caller lookup + symbol table)
}

export class NodeBuilder {
  build(file: FileInput, captures: Capture[]): FileNodes {
    const fileId = `file::${file.relPath}`;
    const fileNode: GraphNode = {
      id: fileId,
      type: 'file',
      label: path.basename(file.relPath),
      filePath: file.absPath,
      lineRange: null,
      parentId: null,
      language: file.language,
      collapsed: true,
    };

    const defs = captures.filter(
      (c) => c.kind === 'function' || c.kind === 'class' || c.kind === 'method'
    );

    // Map tree-sitter node id -> capture, to resolve nesting.
    const byNodeId = new Map<number, Capture>();
    for (const c of defs) {
      byNodeId.set(c.node.id, c);
    }

    const parentCaptureOf = (c: Capture): Capture | null => {
      let p = c.node.parent;
      while (p) {
        const found = byNodeId.get(p.id);
        if (found) {
          return found;
        }
        p = p.parent;
      }
      return null;
    };

    // Compute stable, unique IDs (recursive on the nesting chain).
    const idCache = new Map<Capture, string>();
    const idOf = (c: Capture): string => {
      const cached = idCache.get(c);
      if (cached) {
        return cached;
      }
      const parent = parentCaptureOf(c);
      const prefix = parent ? idOf(parent) : fileId;
      const id = `${prefix}::${c.name ?? 'anon'}@${c.startLine}`;
      idCache.set(c, id);
      return id;
    };

    const nodes: GraphNode[] = [];
    const defIndex: DefIndexEntry[] = [];
    for (const c of defs) {
      const parent = parentCaptureOf(c);
      const parentId = parent ? idOf(parent) : fileId;

      let type: NodeType = c.kind as NodeType; // 'function' | 'class' | 'method'
      // A function defined directly inside a class is a method (handles Python,
      // where methods are plain function_definition nodes).
      if (type === 'function' && parent && parent.kind === 'class') {
        type = 'method';
      }

      const id = idOf(c);
      nodes.push({
        id,
        type,
        label: c.name ?? '(anonymous)',
        filePath: file.absPath,
        lineRange: { start: c.startLine, end: c.endLine },
        parentId,
        language: file.language,
        collapsed: true,
      });
      defIndex.push({ tsNodeId: c.node.id, graphId: id, name: c.name, type });
    }

    return { fileNode, nodes, defIndex };
  }
}
