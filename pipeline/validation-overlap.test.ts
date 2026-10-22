import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { validateMigration } from './validation.ts';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A docker stand-in whose checks take a second each and record when they ran. The baseline
// directory is mounted from `.../baseline`, candidates from `.../candidate-*`.
async function fixture(baselineExit: number, generated = false) {
  const root = await mkdtemp(join(tmpdir(), 'refit-overlap-'));
  roots.push(root);
  const repository = join(root, 'repository');
  const binary = join(root, 'bin');
  const log = join(root, 'checks.jsonl');
  await cp(resolve('pipeline/fixtures/repository'), repository, { recursive: true });
  await mkdir(binary);
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
    '-qm',
    'test: seed repository',
  ]);
  await writeFile(
    join(binary, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log('sha256:${'d'.repeat(64)}'); process.exit(0); }
if (args[0] === 'rm' || args[0] === 'create') process.exit(0);
if (args[0] === 'cp') { fs.writeFileSync(args[2], 'stripe-mock'); process.exit(0); }
const mount = args.find((arg) => arg.includes('dst=/input'));
const contract = args.find((arg) => arg.includes('dst=/refit/spec.json'));
const side = contract
  ? (contract.includes('before.json') ? 'generated-before' : 'generated-after')
  : mount.includes('/baseline,') ? 'baseline' : 'patched';
const started = Date.now();
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ side, started, ended: Date.now() }) + '\\n');
  process.exit(side === 'baseline' ? ${baselineExit} : 0);
}, 1000);
`,
  );
  await chmod(join(binary, 'docker'), 0o755);
  vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
  const report = await validateMigration({
    repository,
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    image: 'node:22-alpine',
    command: ['npm', 'test'],
    ...(generated
      ? {
          generatedChecks: {
            stripeMockImage: 'stripe/stripe-mock:latest',
            beforeFixtures: resolve('pipeline/fixtures/before.json'),
            afterFixtures: resolve('pipeline/fixtures/after.json'),
          },
        }
      : {}),
  });
  const checks = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { side: string; started: number; ended: number });
  return { report, checks };
}

it('runs the patched checks alongside the baseline checks when no AI is involved', async () => {
  const { report, checks } = await fixture(0);
  const baseline = checks.find((check) => check.side === 'baseline')!;
  const patched = checks.find((check) => check.side === 'patched')!;
  expect(patched.started).toBeLessThan(baseline.ended);
  expect(baseline.started).toBeLessThan(patched.ended);
  expect(report.validation).toMatchObject({
    status: 'passed',
    baseline: { status: 'passed' },
    patched: { status: 'passed' },
  });
  expect(report.validation.attempts).toHaveLength(1);
});

it('reports a failed baseline exactly as the sequential order did, discarding the patched run', async () => {
  const { report, checks } = await fixture(1);
  // The patched run started alongside the baseline but its result is not used.
  expect(checks.map((check) => check.side).sort()).toEqual(['baseline', 'patched']);
  expect(report.validation).toMatchObject({
    status: 'baseline-failed',
    baseline: { status: 'failed' },
    patched: { status: 'not-run' },
    attempts: [],
    repair: { stopReason: 'baseline-failed' },
  });
  expect(report.publicationFiles).toEqual([]);
});

it('runs the generated checks against both contract versions at the same time', async () => {
  const { checks } = await fixture(0, true);
  const before = checks.find((check) => check.side === 'generated-before')!;
  const after = checks.find((check) => check.side === 'generated-after')!;
  expect(before.started).toBeLessThan(after.ended);
  expect(after.started).toBeLessThan(before.ended);
});
