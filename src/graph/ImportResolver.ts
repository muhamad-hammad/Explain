// Resolves import statements to repo-local files. Emits file->file 'imports'
// edges and (via analyze) exposes the imported symbol names per target so
// CallResolver can scope cross-file calls. Best-effort static resolution only:
// barrel files, re-exports, dynamic import(), namespace imports, and some
// __init__.py package imports may not resolve and are silently skipped.

import { GraphEdge } from '../shared/types';

export interface ImportInput {
  importerRel: string; // '/'-separated, repo-root-relative
  language: string; // 'python' | 'javascript' | 'typescript'
  statements: string[]; // raw text of each import statement node
}

/** A resolved import: the target file and the local symbol names it binds. */
export interface ResolvedImport {
  targetRel: string;
  names: string[]; // local binding names (alias-aware where possible)
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const JS_INDEX = JS_EXTS.map((e) => `/index${e}`);

export class ImportResolver {
  /** file->file 'imports' edges for the whole repo. */
  resolve(imports: ImportInput[], knownRel: Set<string>): GraphEdge[] {
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];

    for (const imp of imports) {
      for (const { targetRel } of this.analyze(imp, knownRel)) {
        const id = `imports::${imp.importerRel}::${targetRel}`;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        edges.push({
          id,
          type: 'imports',
          sourceId: `file::${imp.importerRel}`,
          targetId: `file::${targetRel}`,
        });
      }
    }
    return edges;
  }

  /** Resolve every statement of one file to {targetRel, names}. */
  analyze(imp: ImportInput, knownRel: Set<string>): ResolvedImport[] {
    const out: ResolvedImport[] = [];
    for (const stmt of imp.statements) {
      const resolved =
        imp.language === 'python'
          ? this.resolvePython(stmt, imp.importerRel, knownRel)
          : this.resolveJs(stmt, imp.importerRel, knownRel);
      for (const r of resolved) {
        if (r.targetRel !== imp.importerRel) {
          out.push(r);
        }
      }
    }
    return out;
  }

  // ---- JavaScript / TypeScript ----------------------------------------

  private resolveJs(stmt: string, importerRel: string, knownRel: Set<string>): ResolvedImport[] {
    const out: ResolvedImport[] = [];

    const fromMatch = stmt.match(/from\s*['"]([^'"]+)['"]/);
    if (fromMatch) {
      const target = this.resolveJsSpec(fromMatch[1], importerRel, knownRel);
      if (target) {
        out.push({ targetRel: target, names: parseJsNames(stmt) });
      }
    } else {
      const sideEffect = stmt.match(/^\s*import\s*['"]([^'"]+)['"]/);
      if (sideEffect) {
        const target = this.resolveJsSpec(sideEffect[1], importerRel, knownRel);
        if (target) {
          out.push({ targetRel: target, names: [] });
        }
      }
    }
    return out;
  }

  private resolveJsSpec(spec: string, importerRel: string, knownRel: Set<string>): string | null {
    if (!spec.startsWith('.')) {
      return null; // external / bare module
    }
    const base = joinRel(dirOf(importerRel), spec);
    return this.firstKnown(
      [base, ...JS_EXTS.map((e) => base + e), ...JS_INDEX.map((i) => base + i)],
      knownRel
    );
  }

  // ---- Python ----------------------------------------------------------

  private resolvePython(stmt: string, importerRel: string, knownRel: Set<string>): ResolvedImport[] {
    const trimmed = stmt.trim();

    // from [.]*module import a, b as c
    const fromMatch = trimmed.match(/^from\s+(\.*)([\w.]*)\s+import\b(.*)$/s);
    if (fromMatch) {
      const dots = fromMatch[1].length;
      const target = this.pythonModuleTarget(dots, fromMatch[2], importerRel, knownRel);
      if (!target) {
        return [];
      }
      return [{ targetRel: target, names: parsePyNames(fromMatch[3]) }];
    }

    // import a.b.c [as x][, d.e ...]  (module objects; no symbol binding tracked)
    const importMatch = trimmed.match(/^import\s+(.+)$/);
    if (importMatch) {
      const out: ResolvedImport[] = [];
      for (const part of importMatch[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0].trim();
        if (!mod) {
          continue;
        }
        const target = this.pythonModuleTarget(0, mod, importerRel, knownRel);
        if (target) {
          out.push({ targetRel: target, names: [] });
        }
      }
      return out;
    }
    return [];
  }

  private pythonModuleTarget(
    dots: number,
    modulePath: string,
    importerRel: string,
    knownRel: Set<string>
  ): string | null {
    let baseDir: string;
    if (dots > 0) {
      let dir = dirOf(importerRel);
      for (let i = 0; i < dots - 1; i++) {
        dir = parentDir(dir);
      }
      baseDir = dir;
    } else {
      baseDir = '';
    }

    const segments = modulePath ? modulePath.split('.') : [];
    const base = segments.length ? joinRel(baseDir, segments.join('/')) : baseDir;

    return this.firstKnown(
      [`${base}.py`, base ? `${base}/__init__.py` : '__init__.py'],
      knownRel
    );
  }

  private firstKnown(candidates: string[], knownRel: Set<string>): string | null {
    for (const c of candidates) {
      const norm = normalizeRel(c);
      if (knownRel.has(norm)) {
        return norm;
      }
    }
    return null;
  }
}

// ---- symbol-name parsing --------------------------------------------------

/** Local binding names from a JS/TS import statement (alias-aware). */
function parseJsNames(stmt: string): string[] {
  const clause = stmt.slice(stmt.indexOf('import') + 'import'.length);
  const head = clause.split(/\sfrom\s/)[0];
  if (/\*\s*as\s/.test(head)) {
    return []; // namespace import — not tracked
  }
  const names: string[] = [];

  const braces = head.match(/\{([^}]*)\}/);
  if (braces) {
    for (const raw of braces[1].split(',')) {
      const name = localName(raw);
      if (name) {
        names.push(name);
      }
    }
  }

  // Default import: leading identifier before any '{' or ','.
  const defaultMatch = head.match(/^\s*([A-Za-z_$][\w$]*)/);
  if (defaultMatch && !head.trimStart().startsWith('{')) {
    names.push(defaultMatch[1]);
  }
  return names;
}

/** Local binding names from a Python `from ... import <this>` tail. */
function parsePyNames(tail: string): string[] {
  const cleaned = tail.replace(/[()]/g, '').trim();
  if (cleaned === '*') {
    return [];
  }
  const names: string[] = [];
  for (const raw of cleaned.split(',')) {
    const name = localName(raw);
    if (name && name !== '*') {
      names.push(name);
    }
  }
  return names;
}

/** Given "A" or "A as B", return the local binding name (B, else A). */
function localName(raw: string): string | null {
  const parts = raw.trim().split(/\s+as\s+/);
  const name = (parts[1] ?? parts[0]).trim();
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

// ---- path helpers (operate on '/'-separated repo-relative paths) ----------

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function parentDir(dir: string): string {
  const i = dir.lastIndexOf('/');
  return i === -1 ? '' : dir.slice(0, i);
}

function joinRel(dir: string, rest: string): string {
  return normalizeRel(dir ? `${dir}/${rest}` : rest);
}

/** Collapse '.', '..', and duplicate slashes in a '/'-separated path. */
function normalizeRel(rel: string): string {
  const stack: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  return stack.join('/');
}
