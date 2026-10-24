import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runPipeline } from '../run.ts';
import { digest } from '../specifications.ts';
import type { validateMigration } from '../validation.ts';

type Report = Awaited<ReturnType<typeof validateMigration>>;

// The fixture repository's charges migration with controlled passing evidence for `revision`; no
// Docker check ran.
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
    validation: {
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
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      archiveHash: 'f'.repeat(64),
      patchHash: digest(scan.patch.diff),
      baseline: { status: 'passed', exitCode: 0, stdout: 'PRIVATE LOG', stderr: '' },
      patched: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      limits: {
        timeoutMs: 120000,
        outputBytes: 1048576,
        network: 'none',
        workspace: '512m' as const,
        memory: '1g' as const,
      },
      publishable: false,
      attempts: [],
      repair: { limit: 0, requested: 0, stopReason: 'not-needed-or-disabled', error: null },
      reason: 'Controlled publication test evidence.',
    },
  };
}
