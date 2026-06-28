import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LanguageRegistry } from '../src/parser/LanguageRegistry';
import { GraphAssembler, SourceFile } from '../src/graph/GraphAssembler';
import { RepoGraph } from '../src/shared/types';

const projectRoot = process.env.PROJECT_ROOT!;
const grammarsDir = path.join(projectRoot, 'dist', 'grammars');
const queriesDir = path.join(projectRoot, 'queries');

const files: SourceFile[] = [
  {
    absPath: '/r/pkg/models.py',
    relPath: 'pkg/models.py',
    key: 'python',
    content: 'class User:\n    def greet(self):\n        return 1\n\ndef make_user():\n    return User()\n',
  },
  {
    absPath: '/r/pkg/service.py',
    relPath: 'pkg/service.py',
    key: 'python',
    content: 'from .models import make_user\n\ndef run():\n    return make_user()\n',
  },
];

async function build(): Promise<RepoGraph> {
  const registry = new LanguageRegistry(grammarsDir);
  const querySources = new Map<string, string>();
  for (const name of ['python', 'javascript', 'typescript']) {
    querySources.set(name, await fs.readFile(path.join(queriesDir, `${name}.scm`), 'utf8'));
  }
  const assembler = new GraphAssembler(registry, querySources);
  await assembler.prime(files);
  return assembler.assemble('/r', files, undefined, false);
}

test('compound: nodes, contains, imports and calls edges all assemble', async () => {
  const graph = await build();
  const byType = (t: string) => graph.nodes.filter((n) => n.type === t).map((n) => n.label);

  assert.deepEqual(byType('file').sort(), ['models.py', 'service.py']);
  assert.deepEqual(byType('class'), ['User']);
  assert.deepEqual(byType('method'), ['greet']); // greet nested in class -> method
  assert.deepEqual(byType('function').sort(), ['make_user', 'run']);

  const has = (type: string, src: RegExp, tgt: RegExp) =>
    graph.edges.some((e) => e.type === type && src.test(e.sourceId) && tgt.test(e.targetId));

  assert.ok(has('contains', /file::pkg\/models\.py$/, /User@1$/), 'file contains class');
  assert.ok(has('contains', /User@1$/, /greet@2$/), 'class contains method');
  assert.ok(has('imports', /service\.py$/, /models\.py$/), 'service imports models');
  assert.ok(has('calls', /service\.py::run@3$/, /models\.py::make_user@5$/), 'run -> make_user (imported)');
  assert.ok(has('calls', /make_user@5$/, /models\.py::User@1$/), 'make_user -> User (constructor)');
});

test('assemble runs twice without leaking calls state', async () => {
  const a = await build();
  const b = await build();
  assert.equal(
    a.edges.filter((e) => e.type === 'calls').length,
    b.edges.filter((e) => e.type === 'calls').length
  );
});
