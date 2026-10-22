import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function validated(reason: string) {
  return {
    repo: 'acme/shop',
    mappedMethods: 2,
    tracedCalls: 3,
    fullAdapter: { confirmed: 1, confirmedFields: ['invoice.subscription'] },
    checks: 'test',
    workflow: {
      status: 'validated',
      stage: 'publication',
      reason,
      patch: 'generated',
      validation: 'passed',
      baseline: 'passed',
      patched: 'passed',
      // Both runs keep the same truncated diff; only the full patch differs.
      diff: 'x'.repeat(8000),
    },
  };
}

// Writes a run's results.json and, for each diff given, the repository's report.json bundle.
async function run(results: unknown[], diff?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-compare-'));
  directories.push(directory);
  await writeFile(join(directory, 'results.json'), JSON.stringify(results));
  if (diff !== undefined) {
    const bundle = join(directory, 'repos', 'acme__shop', 'run');
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, 'report.json'), JSON.stringify({ patch: { diff } }));
  }
  return join(directory, 'results.json');
}

it('reports which fields differ between runs, hashing the full patch from each bundle', async () => {
  const notAffected = { repo: 'acme/blog', mappedMethods: 1, fullAdapter: { confirmed: 0 } };
  const first = await run([validated('Checks passed.'), notAffected], `${'x'.repeat(8000)}a`);
  const second = await run(
    [validated('Checks passed in 41 s.'), notAffected],
    `${'x'.repeat(8000)}b`,
  );
  const { stdout } = await execute(process.execPath, [
    'scripts/stripe-benchmark-compare.mjs',
    first,
    second,
    '--details',
    '--json',
  ]);
  const summary = JSON.parse(stdout);
  expect(summary).toMatchObject({ repositories: 2, sameOutcome: 2, identical: 1 });
  const shop = summary.rows.find((row: { repo: string }) => row.repo === 'acme/shop');
  expect(shop.differs).toEqual(['reason', 'diff']);
  expect(shop.fields[0].diff).toMatch(/^[0-9a-f]{12}$/);

  // Without bundles only the stored first 8000 characters are hashed, and they say so.
  const withoutBundles = await execute(process.execPath, [
    'scripts/stripe-benchmark-compare.mjs',
    await run([validated('Checks passed.')]),
    await run([validated('Checks passed.')]),
    '--details',
  ]);
  expect(withoutBundles.stdout).toContain('Identical in every compared field: 1/1 repositories.');
  const table = await execute(process.execPath, [
    'scripts/stripe-benchmark-compare.mjs',
    first,
    await run([validated('Checks passed.'), notAffected]),
    '--details',
  ]);
  expect(table.stdout).toMatch(
    /\| acme\/shop \| diff \| [0-9a-f]{12} \| [0-9a-f]{12} \(results, first 8000 characters\) \|/,
  );
});
