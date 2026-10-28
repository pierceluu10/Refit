import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { publicationWaiver } from './publication.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { validateMigration } from './validation.ts';

type Report = Awaited<ReturnType<typeof validateMigration>>;
const roots: string[] = [];
const BEFORE = '2026-08-26.dahlia';
const TARGET = '2026-09-30.endive';

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const contract = (version: string, fields: string[]) => ({
  openapi: '3.0.0',
  info: { version },
  paths: {
    '/v1/checkout/sessions': {
      post: {
        operationId: 'PostCheckoutSessions',
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: Object.fromEntries(fields.map((name) => [name, {}])),
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: { 'checkout.session': { type: 'object', properties: { id: { type: 'string' } } } },
  },
});

const PROVIDER = {
  id: 'stripe-checkout',
  packageName: 'stripe',
  defaultImport: true,
  namedExport: 'Stripe',
  constructorCalls: true,
  apiVersion: { constructorArgument: 1, property: 'apiVersion', requestArguments: [1, 2] },
  operations: [
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'PostCheckoutSessions',
    },
  ],
};

// A TypeScript app whose only lockfile is one the stripe-node upgrade does not edit (bun.lock).
async function scan(extension: 'ts' | 'js') {
  const root = await mkdtemp(join(tmpdir(), 'refit-pin-upgrade-'));
  roots.push(root);
  const repository = join(root, 'repository');
  for (const [path, content] of Object.entries({
    'package.json': JSON.stringify({ dependencies: { stripe: '22.6.2' } }),
    'bun.lock': '{}\n',
    [`lib/stripe.${extension}`]: `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '${BEFORE}' });\nexport const checkout = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n`,
  })) {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await writeFile(
    join(root, 'before.json'),
    JSON.stringify(contract(BEFORE, ['mode', 'payment_method_types'])),
  );
  await writeFile(
    join(root, 'after.json'),
    JSON.stringify(contract(TARGET, ['mode', 'allowed_payment_method_types'])),
  );
  await writeFile(join(root, 'provider.json'), JSON.stringify(PROVIDER));
  return runPipeline({
    repository,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: BEFORE,
    proposePatch: true,
    leaveReviewedFindings: true,
  });
}

it('keeps a TypeScript pin when stripe-node cannot be upgraded, and names the blocker', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const report = await scan('ts');
  expect(fetch).not.toHaveBeenCalled();
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).not.toContain(`'${TARGET}'`);
  expect(report.patch).toMatchObject({
    keptApiVersion: true,
    pinBlocked: expect.stringMatching(/^Only root npm, pnpm or Yarn 1 projects/),
  });
  const passed = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  const reviews = publicationWaiver(
    {
      ...report,
      publicationFiles: [{ path: 'lib/stripe.ts', mode: '100644', content: 'patched' }],
      validation: {
        status: 'passed',
        revision: 'a'.repeat(40),
        command: ['npm', 'test'],
        baselineCommand: ['npm', 'test'],
        patchHash: digest(report.patch.diff),
        baseline: passed,
        patched: passed,
      },
    } as unknown as Report,
    true,
  )!;
  const kept = reviews.find(({ gate }) => gate === 'api-version-kept');
  expect(kept?.reason).toMatch(
    /^Refit could not upgrade stripe-node to the release whose types accept `2026-09-30\.endive`: Only root npm, pnpm or Yarn 1 projects .+ A pin moves only with that upgrade, so this patch leaves every pin listed here/,
  );
});

it('still moves a JavaScript pin, which no installed type checks', async () => {
  const report = await scan('js');
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  expect(report.patch.diff).toContain(`apiVersion: '${TARGET}'`);
  expect(report.patch).not.toHaveProperty('pinBlocked');
});
