import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { RepoGraph } from '../shared/types';
import { LanguageRegistry } from '../parser/LanguageRegistry';
import { FileWalker } from '../parser/FileWalker';
import { GraphAssembler, SourceFile } from './GraphAssembler';

const QUERY_NAMES = ['python', 'javascript', 'typescript'] as const;

export class GraphBuilder {
  private readonly grammarsDir: string;
  private readonly queriesDir: string;
  private registry: LanguageRegistry;
  private querySources: Map<string, string> | null = null;

  constructor(extensionPath: string) {
    const base = path.join(extensionPath, 'dist');
    this.grammarsDir = path.join(base, 'grammars');
    this.queriesDir = path.join(base, 'queries');
    this.registry = new LanguageRegistry(this.grammarsDir);
  }

  /** @returns null when no workspace folder is open. */
  async build(): Promise<RepoGraph | null> {
    const walk = await FileWalker.walk();
    if (!walk) {
      return null;
    }
    const rootPath = walk.root.uri.fsPath;

    const sourceFiles = await this.readFiles(rootPath, walk.files);
    const querySources = await this.loadQueries();
    const assembler = new GraphAssembler(this.registry, querySources);
    await assembler.prime(sourceFiles);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Repo Graph: analyzing repository',
        cancellable: false,
      },
      async (progress) => {
        let lastPct = 0;
        return assembler.assemble(rootPath, sourceFiles, (done, total) => {
          const pct = Math.floor((done / total) * 100);
          if (pct > lastPct) {
            progress.report({ increment: pct - lastPct, message: `${done}/${total} files` });
            lastPct = pct;
          }
        });
      }
    );
  }

  private async readFiles(
    rootPath: string,
    files: { uri: vscode.Uri; key: SourceFile['key'] }[]
  ): Promise<SourceFile[]> {
    const out: SourceFile[] = [];
    for (const f of files) {
      try {
        const content = await fs.readFile(f.uri.fsPath, 'utf8');
        const relPath = path.relative(rootPath, f.uri.fsPath).split(path.sep).join('/');
        out.push({ absPath: f.uri.fsPath, relPath, key: f.key, content });
      } catch (err) {
        console.error(`[repo-graph] could not read ${f.uri.fsPath}:`, err);
      }
    }
    return out;
  }

  private async loadQueries(): Promise<Map<string, string>> {
    if (this.querySources) {
      return this.querySources;
    }
    const map = new Map<string, string>();
    for (const name of QUERY_NAMES) {
      const text = await fs.readFile(path.join(this.queriesDir, `${name}.scm`), 'utf8');
      map.set(name, text);
    }
    this.querySources = map;
    return map;
  }
}
