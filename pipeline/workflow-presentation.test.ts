import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { renderWorkflowResult } from './workflow-presentation.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it('summarizes API impact, proposed edits and offline checks for interactive CLI output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-presentation-test-'));
  directories.push(directory);
  await writeFile(
    join(directory, 'report.json'),
    JSON.stringify({
      provider: 'stripe',
      changes: [{ schema: 'payment_intent', property: 'charges' }],
      findings: [
        { confidence: 'confirmed', file: 'src/billing/history.ts' },
        { confidence: 'confirmed', file: 'src/billing/history.ts' },
      ],
      operationImpacts: [
        {
          operationId: 'retrieveCustomer',
          path: '/customers/{id}',
          httpMethod: 'GET',
          changes: [
            {
              id: 'response-property-type-changed',
              level: 3,
              text: 'changed the response property type',
            },
          ],
          usages: [{ file: 'src/billing/customer.ts', line: 18, column: 12 }],
        },
      ],
      patch: {
        status: 'proposed',
        generator: 'deterministic',
        summary: 'Use a paginated Charges list filtered by PaymentIntent.',
      },
      publicationFiles: [{ path: 'src/billing/history.ts' }],
      validation: {
        status: 'passed',
        environment: { reused: false },
        baseline: { status: 'passed' },
        patched: { status: 'passed' },
        attempts: [{}],
        repair: { requested: 0 },
      },
    }),
  );
  const result = {
    directory,
    manifest: {
      files: [{ path: 'report.json' }],
      status: 'validated',
      reason: 'Baseline and patched checks passed.',
      error: null,
    },
  } as unknown as Parameters<typeof renderWorkflowResult>[0];

  const output = await renderWorkflowResult(result);
  expect(output).toContain('Migration validated');
  expect(output).toContain('Stripe removes payment_intent.charges');
  expect(output).toContain('2 confirmed usages in 1 file');
  expect(output).toContain('1 breaking API change across 1 operation map to 1 SDK call site');
  expect(output).toContain('GET /customers/{id} (retrieveCustomer)');
  expect(output).toContain('[response-property-type-changed] changed the response property type');
  expect(output).toContain('src/billing/customer.ts:18');
  expect(output).toContain('Use a paginated Charges list filtered by PaymentIntent.');
  expect(output).toContain('src/billing/history.ts');
  expect(output).toContain('Prepared from npm lockfile; checks offline');
  expect(output).toContain('Original: passed; proposed: passed');

  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  report.changes[0].property = 'charges\u001b[2J';
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  expect(await renderWorkflowResult(result)).not.toContain('\u001b');
});
