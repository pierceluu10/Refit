import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeResult } from './write-result.ts';

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function scan(repositoryRoot: string) {
  const result = await execute(
    'node',
    [
      '--import',
      'tsx',
      join(repositoryRoot, 'pipeline/cli.ts'),
      '--repository',
      join(repositoryRoot, 'pipeline/fixtures/repository'),
      '--before',
      join(repositoryRoot, 'pipeline/fixtures/before.json'),
      '--after',
      join(repositoryRoot, 'pipeline/fixtures/after.json'),
    ],
    { cwd: repositoryRoot, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return result.stdout;
}

const revision = (
  await execute('git', ['rev-parse', 'origin/main'], { cwd: ROOT, timeout: 15_000 })
).stdout.trim();
const worktree = await mkdtemp(join(tmpdir(), 'refit-main-'));
await rm(worktree, { recursive: true, force: true });
await execute('git', ['worktree', 'add', '--detach', worktree, revision], {
  cwd: ROOT,
  timeout: 60_000,
});
try {
  await execute('ln', ['-s', join(ROOT, 'node_modules'), join(worktree, 'node_modules')], {
    timeout: 15_000,
  });
  const branch = await scan(ROOT);
  const main = await scan(worktree);
  const branchJson = JSON.parse(branch) as { runId?: string; status?: string };
  const mainJson = JSON.parse(main) as { runId?: string; status?: string };
  const result = {
    measuredAt: new Date().toISOString(),
    command:
      'node --import tsx pipeline/cli.ts --repository pipeline/fixtures/repository --before pipeline/fixtures/before.json --after pipeline/fixtures/after.json',
    flags: 'no --ai-patch',
    mainRevision: revision,
    stripeReplay: {
      identical: branch === main,
      branchBytes: Buffer.byteLength(branch),
      mainBytes: Buffer.byteLength(main),
      branchRunId: branchJson.runId ?? null,
      mainRunId: mainJson.runId ?? null,
      branchStatus: branchJson.status ?? null,
      mainStatus: mainJson.status ?? null,
    },
    billingDemo: {
      status: 'skipped',
      reason:
        'examples/billing-demo.refit.json points at ../../refit-billing-demo, which is not in this environment, and Docker is not available.',
    },
  };
  const file = await writeResult('baseline-identity', result);
  console.log(file);
  console.log(JSON.stringify(result.stripeReplay));
} finally {
  await execute('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT, timeout: 30_000 });
}
