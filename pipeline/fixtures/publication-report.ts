import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runPipeline } from '../run.ts';
import { digest } from '../specifications.ts';
import type { validateMigration } from '../validation.ts';

type Report = Awaited<ReturnType<typeof validateMigration>>;
const execute = promisify(execFile);
const GIT = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };

// Controlled passing evidence for `diff` on `revision`; no Docker check ran.
function passedValidation(revision: string, diff: string, command: string[]): Report['validation'] {
  return {
    status: 'passed',
    revision,
    image: `sha256:${'e'.repeat(64)}`,
    runtime: {
      configured: 'node:22-alpine',
      image: 'node:22-alpine',
      nodeVersion: '22.23.3',
      declarations: [],
      reason: 'The repository declares no Node.js version.',
    },
    command,
    baselineCommand: command,
    archiveHash: 'f'.repeat(64),
    patchHash: digest(diff),
    baseline: { status: 'passed', exitCode: 0, stdout: 'PRIVATE LOG', stderr: '' },
    patched: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
    limits: {
      timeoutMs: 120000,
      outputBytes: 1048576,
      network: 'none',
      workspace: '512m',
      memory: '1g',
    },
    publishable: false,
    attempts: [],
    repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
    reason: 'Controlled publication test evidence.',
  };
}

// The fixture repository's charges migration with controlled passing evidence for `revision`.
export async function validatedReport(revision: string): Promise<Report> {
  const scan = await runPipeline({
    repository: resolve('pipeline/fixtures/repository'),
    before: resolve('pipeline/fixtures/before.json'),
    after: resolve('pipeline/fixtures/after.json'),
    apiVersion: '2022-08-01',
    proposePatch: true,
  });
  if (!('diff' in scan.patch)) throw new Error('Expected fixture patch');
  const source = await readFile('pipeline/fixtures/repository/billing.ts', 'utf8');
  return {
    ...scan,
    patch: { ...scan.patch, validation: 'passed' },
    publicationFiles: [
      {
        path: 'billing.ts',
        mode: '100644',
        content: source.replace(
          'intent.charges.data',
          '(await stripe.charges.list({ payment_intent: intent.id })).data',
        ),
      },
    ],
    validation: passedValidation(revision, scan.patch.diff, ['npm', 'test']),
  };
}

// Stands in for validateMigration where Docker is unavailable: the real scan and patch, applied
// with `git apply` to a copy of the checkout, and controlled passing evidence for its commit.
export async function simulatedValidation(
  options: Parameters<typeof validateMigration>[0],
): Promise<Report> {
  const scan = await runPipeline({ ...options, proposePatch: true });
  if (!('diff' in scan.patch)) throw new Error(`Expected a patch: ${scan.patch.status}`);
  const git = (directory: string, args: string[]) =>
    execute('git', ['-C', directory, ...args], { env: GIT });
  const copy = await mkdtemp(join(tmpdir(), 'refit-simulated-validation-'));
  try {
    await cp(options.repository, copy, { recursive: true });
    await writeFile(join(copy, '.refit-patch.diff'), scan.patch.diff);
    await git(copy, ['apply', '.refit-patch.diff']);
    await rm(join(copy, '.refit-patch.diff'));
    const changed = (await git(copy, ['status', '--porcelain', '--untracked-files=all'])).stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
    return {
      ...scan,
      patch: { ...scan.patch, validation: 'passed' },
      publicationFiles: await Promise.all(
        changed.map(async (path) => ({
          path,
          mode: '100644' as const,
          content: await readFile(join(copy, path), 'utf8'),
        })),
      ),
      validation: passedValidation(
        (await git(options.repository, ['rev-parse', 'HEAD'])).stdout.trim(),
        scan.patch.diff,
        options.command,
      ),
    };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}
