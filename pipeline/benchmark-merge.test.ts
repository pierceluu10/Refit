import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { classifyRow } from '../scripts/benchmark-harness.mjs';
import { summaryTable } from './stripe-benchmark.ts';

// scripts/benchmark-merge.mjs on shard directories laid out as `gh run download -p 'shard-*'`
// leaves them, compared with what the refit-bench merge job's inline jq and coreutils steps write.
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Two repositories of docs/benchmarks/subsets/l2-push-249.json at their pinned commits.
const ODOTA = { repo: 'odota/core', commit: 'b877fd1c169c84e4dfc2651a3f2fcdd68b5fef08' };
const KANBA = { repo: 'Kanba-co/kanba', commit: 'd5dfe822a503dcf87e14e687e4a13a0baffc9fe3' };
const MISSING = { repo: 'acme/missing', commit: 'c'.repeat(40) };
const IMAGES = [
  `stripe/stripe-mock@sha256:${'b'.repeat(64)}`,
  `node@sha256:${'a'.repeat(64)}`,
].join('\n');

const row = (entry: { repo: string; commit: string }, fields: Record<string, unknown> = {}) => {
  const value = {
    ...entry,
    read: 'ok',
    mappedMethods: 2,
    fullAdapter: { status: 'affected', confirmed: 1, review: 0, findings: [] },
    ...fields,
  };
  return { ...value, ...classifyRow('stripe-results', value) };
};

// A git repository holding the list at a commit; the script reads lists with git show.
async function setup(shards: Record<string, unknown[]>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-merge-test-'));
  roots.push(root);
  const git = (...args: string[]) => execute('git', ['-C', root, ...args]);
  await mkdir(join(root, 'docs/benchmarks/subsets'), { recursive: true });
  await writeFile(
    join(root, 'docs/benchmarks/subsets/merge.json'),
    JSON.stringify({ repos: [ODOTA, KANBA, MISSING] }),
  );
  await git('init', '-q');
  await git('add', '-A');
  await git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'list');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  for (const [name, rows] of Object.entries(shards)) {
    await mkdir(join(root, 'shards', name, 'run'), { recursive: true });
    await writeFile(join(root, 'shards', name, 'run', 'results.json'), JSON.stringify(rows));
    await writeFile(join(root, 'shards', name, 'images.txt'), `${IMAGES}\n`);
  }
  const merge = async (...extra: string[]) => {
    await execute(
      process.execPath,
      [
        'scripts/benchmark-merge.mjs',
        '--shards',
        join(root, 'shards'),
        '--list',
        'subsets/merge.json',
        '--commit',
        commit,
        '--output',
        join(root, 'merged'),
        ...extra,
      ],
      // The script runs git in its own checkout; GIT_DIR points it at the fixture's history.
      { env: { ...process.env, GIT_DIR: join(root, '.git') } },
    );
    const read = (name: string) => readFile(join(root, 'merged', name), 'utf8');
    return { read, commit };
  };
  return merge;
}

it('writes the merged files the workflow writes, listing missing, unexpected and duplicated repositories', async () => {
  const odota = row(ODOTA, { workflow: { status: 'validated', aiCostUsd: 0.5 } });
  const kanba = row(KANBA, { workflow: { status: 'needs-review' } });
  const stray = row({ repo: 'acme/stray', commit: 'd'.repeat(40) }, { mappedMethods: 0 });
  // Shard directories are read in byte order, as the workflow's glob reads them: 0, 1, 10, 2.
  const merge = await setup({
    'shard-0': [odota],
    'shard-1': [],
    'shard-10': [kanba, { ...odota, ai: { outcome: 'proposed', costUsd: 0.25 } }],
    'shard-2': [stray],
  });
  const { read, commit } = await merge('--offset', '0', '--end', '3');
  const rows = [odota, kanba, { ...odota, ai: { outcome: 'proposed', costUsd: 0.25 } }, stray];
  expect(await read('results.json')).toBe(`${JSON.stringify(rows, null, 2)}\n`);
  // `sort` in the C locale: capitals first.
  expect(await read('expected.txt')).toBe('Kanba-co/kanba\nacme/missing\nodota/core\n');
  expect(await read('present.txt')).toBe('Kanba-co/kanba\nacme/stray\nodota/core\nodota/core\n');
  expect(await read('missing.txt')).toBe('acme/missing\n');
  expect(await read('unexpected.txt')).toBe('acme/stray\n');
  expect(await read('duplicated.txt')).toBe('odota/core\n');
  expect(await read('images.txt')).toBe(`${IMAGES.split('\n').sort().join('\n')}\n`);
  expect(await read('summary.md')).toBe(
    [
      '# Merged Stripe benchmark: 4 of 3 repositories',
      '',
      `Commit \`${commit}\`, list \`subsets/merge.json\`, repositories 0 to 3. Images: ${IMAGES.split('\n').sort().join(' ')}`,
      '',
      '**Incomplete run.** Missing 1, unexpected 1, duplicated 1. Missing: acme/missing',
      '',
      '| Outcome class | Repositories |',
      '|---|---|',
      '| repository | 4 |',
      '',
      summaryTable(rows),
      'AI spend: $1.25',
      '',
    ].join('\n'),
  );
});

it('reports a complete run without the gap line, and prints a tiny AI spend as jq does', async () => {
  const merge = await setup({
    'shard-0': [
      row(KANBA, { ai: { outcome: 'declined', costUsd: 0.00004 } }),
      row(MISSING, { workflow: { status: 'missing-manifest' } }),
    ],
  });
  // Without --end the range runs to the end of the list.
  const { read } = await merge('--offset', '1');
  expect(await read('expected.txt')).toBe('Kanba-co/kanba\nacme/missing\n');
  for (const name of ['missing.txt', 'unexpected.txt', 'duplicated.txt'])
    expect(await read(name)).toBe('');
  const summary = await read('summary.md');
  expect(summary).toContain('repositories 1 to 3.');
  expect(summary).not.toContain('Incomplete run');
  // The missing manifest is an infrastructure error, counted apart.
  expect(summary).toContain('| infrastructure | 1 |\n| repository | 1 |\n');
  expect(summary.endsWith('\nAI spend: $4e-05\n')).toBe(true);
});
