import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  COMMIT_STAMP,
  checkoutError,
  classifyRow,
  finishedRow,
  openResultsFile,
  openRunDirectory,
  refitRevision,
  resumeMismatches,
  startRun,
  type Harness,
} from '../scripts/benchmark-harness.mjs';
import { validate, loadSchemas } from '../scripts/benchmark-results.mjs';

const execute = promisify(execFile);
const roots: string[] = [];

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-harness-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await directory();
  const git = (...args: string[]) => execute('git', ['-C', root, ...args]);
  await git('init', '-q');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await git('add', '-A');
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
  return { root, commit: (await git('rev-parse', 'HEAD')).stdout.trim(), git };
}

const harness = (overrides: Partial<Harness> = {}): Harness => ({
  formatVersion: 1,
  format: 'stripe-results',
  refit: { commit: 'a'.repeat(40), source: 'git', dirty: null, allowDirty: false },
  list: { path: 'selected.json', sha256: 'b'.repeat(64) },
  options: { validate: true },
  node: 'v22.12.0',
  docker: null,
  startedAt: '2026-10-22T08:00:00.000Z',
  ...overrides,
});

it('records the commit of a clean checkout and refuses tracked changes unless allowed', async () => {
  const { root, commit } = await repository({ 'a.txt': 'one\n' });
  expect(await refitRevision(root)).toEqual({
    commit,
    source: 'git',
    dirty: null,
    allowDirty: false,
  });
  // Untracked files do not change what committed code does, as in `git describe --dirty`.
  await writeFile(join(root, 'notes.txt'), 'scratch');
  expect((await refitRevision(root)).dirty).toBeNull();

  await writeFile(join(root, 'a.txt'), 'two\n');
  await expect(refitRevision(root)).rejects.toThrow(
    `Refusing to benchmark a dirty tree: 1 tracked file(s) differ from ${commit.slice(0, 12)} (a.txt). Commit them, or pass --allow-dirty to record the run as dirty.`,
  );
  const { stdout: diff } = await execute('git', ['-C', root, 'diff', 'HEAD', '--binary']);
  expect(await refitRevision(root, { allowDirty: true })).toEqual({
    commit,
    source: 'git',
    dirty: { files: ['a.txt'], sha256: createHash('sha256').update(diff).digest('hex') },
    allowDirty: true,
  });
});

it('reads the commit git archive stamps into an exported tree, and refuses an unknown tree', async () => {
  // The same attribute and placeholder this repository commits.
  const { root, commit } = await repository({
    '.gitattributes': await readFile('.gitattributes', 'utf8'),
    [COMMIT_STAMP]: await readFile(COMMIT_STAMP, 'utf8'),
  });
  const exported = await directory();
  await execute('sh', ['-c', `git -C "${root}" archive HEAD | tar -x -C "${exported}"`]);
  expect(await refitRevision(exported)).toEqual({
    commit,
    source: 'archive',
    dirty: null,
    allowDirty: false,
  });

  const plain = await directory();
  await expect(refitRevision(plain)).rejects.toThrow(
    `Cannot tell which Refit commit ${plain} is: it is not a git checkout, and ${COMMIT_STAMP} was not stamped by git archive.`,
  );
  expect(await refitRevision(plain, { allowDirty: true })).toEqual({
    commit: null,
    source: 'unknown',
    dirty: null,
    allowDirty: true,
  });
});

it('writes a harness record that the schema accepts, with only outcome-changing options', async () => {
  const { root } = await repository({ 'a.txt': 'one\n' });
  const list = join(root, 'list.json');
  await writeFile(list, '{"repos":[]}\n');
  const previous = process.env.REFIT_VALIDATION_WORKSPACE;
  process.env.REFIT_VALIDATION_WORKSPACE = '4g';
  try {
    const record = await startRun({
      format: 'ai-model-results',
      refitRoot: root,
      list: { path: 'docs/list.json', file: list },
      options: { offset: '5', ai: false, limit: undefined, concurrency: '2' },
      environment: ['REFIT_VALIDATION_WORKSPACE', 'REFIT_DEPENDENCY_TIMEOUT_SECONDS'],
    });
    expect(record).toMatchObject({
      format: 'ai-model-results',
      list: {
        path: 'docs/list.json',
        sha256: createHash('sha256').update('{"repos":[]}\n').digest('hex'),
      },
      options: { concurrency: '2', environment: { REFIT_VALIDATION_WORKSPACE: '4g' }, offset: '5' },
      node: process.version,
      docker: null,
    });
    expect(Object.keys(record.options)).toEqual(['concurrency', 'environment', 'offset']);
    expect(validate(loadSchemas(), 'harness', record)).toEqual({ errors: [], predates: [] });
  } finally {
    if (previous === undefined) delete process.env.REFIT_VALIDATION_WORKSPACE;
    else process.env.REFIT_VALIDATION_WORKSPACE = previous;
  }
});

it('tells a checkout at the pinned commit from a missing, empty or moved one', async () => {
  const { root, commit, git } = await repository({ 'a.txt': 'one\n' });
  expect(await checkoutError(root, commit)).toBeUndefined();
  expect(await checkoutError(join(root, 'missing'), commit)).toBe(
    `no checkout at ${join(root, 'missing')}`,
  );
  const empty = await directory();
  await execute('git', ['-C', empty, 'init', '-q']);
  expect(await checkoutError(empty, commit)).toBe(
    'the directory is not a checkout with a commit of its own (the fetch failed)',
  );
  // A directory inside another checkout is not that repository's checkout.
  await mkdir(join(root, 'nested'));
  expect(await checkoutError(join(root, 'nested'), commit)).toBe(
    'the directory is not a checkout with a commit of its own (the fetch failed)',
  );
  await writeFile(join(root, 'a.txt'), 'two\n');
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'next');
  const moved = (await git('rev-parse', 'HEAD')).stdout.trim();
  expect(await checkoutError(root, commit)).toBe(
    `the checkout is at ${moved}, not the pinned ${commit}`,
  );
});

it('classifies infrastructure errors from the fields rows already have', () => {
  const workflow = (fields: Record<string, string>) =>
    classifyRow('stripe-results', { repo: 'a/b', workflow: { status: 'error', ...fields } });
  expect(classifyRow('stripe-results', { workflow: { status: 'missing-manifest' } })).toEqual({
    outcomeClass: 'infrastructure',
    infrastructure: {
      kind: 'no-manifest',
      message:
        'The workflow wrote no manifest: the harness time limit killed it, or it crashed, so it has no outcome.',
    },
  });
  expect(
    workflow({
      error:
        'docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    }),
  ).toMatchObject({ infrastructure: { kind: 'docker' } });
  expect(
    workflow({
      error:
        'npm dependency preparation failed (1). REFIT_NODE_VERSION=v22.23.3\nnpm error code EAI_AGAIN\nnpm error request to https://registry.npmjs.org/stripe failed',
    }),
  ).toEqual({
    outcomeClass: 'infrastructure',
    infrastructure: { kind: 'registry', message: 'npm error code EAI_AGAIN' },
  });
  expect(
    workflow({
      error:
        'Dependency preparation exceeded 300 seconds. Set REFIT_DEPENDENCY_TIMEOUT_SECONDS (up to 1800) for a larger dependency tree.',
    }),
  ).toMatchObject({ infrastructure: { kind: 'registry' } });
  // Failures the repository causes stay repository results.
  for (const error of [
    'npm dependency preparation failed (1). npm error code ERESOLVE\nnpm error ERESOLVE could not resolve',
    'package.json dependencies differ from the committed package-lock.json: next is "15.3.6"',
    'stdout maxBuffer length exceeded',
    'Validation does not accept tracked symbolic links or submodules.',
    // From a real run: the tree filled the workspace; Yarn's retry notice is not the cause.
    'yarn dependency preparation failed (1). \nerror Error: ENOSPC: no space left on device, write\nerror https://registry.yarnpkg.com/@esbuild/linux-x64/-/linux-x64-0.25.12.tgz: ENOSPC: no space left on device, write\ninfo There appears to be trouble with your network connection. Retrying...',
  ])
    expect(workflow({ error })).toEqual({ outcomeClass: 'repository' });
  expect(
    classifyRow('stripe-results', {
      read: 'PipelineInputError: Repository exceeds scan limits (10,000 files, 2 MiB per file, 50 MiB total).',
    }),
  ).toEqual({ outcomeClass: 'repository' });
  expect(
    classifyRow('stripe-results', {
      read: "ENOENT: no such file or directory, realpath '/work/root/repos/a__b'",
    }),
  ).toMatchObject({ infrastructure: { kind: 'clone' } });
  expect(
    classifyRow('ai-model-results', { error: 'checkout: Command failed: git fetch' }),
  ).toMatchObject({ infrastructure: { kind: 'clone' } });
  expect(classifyRow('ai-model-results', { error: 'timed out after 120 s' })).toEqual({
    outcomeClass: 'repository',
  });
  const marked = { kind: 'clone', message: 'the checkout is at 1, not the pinned 2' };
  expect(classifyRow('shopify-results', { infrastructure: marked })).toEqual({
    outcomeClass: 'infrastructure',
    infrastructure: marked,
  });
});

it('resumes only the same run: commit, uncommitted changes, list and options', () => {
  expect(resumeMismatches(harness(), harness({ startedAt: '2026-10-23T00:00:00.000Z' }))).toEqual(
    [],
  );
  expect(
    resumeMismatches(
      harness(),
      harness({
        refit: {
          commit: 'c'.repeat(40),
          source: 'git',
          dirty: { files: ['x.ts'], sha256: 'd'.repeat(64) },
          allowDirty: true,
        },
        list: { path: 'selected.json', sha256: 'e'.repeat(64) },
        options: { validate: true, limit: '2' },
      }),
    ),
  ).toEqual(['Refit commit', 'uncommitted changes', 'list', 'options']);
  const unknown = { commit: null, source: 'unknown' as const, dirty: null, allowDirty: true };
  expect(resumeMismatches(harness({ refit: unknown }), harness({ refit: unknown }))).toEqual([
    'unknown Refit commit',
  ]);
  const row = { repo: 'a/b', commit: 'f'.repeat(40) };
  expect(finishedRow({ ...row, outcomeClass: 'repository' }, row)).toBe(true);
  expect(finishedRow({ ...row, outcomeClass: 'infrastructure' }, row)).toBe(false);
  expect(finishedRow({ ...row }, row)).toBe(false);
  expect(finishedRow(null, row)).toBe(false);
  expect(finishedRow({ ...row, commit: 'e'.repeat(40), outcomeClass: 'repository' }, row)).toBe(
    false,
  );
});

it('opens a run directory once, and resumes it only for the same run', async () => {
  const output = join(await directory(), 'run');
  expect(await openRunDirectory(output, harness())).toEqual({ harness: harness(), rows: [] });
  expect(JSON.parse(await readFile(join(output, 'harness.json'), 'utf8'))).toEqual(harness());
  await expect(openRunDirectory(output, harness())).rejects.toThrow('EEXIST');

  const rows = [{ repo: 'a/b', commit: 'f'.repeat(40), outcomeClass: 'repository' }, null];
  await writeFile(join(output, 'results.json'), JSON.stringify(rows));
  const later = harness({ startedAt: '2026-10-22T09:00:00.000Z', node: 'v22.13.0' });
  const resumed = await openRunDirectory(output, later, { resume: true });
  expect(resumed.rows).toEqual(rows);
  expect(resumed.harness.startedAt).toBe('2026-10-22T08:00:00.000Z');
  expect(resumed.harness.resumes).toEqual([
    { startedAt: '2026-10-22T09:00:00.000Z', node: 'v22.13.0', docker: null },
  ]);
  expect(JSON.parse(await readFile(join(output, 'harness.json'), 'utf8'))).toEqual(resumed.harness);
  await expect(
    openRunDirectory(output, harness({ options: { validate: false } }), { resume: true }),
  ).rejects.toThrow(
    `Refusing to resume ${output}: options differ from the run it started. Use a new output.`,
  );
  // Resuming a directory that does not exist yet starts it.
  const fresh = join(await directory(), 'new');
  expect((await openRunDirectory(fresh, harness(), { resume: true })).rows).toEqual([]);
});

it('resumes a results file only when it holds the same run', async () => {
  const path = join(await directory(), 'results.json');
  expect(await openResultsFile(path, harness(), { resume: true })).toEqual({
    harness: harness(),
    rows: [],
  });
  await writeFile(path, JSON.stringify({ harness: harness(), results: [{ repo: 'a/b' }] }));
  expect((await openResultsFile(path, harness())).rows).toEqual([]);
  expect((await openResultsFile(path, harness(), { resume: true })).rows).toEqual([
    { repo: 'a/b' },
  ]);
  await writeFile(path, JSON.stringify([{ repo: 'a/b' }]));
  await expect(openResultsFile(path, harness(), { resume: true })).rejects.toThrow(
    `Cannot resume ${path}: it has no harness record.`,
  );
});

it('keeps the commit placeholder that git archive fills in', async () => {
  expect(await readFile(COMMIT_STAMP, 'utf8')).toBe('$Format:%H$\n');
  expect(await readFile('.gitattributes', 'utf8')).toContain(`${COMMIT_STAMP} export-subst`);
});
