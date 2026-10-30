import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withDependencyTypes } from './validation.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

it('links prepared node_modules beside the sources for the proof and removes them after', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-dependency-types-'));
  directories.push(root);
  const prepared = join(root, 'prepared');
  await mkdir(join(prepared, 'node_modules/stripe'), { recursive: true });
  await mkdir(join(prepared, 'packages/api/node_modules/zod'), { recursive: true });
  await writeFile(join(prepared, 'node_modules/stripe/index.d.ts'), 'export {};\n');
  await writeFile(join(prepared, 'packages/api/node_modules/zod/index.d.ts'), 'export {};\n');
  const archive = join(root, 'dependencies.tar');
  execFileSync('tar', [
    '-cf',
    archive,
    '-C',
    prepared,
    'node_modules',
    'packages/api/node_modules',
  ]);
  const sources = join(root, 'sources');
  await mkdir(join(sources, 'packages/api'), { recursive: true });

  const seen = await withDependencyTypes(root, sources, archive, () => [
    readFileSync(join(sources, 'node_modules/stripe/index.d.ts'), 'utf8'),
    existsSync(join(sources, 'packages/api/node_modules/zod/index.d.ts')),
  ]);
  expect(seen).toEqual(['export {};\n', true]);
  expect(existsSync(join(sources, 'node_modules'))).toBe(false);
  expect(existsSync(join(sources, 'packages/api/node_modules'))).toBe(false);
  // Without an archive the proof runs on the sources alone.
  expect(await withDependencyTypes(root, sources, undefined, () => 'ran')).toBe('ran');
});
