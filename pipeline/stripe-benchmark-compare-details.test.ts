import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Rows carry the fields the results schema requires of every row.
const COMMIT = 'a'.repeat(40);
const affected = { status: 'affected', confirmed: 1, review: 0, findings: [] };

function validated(reason: string) {
  return {
    repo: 'acme/shop',
    commit: COMMIT,
    read: 'ok',
    mappedMethods: 2,
    tracedCalls: 3,
    fullAdapter: { ...affected, confirmedFields: ['invoice.subscription'] },
    checks: 'tests',
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

// Writes a run's results.json and, when a diff is given, acme/shop's run bundle: report.json, or
// scan.json and its manifest entry for a run that stopped before validation.
async function run(results: unknown[], diff?: string, stoppedBeforeValidation = false) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-compare-'));
  directories.push(directory);
  await writeFile(join(directory, 'results.json'), JSON.stringify(results));
  if (diff !== undefined) {
    const bundle = join(directory, 'repos', 'acme__shop', 'run');
    await mkdir(bundle, { recursive: true });
    if (!stoppedBeforeValidation)
      await writeFile(join(bundle, 'report.json'), JSON.stringify({ patch: { diff } }));
    else {
      const scan = JSON.stringify({ runId: 'same', patch: { status: 'proposed', diff } });
      await writeFile(join(bundle, 'scan.json'), scan);
      const sha256 = createHash('sha256').update(scan).digest('hex');
      await writeFile(
        join(bundle, 'manifest.json'),
        JSON.stringify({ files: [{ path: 'scan.json', sha256 }] }),
      );
    }
  }
  return join(directory, 'results.json');
}

it('reports which fields differ between runs, hashing the full patch from each bundle', async () => {
  const notAffected = {
    repo: 'acme/blog',
    commit: COMMIT,
    read: 'ok',
    mappedMethods: 1,
    fullAdapter: { status: 'not-affected', confirmed: 0, review: 0, findings: [] },
  };
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

it('hashes the proposed patch and scan.json of runs that stopped before validation', async () => {
  const stopped = {
    repo: 'acme/shop',
    commit: COMMIT,
    read: 'ok',
    mappedMethods: 2,
    fullAdapter: affected,
    checks: 'tests',
    workflow: { status: 'error', stage: 'validation' },
  };
  const compare = async (first: string, second: string) =>
    JSON.parse(
      (
        await execute(process.execPath, [
          'scripts/stripe-benchmark-compare.mjs',
          await run([stopped], first, true),
          await run([stopped], second, true),
          '--details',
          '--json',
        ])
      ).stdout,
    ).rows[0];
  const same = await compare('a', 'a');
  expect(same.differs).toEqual([]);
  expect(same.fields[0]).toMatchObject({
    scan: expect.stringMatching(/^[0-9a-f]{12}$/),
    diff: expect.stringMatching(/^[0-9a-f]{12}$/),
  });
  expect((await compare('a', 'b')).differs).toEqual(['scan', 'diff']);
});
