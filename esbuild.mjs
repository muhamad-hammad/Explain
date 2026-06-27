import esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const distDir = path.join(__dirname, 'dist');
const grammarsOut = path.join(distDir, 'grammars');

/** Files copied verbatim into dist/grammars at build time. */
const wasmCopies = [
  ['node_modules/web-tree-sitter/tree-sitter.wasm', 'tree-sitter.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm', 'tree-sitter-python.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm', 'tree-sitter-javascript.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm', 'tree-sitter-typescript.wasm'],
  ['node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm', 'tree-sitter-tsx.wasm'],
];

async function copyAssets() {
  await fs.mkdir(grammarsOut, { recursive: true });
  for (const [from, to] of wasmCopies) {
    await fs.copyFile(path.join(__dirname, from), path.join(grammarsOut, to));
  }
  // Tree-sitter query files are read at runtime; ship them next to the bundle.
  const queriesOut = path.join(distDir, 'queries');
  await fs.mkdir(queriesOut, { recursive: true });
  for (const f of await fs.readdir(path.join(__dirname, 'queries'))) {
    if (f.endsWith('.scm')) {
      await fs.copyFile(path.join(__dirname, 'queries', f), path.join(queriesOut, f));
    }
  }
  // Webview HTML shell template (placeholders filled by GraphPanel at runtime).
  await fs.copyFile(
    path.join(__dirname, 'webview', 'index.html'),
    path.join(distDir, 'webview.html')
  );
}

/** @type {import('esbuild').BuildOptions} */
const hostConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  // web-tree-sitter ships an emscripten cjs that relies on createRequire/dirname;
  // bundling breaks import.meta.url, so keep it external (resolved from the
  // packaged node_modules at runtime).
  external: ['vscode', 'web-tree-sitter'],
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview/index.ts'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
};

async function run() {
  await copyAssets();
  if (watch) {
    const hostCtx = await esbuild.context(hostConfig);
    const webviewCtx = await esbuild.context(webviewConfig);
    await Promise.all([hostCtx.watch(), webviewCtx.watch()]);
    console.log('[esbuild] watching host + webview...');
  } else {
    await Promise.all([esbuild.build(hostConfig), esbuild.build(webviewConfig)]);
    console.log('[esbuild] build complete.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
