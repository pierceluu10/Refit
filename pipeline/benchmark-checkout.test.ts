import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

// A clone whose fetch failed used to stay behind as `git init` output, and the benchmark read it
// as a repository with no Stripe calls (unique-point/car-trailers, deleted upstream, on 2026-10-22).
it('reports a checkout that is empty or not at the pinned commit as unreadable', async () => {
  const work = await mkdtemp(join(tmpdir(), 'refit-stripe-checkout-'));
  try {
    const root = join(work, 'root');
    const git = (repo: string, ...args: string[]) =>
      execute('git', ['-C', join(root, 'repos', repo), ...args]);
    for (const repo of ['o__empty', 'o__real']) {
      await mkdir(join(root, 'repos', repo), { recursive: true });
      await git(repo, 'init', '-q');
    }
    await writeFile(
      join(root, 'repos', 'o__real', 'package.json'),
      JSON.stringify({ dependencies: { stripe: '^22.0.0' } }),
    );
    await git('o__real', 'add', '-A');
    await git('o__real', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    const head = (await git('o__real', 'rev-parse', 'HEAD')).stdout.trim();
    const entry = (repo: string, commit: string) => ({
      repo,
      stars: 0,
      commit,
      before: 'v1',
      beforeSource: 'SDK version',
      stripeDependency: '^22.0.0',
      packageManager: 'npm',
    });
    await writeFile(
      join(root, 'selected.json'),
      JSON.stringify([
        entry('o/empty', 'a'.repeat(40)),
        entry('o/real', 'b'.repeat(40)),
        entry('o/real', head),
      ]),
    );
    await writeFile(join(root, 'needed-specs.json'), JSON.stringify([{ version: 'v1' }]));
    await mkdir(join(root, 'specs'));
    await writeFile(join(root, 'specs', 'sdk-v1.json'), '{}');
    await writeFile(
      join(root, 'specs', 'v1.json'),
      JSON.stringify({ openapi: '3.0.0', info: { version: 'v1' }, paths: {} }),
    );
    const output = join(work, 'output');
    await execute('npx', [
      'tsx',
      'pipeline/stripe-benchmark-cli.ts',
      '--root',
      root,
      '--output',
      output,
    ]);
    const rows = JSON.parse(await readFile(join(output, 'results.json'), 'utf8'));
    expect(
      rows.map((row: { read: string; sdkCalls?: number }) => [row.read, row.sdkCalls]),
    ).toEqual([
      [`No checkout at ${'a'.repeat(40)}; rerun scripts/stripe-benchmark-setup.mjs.`, undefined],
      [`No checkout at ${'b'.repeat(40)}; rerun scripts/stripe-benchmark-setup.mjs.`, undefined],
      ['ok', 0],
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

it('reports an empty Shopify checkout as unreadable too', async () => {
  const work = await mkdtemp(join(tmpdir(), 'refit-shopify-checkout-'));
  try {
    const root = join(work, 'root');
    await mkdir(join(root, 'repos', 'o__empty'), { recursive: true });
    await execute('git', ['-C', join(root, 'repos', 'o__empty'), 'init', '-q']);
    const list = join(work, 'list.json');
    const commit = 'c'.repeat(40);
    await writeFile(
      list,
      JSON.stringify({ schemas: { versions: [] }, repos: [{ repo: 'o/empty', stars: 0, commit }] }),
    );
    const output = join(work, 'output');
    await execute('npx', [
      'tsx',
      'pipeline/shopify-benchmark-cli.ts',
      '--root',
      root,
      '--output',
      output,
      '--list',
      list,
    ]);
    const [row] = JSON.parse(await readFile(join(output, 'results.json'), 'utf8'));
    expect(row.read).toBe(`No checkout at ${commit}; rerun scripts/shopify-benchmark-setup.mjs.`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
