# Repo Graph

Interactive, static-analysis graph of your repository's code structure for
VSCode. Parses Python and JavaScript/TypeScript via `web-tree-sitter` (WASM) and
renders file → class → function nesting plus `imports` edges in a Cytoscape
webview. No AI, no runtime instrumentation — pure static analysis.

At the **v3** milestone (Sprints 0–10):
file/class/function nodes + `contains`/`imports`/naive `calls` edges, drill-down
navigation (search, breadcrumb), persisted view state, lazy rendering, and a
packaged `.vsix`.

## Usage

1. Open a folder/workspace.
2. Run **Show Repo Graph** from the Command Palette (`repoGraph.showGraph`).
3. The graph opens collapsed to file-level nodes. Click a file (or class) node to
   expand its children. Use the toolbar to **Refresh**, **Expand all**,
   **Collapse all**, toggle **imports**/**calls** edges, or **search** by name.
   Clicking a node fills the **breadcrumb** bar (file ▸ class ▸ method); click a
   crumb to recenter on that ancestor. Search highlights matches, auto-expands to
   reveal them, and dims the rest. Hovering a node spotlights its neighborhood.
   Definition nodes are numbered per file in reading order (top-to-bottom by
   source line), so `1.`, `2.`, `3.` follow the order they appear in the code.
   Selecting a function, method, or class opens a source panel **beside** the
   graph (the canvas shrinks to make room rather than being overlapped) showing
   its exact lines, read on demand from disk.

## Develop

```sh
npm install
npm run build        # bundles host + webview into dist/
npm run watch        # rebuild on change
npm test             # component + compound tests (node:test, headless)
npm run pipeline-test # headless: parse a fixtures dir, dump the RepoGraph
npm run package      # build a .vsix
```

Press **F5** ("Run Extension") to launch an Extension Development Host, then run
the command in that window.

`pipeline-test` requires `FIXTURES_DIR` pointing at a directory of sample source
files; it bundles and runs the pure analysis pipeline without VSCode.

## Architecture

```
Extension Host (Node):  FileWalker → LanguageRegistry/QueryRunner →
                        NodeBuilder/EdgeBuilder/ImportResolver → GraphAssembler
                        → RepoGraph (JSON)
        postMessage ↓
Webview (browser):      GraphAdapter → CytoscapeManager (compound nesting,
                        collapse/expand, fcose force-directed layout)
```

- Containment is shown via Cytoscape **compound nesting** (the `parent` field),
  not as drawn edges. `imports` edges are drawn solid with an arrow.
- The pure pipeline (`src/parser/*`, `src/graph/*` except `GraphBuilder`/`FileWalker`)
  has no vscode dependency, so it runs headless in `pipeline-test`.

## Known limitations (v1)

- **Import resolution is best-effort.** Barrel files, re-exports, dynamic
  `import()`, and some `__init__.py` package imports may not resolve and are
  silently skipped. Only straightforward static paths are handled.
- **`calls` edges are a naive hint, not a call graph (v2).** Callee names are
  matched against repo symbols with scope priority same-file > imported >
  unique-global. It misses method dispatch through `self`/`this` (e.g.
  `obj.method()` may resolve to a same-named free function), higher-order and
  dynamic calls, and can match same-named symbols in unrelated scopes. Ambiguous
  names with no same-file/imported match are skipped. Toggle them with the
  **calls** checkbox (off by default); hover the ⓘ for the caveat.
- **First workspace folder only.** Multi-root workspaces use `workspaceFolders[0]`.
- **Large repos:** parsing yields to the event loop in chunks and shows a
  progress notification, but the whole graph is built up front. Progressive
  loading is v3.

## Tech

`web-tree-sitter` 0.25 · `tree-sitter-wasms` grammars (python/javascript/typescript/tsx) ·
`cytoscape` 3 + `cytoscape-fcose` (force-directed layout) · `esbuild` (dual host + webview bundle).
