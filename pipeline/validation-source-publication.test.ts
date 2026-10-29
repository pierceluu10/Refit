import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { validateSourcePatch } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const MANIFEST = `{
  "name": "test-mate",
  "scripts": { "test": "jest" },
  "dependencies": {
    "openai": "^4.20.1"
  }
}
`;
const LOCKFILE = `{
  "name": "test-mate",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "dependencies": {
        "openai": "^4.20.1"
      }
    }
  }
}
`;

// A committed repository and a docker stub whose checks all pass; only publication is under test.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'refit-source-publication-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const binary = join(root, 'bin');
  await mkdir(join(repository, 'src'), { recursive: true });
  await mkdir(binary);
  await writeFile(join(repository, 'package.json'), MANIFEST);
  await writeFile(join(repository, 'package-lock.json'), LOCKFILE);
  await writeFile(join(repository, 'src', 'ai.js'), 'module.exports = 1;\n');
  await writeFile(join(repository, 'README.md'), '# test-mate\n');
  await execute('git', ['init', '-q', repository]);
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'test: seed',
  ]);
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? 'sha256:${'a'.repeat(64)}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
process.exit(0);
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  return repository;
}

// The diff git writes for the given edits to the committed files.
async function patch(repository: string, edits: Record<string, (content: string) => string>) {
  for (const [path, edit] of Object.entries(edits))
    await writeFile(join(repository, path), edit(await readFile(join(repository, path), 'utf8')));
  const { stdout } = await execute('git', ['-C', repository, 'diff']);
  await execute('git', ['-C', repository, 'checkout', '-q', '.']);
  return stdout;
}

const upgrade = (content: string) => content.replace('"^4.20.1"', '"^6.49.0"');

const validate = (repository: string, diff: string) =>
  validateSourcePatch({
    repository,
    propose: async () => diff,
    image: 'node:22-alpine',
    command: ['npm', 'test'],
  });

// gaurangpb/test-mate (openai-dev-30) at 52f5617: the openai 6 upgrade moves only the package, and
// validation threw "changes no committed source file" because package files were not counted.
it('publishes an SDK upgrade that changes only package.json and the lockfile', async () => {
  const repository = await fixture();
  const diff = await patch(repository, { 'package.json': upgrade, 'package-lock.json': upgrade });
  const result = await validate(repository, diff);
  expect(result.status).toBe('passed');
  expect('publicationFiles' in result && result.publicationFiles).toEqual([
    { path: 'package.json', mode: '100644', content: upgrade(MANIFEST) },
    { path: 'package-lock.json', mode: '100644', content: upgrade(LOCKFILE) },
  ]);
});

it('publishes the package move together with the call edits', async () => {
  const repository = await fixture();
  const diff = await patch(repository, {
    'package.json': upgrade,
    'package-lock.json': upgrade,
    'src/ai.js': (content) => content.replace('1', '2'),
  });
  const result = await validate(repository, diff);
  expect('publicationFiles' in result && result.publicationFiles.map((file) => file.path)).toEqual([
    'src/ai.js',
    'package.json',
    'package-lock.json',
  ]);
});

it('stops a patch that changes a file Refit does not publish, naming it', async () => {
  const repository = await fixture();
  const diff = await patch(repository, {
    'src/ai.js': (content) => content.replace('1', '2'),
    'README.md': (content) => `${content}More.\n`,
  });
  await expect(validate(repository, diff)).rejects.toThrow(
    'The proposed patch changes README.md, which is not a committed source, package.json or lockfile at the repository root that Refit publishes.',
  );
});
