// Best-effort (naive) call graph. Builds per-file symbol tables (name ->
// GraphNode.id) and matches call-expression names against them, scoping by
// same-file > imported > unique-global. This is a HINT, not ground truth:
// same-named symbols in different scopes, method dispatch through self/this,
// higher-order and dynamic dispatch are not resolved.
//
// Important: tree-sitter trees are freed after each file is processed, so the
// caller (enclosing definition) is resolved *while the tree is alive* — see
// enclosingDefId — and only plain data reaches resolve().

import { Node } from 'web-tree-sitter';
import { GraphEdge } from '../shared/types';
import { DefIndexEntry } from './NodeBuilder';
import { ImportResolver } from './ImportResolver';

export interface CallSite {
  callerId: string; // GraphNode.id of the enclosing def (or the file node)
  calleeName: string;
}

export interface CallFileData {
  fileRel: string;
  fileId: string;
  language: string;
  defIndex: DefIndexEntry[];
  callSites: CallSite[];
  importStatements: string[];
}

export class CallResolver {
  private files: CallFileData[] = [];

  constructor(private readonly importResolver: ImportResolver) {}

  /** Walk up from a call node to the nearest enclosing definition. */
  static enclosingDefId(callNode: Node, defNodeMap: Map<number, string>): string | null {
    let p = callNode.parent;
    while (p) {
      const id = defNodeMap.get(p.id);
      if (id) {
        return id;
      }
      p = p.parent;
    }
    return null;
  }

  addFile(data: CallFileData): void {
    this.files.push(data);
  }

  reset(): void {
    this.files = [];
  }

  resolve(knownRel: Set<string>): GraphEdge[] {
    const globalTable = new Map<string, string[]>(); // name -> ids (repo-wide)
    const perFileTable = new Map<string, Map<string, string[]>>(); // fileRel -> name -> ids

    for (const f of this.files) {
      const local = new Map<string, string[]>();
      for (const d of f.defIndex) {
        if (!d.name || d.type === 'file') {
          continue;
        }
        push(local, d.name, d.graphId);
        push(globalTable, d.name, d.graphId);
      }
      perFileTable.set(f.fileRel, local);
    }

    // name -> target file, per importing file (alias-aware).
    const importsByFile = new Map<string, Map<string, string>>();
    for (const f of this.files) {
      const m = new Map<string, string>();
      const resolved = this.importResolver.analyze(
        { importerRel: f.fileRel, language: f.language, statements: f.importStatements },
        knownRel
      );
      for (const r of resolved) {
        for (const name of r.names) {
          m.set(name, r.targetRel);
        }
      }
      importsByFile.set(f.fileRel, m);
    }

    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const f of this.files) {
      const local = perFileTable.get(f.fileRel)!;
      const imports = importsByFile.get(f.fileRel)!;
      for (const call of f.callSites) {
        const targetId = this.resolveCallee(call.calleeName, local, imports, perFileTable, globalTable);
        if (!targetId || targetId === call.callerId) {
          continue;
        }
        const id = `calls::${call.callerId}::${targetId}`;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        edges.push({ id, type: 'calls', sourceId: call.callerId, targetId });
      }
    }
    return edges;
  }

  private resolveCallee(
    name: string,
    local: Map<string, string[]>,
    imports: Map<string, string>,
    perFileTable: Map<string, Map<string, string[]>>,
    globalTable: Map<string, string[]>
  ): string | null {
    // 1. Same-file symbol.
    const here = local.get(name);
    if (here && here.length) {
      return here[0];
    }
    // 2. Imported symbol resolved in its source file.
    const targetRel = imports.get(name);
    if (targetRel) {
      const there = perFileTable.get(targetRel)?.get(name);
      if (there && there.length) {
        return there[0];
      }
    }
    // 3. Unique repo-wide symbol (skip if ambiguous to avoid false explosions).
    const global = globalTable.get(name);
    if (global && global.length === 1) {
      return global[0];
    }
    return null;
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) {
    arr.push(value);
  } else {
    map.set(key, [value]);
  }
}
