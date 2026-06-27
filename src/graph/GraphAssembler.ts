// Pure (vscode-free) orchestrator: parse files -> nodes/edges -> RepoGraph.
// Kept separate from GraphBuilder so the analysis pipeline can run headless.

import { Parser, Language } from 'web-tree-sitter';
import { RepoGraph, GraphNode, GraphEdge } from '../shared/types';
import {
  LanguageRegistry,
  GrammarKey,
  displayLanguage,
  queryNameForKey,
} from '../parser/LanguageRegistry';
import { QueryRunner } from '../parser/QueryRunner';
import { NodeBuilder } from './NodeBuilder';
import { EdgeBuilder } from './EdgeBuilder';
import { ImportResolver, ImportInput } from './ImportResolver';
import { CallResolver, CallSite } from './CallResolver';

export interface SourceFile {
  absPath: string;
  relPath: string; // '/'-separated, repo-root-relative
  key: GrammarKey;
  content: string;
}

export type ProgressFn = (done: number, total: number, label: string) => void;

export class GraphAssembler {
  private readonly queryRunner = new QueryRunner();
  private readonly nodeBuilder = new NodeBuilder();
  private readonly edgeBuilder = new EdgeBuilder();
  private readonly importResolver = new ImportResolver();
  private readonly callResolver = new CallResolver(this.importResolver);

  private readonly parsers = new Map<GrammarKey, Parser>();
  private readonly languages = new Map<GrammarKey, Language>();

  /**
   * @param registry initialized LanguageRegistry
   * @param querySources map of query name ('python'|'javascript'|'typescript') -> .scm text
   */
  constructor(
    private readonly registry: LanguageRegistry,
    private readonly querySources: Map<string, string>
  ) {}

  /** Pre-load every grammar used by `files`. Must be called before assemble(). */
  async prime(files: SourceFile[]): Promise<void> {
    const keys = new Set(files.map((f) => f.key));
    for (const key of keys) {
      this.parsers.set(key, await this.registry.getParser(key));
      this.languages.set(key, await this.registry.getLanguage(key));
    }
  }

  async assemble(
    rootPath: string,
    files: SourceFile[],
    onProgress?: ProgressFn,
    shouldYield = true
  ): Promise<RepoGraph> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const importInputs: ImportInput[] = [];
    const knownRel = new Set(files.map((f) => f.relPath));
    this.callResolver.reset();

    let done = 0;
    for (const file of files) {
      try {
        this.processFile(file, nodes, edges, importInputs);
      } catch (err) {
        // A single malformed file must not abort the whole graph.
        console.error(`[repo-graph] failed to parse ${file.relPath}:`, err);
      }
      done++;
      onProgress?.(done, files.length, file.relPath);
      // Yield to the event loop periodically so the UI thread never blocks.
      if (shouldYield && done % 25 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }

    edges.push(...this.importResolver.resolve(importInputs, knownRel));
    edges.push(...this.callResolver.resolve(knownRel));

    return { nodes, edges, rootPath, generatedAt: Date.now() };
  }

  private processFile(
    file: SourceFile,
    nodes: GraphNode[],
    edges: GraphEdge[],
    importInputs: ImportInput[]
  ): void {
    const parser = this.parsers.get(file.key);
    const language = this.languages.get(file.key);
    if (!parser || !language) {
      throw new Error(`grammar not primed for ${file.key}`);
    }

    const tree = parser.parse(file.content);
    if (!tree) {
      return;
    }
    try {
      const source = this.querySources.get(queryNameForKey(file.key));
      if (!source) {
        return;
      }
      const captures = this.queryRunner.run(tree, language, source, file.key);
      const lang = displayLanguage(file.key);
      const { fileNode, nodes: defNodes, defIndex } = this.nodeBuilder.build(
        { relPath: file.relPath, absPath: file.absPath, language: lang },
        captures
      );
      nodes.push(fileNode, ...defNodes);
      edges.push(...this.edgeBuilder.buildContains(defNodes));

      const statements = captures.filter((c) => c.kind === 'import').map((c) => c.text);
      if (statements.length) {
        importInputs.push({ importerRel: file.relPath, language: lang, statements });
      }

      // Resolve call callers now, while the tree (and its nodes) are alive.
      const defNodeMap = new Map<number, string>();
      for (const d of defIndex) {
        defNodeMap.set(d.tsNodeId, d.graphId);
      }
      const callSites: CallSite[] = [];
      for (const c of captures) {
        if (c.kind === 'call' && c.name) {
          callSites.push({
            callerId: CallResolver.enclosingDefId(c.node, defNodeMap) ?? fileNode.id,
            calleeName: c.name,
          });
        }
      }
      this.callResolver.addFile({
        fileRel: file.relPath,
        fileId: fileNode.id,
        language: lang,
        defIndex,
        callSites,
        importStatements: statements,
      });
    } finally {
      tree.delete();
    }
  }
}
