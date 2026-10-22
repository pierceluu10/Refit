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
  report.validation.environment = { reused: false, manager: 'yarn', platformPackages: 25 };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  expect(await renderWorkflowResult(result)).toContain(
    'Prepared from yarn lockfile; checks offline; 25 platform-specific packages without checksums not installed',
  );
  report.validation.environment = {
    reused: false,
    manager: 'yarn',
    platformPackages: 25,
    platformPackageMode: 'install',
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  expect(await renderWorkflowResult(result)).toContain(
    '25 platform-specific packages installed without checksums (REFIT_YARN_PLATFORM_PACKAGES=install)',
  );
  report.validation.environment = { reused: false };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  report.changes.unshift({ id: 'unrelated', schema: 'invoice', property: 'subscription' });
  report.changes[1].id = 'history';
  report.findings.forEach((finding: { changeId: string }) => {
    finding.changeId = 'history';
  });
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  const scoped = await renderWorkflowResult(result);
  expect(scoped).toContain('Stripe removes payment_intent.charges');
  expect(scoped).not.toContain('invoice.subscription');
  report.changes.shift();
  report.changes[0].property = 'charges\u001b[2J';
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  expect(await renderWorkflowResult(result)).not.toContain('\u001b');
  report.findings = [
    {
      confidence: 'review',
      file: 'src/webhook.ts\u001b[2J',
      webhook: { eventTypes: ['customer.subscription.updated'] },
    },
  ];
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  const review = await renderWorkflowResult(result);
  expect(review).toContain('1 affected payload read; incoming API version requires review');
  expect(review).toContain('customer.subscription.updated');
  expect(review).toContain('1 finding requires review in 1 file');
  expect(review).toContain('Sources     src/webhook.ts');
  expect(review).not.toContain('\u001b');
});

it('shows the validation runtime and, when the repository declares a version, the comparison', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-presentation-test-'));
  directories.push(directory);
  const runtime = {
    configured: 'node:22-alpine',
    image: 'node:22-alpine',
    nodeVersion: '22.23.3',
    declarations: [{ source: '.nvmrc', value: '20' }],
    reason: 'The configured image does not satisfy .nvmrc "20".',
  };
  const write = (value: typeof runtime) =>
    writeFile(
      join(directory, 'report.json'),
      JSON.stringify({ validation: { status: 'passed', runtime: value } }),
    );
  const result = {
    directory,
    manifest: { files: [{ path: 'report.json' }], status: 'validated', reason: '', error: null },
  } as unknown as Parameters<typeof renderWorkflowResult>[0];
  await write(runtime);
  expect(await renderWorkflowResult(result)).toContain(
    'Runtime     node:22-alpine (Node.js 22.23.3). The configured image does not satisfy .nvmrc "20".',
  );
  await write({
    ...runtime,
    declarations: [],
    reason: 'The repository declares no Node.js version.',
  });
  const plain = await renderWorkflowResult(result);
  expect(plain).toContain('Runtime     node:22-alpine (Node.js 22.23.3)\n');
  expect(plain).not.toContain('declares no');
});

it('lists where each removed request parameter is still sent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-presentation-test-'));
  directories.push(directory);
  const site = (line: number) => ({
    confidence: 'confirmed',
    file: 'app/api/stripe/route.ts',
    line,
    requestParameter: { operationId: 'PostCheckoutSessions', parameter: 'payment_method_types' },
  });
  await writeFile(
    join(directory, 'scan.json'),
    JSON.stringify({ provider: 'stripe', changes: [], findings: [37, 52, 80, 91].map(site) }),
  );
  const rendered = await renderWorkflowResult({
    directory,
    manifest: {
      files: [{ path: 'scan.json' }],
      status: 'needs-review',
      reason: 'A traced SDK request sends a parameter the target API version removed.',
    },
  } as Parameters<typeof renderWorkflowResult>[0]);
  expect(rendered.split('\n').filter((line) => /^(Removed|            and)/.test(line))).toEqual([
    'Removed     payment_method_types is still sent at app/api/stripe/route.ts:37',
    'Removed     payment_method_types is still sent at app/api/stripe/route.ts:52',
    'Removed     payment_method_types is still sent at app/api/stripe/route.ts:80',
    '            and 1 more in the evidence',
  ]);
});
