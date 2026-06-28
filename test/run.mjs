// Bundles the test suite (which imports the pure pipeline modules) and runs it
// under node's built-in test runner. web-tree-sitter stays external so its
// emscripten cjs loads from node_modules at runtime.

import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outFile = path.join(projectRoot, 'dist', 'tests.cjs');

await esbuild.build({
  entryPoints: [path.join(__dirname, 'index.test.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['web-tree-sitter', 'node:test'],
});

const res = spawnSync(process.execPath, [outFile], {
  stdio: 'inherit',
  env: { ...process.env, PROJECT_ROOT: projectRoot },
});
process.exit(res.status ?? 1);
