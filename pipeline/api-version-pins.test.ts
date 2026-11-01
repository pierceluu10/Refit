import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { publicationWaiver } from './publication.ts';
import { createReviewArtifacts } from './review.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import type { validateMigration } from './validation.ts';
import { scanReviewReason } from './workflow.ts';

type Report = Awaited<ReturnType<typeof validateMigration>>;
const roots: string[] = [];
const BEFORE = '2026-08-26.dahlia';
const TARGET = '2026-09-30.endive';

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Shaped like Stripe's dahlia and endive Checkout Session create bodies.
function contract(version: string, fields: string[]) {
  return {
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
  };
}

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

async function scan(files: Record<string, string>, leaveReviewedFindings: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'refit-pins-'));
  roots.push(root);
  const repository = join(root, 'repository');
  for (const [path, content] of Object.entries({
    'package.json': JSON.stringify({ dependencies: { stripe: '22.6.2' } }),
    ...files,
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
    leaveReviewedFindings,
  });
}

// The scan with passing checks, as validation reports them; no Docker ran.
function passed(report: Awaited<ReturnType<typeof scan>>): Report {
  if (!('diff' in report.patch)) throw new Error('Expected a patch');
  const ran = { status: 'passed' as const, exitCode: 0, stdout: '', stderr: '' };
  return {
    ...report,
    patch: { ...report.patch, validation: 'passed' },
    publicationFiles: [{ path: 'checkout.js', mode: '100644', content: 'patched' }],
    validation: {
      status: 'passed',
      revision: 'a'.repeat(40),
      command: ['npm', 'test'],
      baselineCommand: ['npm', 'test'],
      patchHash: digest(report.patch.diff),
      baseline: ran,
      patched: ran,
    },
  } as unknown as Report;
}

const changedFiles = (report: Awaited<ReturnType<typeof scan>>) =>
  [...('diff' in report.patch ? report.patch.diff : '').matchAll(/^\+\+\+ "b\/(.+)"$/gm)]
    .map((match) => match[1])
    .sort();

const client = (version: string) =>
  `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '${version}' });\n`;
const checkout = (from: string, methods: string) =>
  `import { stripe } from '${from}';\nexport const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ${methods} });\n`;

// Two shapes of a constant that sets both a client's apiVersion and a webhook endpoint's
// api_version. Moving it would move that endpoint, so under decision 1 it stays and is listed.
const ENDPOINT_SHAPES: { files: Record<string, string>; constant: string; client: string }[] = [
  {
    files: {
      'lib/stripe.js': `import Stripe from 'stripe';\nconst VERSION = '2025-06-30.basil';\nexport const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: VERSION });\nexport const listen = (url) => stripe.webhookEndpoints.create({ url, enabled_events: ['*'], api_version: VERSION });\n`,
      'src/stripe.js': client(BEFORE),
      'checkout.js': checkout('./src/stripe.js', "['card']"),
    },
    constant: 'lib/stripe.js',
    client: 'lib/stripe.js:3',
  },
  {
    files: {
      'config/stripe.js': `export const STRIPE_API_VERSION = '2025-06-30.basil';\n`,
      'server/stripe.js': `import Stripe from 'stripe';\nimport { STRIPE_API_VERSION } from '../config/stripe.js';\nexport const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: STRIPE_API_VERSION });\nexport const listen = (url) => stripe.webhookEndpoints.create({ url, enabled_events: ['*'], 'api_version': STRIPE_API_VERSION });\n`,
      'src/stripe.js': client(BEFORE),
      'src/checkout.js': checkout('./stripe.js', "['card']"),
    },
    constant: 'config/stripe.js',
    client: 'server/stripe.js:3',
  },
];

it.each(ENDPOINT_SHAPES)(
  'leaves a version constant that also sets a webhook endpoint, and lists it',
  async (shape) => {
    const reviewed = await scan(shape.files, true);
    expect(changedFiles(reviewed)).not.toContain(shape.constant);
    expect(changedFiles(reviewed)).toContain('src/stripe.js');
    const reviews = publicationWaiver(passed(reviewed), true)!;
    const untraced = reviews.find(({ gate }) => gate === 'api-version-untraced');
    const [file, line] = shape.client.split(':');
    expect(untraced && 'sites' in untraced ? untraced.sites : []).toEqual([
      {
        file,
        line: Number(line),
        detail: "2025-06-30.basil, also a webhook endpoint's api_version",
      },
    ]);
    const moved = reviews.find(({ gate }) => gate === 'api-version');
    expect(moved && 'sites' in moved ? moved.sites : []).toEqual([
      { file: 'src/stripe.js', line: 2, detail: BEFORE },
    ]);
  },
);

// A setup script whose one constant pins both its client and the webhook endpoint it creates, at
// the version every other client sends: Refit compared that contract, so the constant moves too.
it('moves an endpoint constant that sends the compared version, and says so', async () => {
  const files = {
    'scripts/setup.mjs': `import Stripe from 'stripe';\nconst API_VERSION = '${BEFORE}';\nconst stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: API_VERSION });\nawait stripe.webhookEndpoints.create({ url: process.argv[2], enabled_events: ['*'], api_version: API_VERSION });\n`,
    'src/stripe.js': client(BEFORE),
    'checkout.js': checkout('./src/stripe.js', "['card']"),
  };
  const reviewed = await scan(files, true);
  expect(changedFiles(reviewed)).toEqual(
    expect.arrayContaining(['scripts/setup.mjs', 'src/stripe.js']),
  );
  const diff = 'diff' in reviewed.patch ? reviewed.patch.diff : '';
  expect(diff).toContain(`+const API_VERSION = '${TARGET}';`);
  expect('warnings' in reviewed.patch ? reviewed.patch.warnings : []).toContainEqual(
    expect.stringContaining(`scripts/setup.mjs also sets a webhook endpoint's api_version`),
  );
  const reviews = publicationWaiver(passed(reviewed), true) ?? [];
  expect(reviews.map(({ gate }) => gate)).not.toContain('api-version-untraced');
  const { files: draft } = createReviewArtifacts(passed(reviewed), 'github', undefined, reviews);
  expect(draft['pull-request.md']).toContain('endpoints this code creates after the patch receive');
});

// Two shapes of a run whose only finding is a removed parameter with no reviewed replacement (an
// in-person method): a Next.js route with its own client (lamp-bot) and a shared client.
const PARAMETER_SHAPES: { files: Record<string, string>; call: string; changed: string[] }[] = [
  {
    files: {
      'app/api/stripe/generate-checkout/route.js': `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '${BEFORE}' });\nexport const POST = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card_present'] });\n`,
    },
    call: 'app/api/stripe/generate-checkout/route.js:3',
    changed: ['app/api/stripe/generate-checkout/route.js'],
  },
  {
    files: {
      'lib/stripe.js': client(BEFORE),
      'server/checkout.js': checkout('../lib/stripe.js', "['card', 'card_present']"),
    },
    call: 'server/checkout.js:2',
    changed: ['lib/stripe.js'],
  },
];

// Owner decision 1, as the #88 waiver: the best patch is the target pin, with the removed
// parameter left in place and named. Without it there is no patch.
it.each(PARAMETER_SHAPES)(
  'moves the pin beside a removed parameter it leaves in place',
  async (shape) => {
    const stopped = await scan(shape.files, false);
    expect(stopped.patch.status).not.toBe('proposed');

    const reviewed = await scan(shape.files, true);
    expect(reviewed.patch.status).toBe('proposed');
    expect(changedFiles(reviewed)).toEqual(shape.changed);
    const diff = 'diff' in reviewed.patch ? reviewed.patch.diff : '';
    expect(diff).toContain(`apiVersion: '${TARGET}'`);
    expect(diff).not.toContain('allowed_payment_method_types');
    // The parameter stays as it was: any line naming it is the same before and after.
    const naming = (sign: string) =>
      diff
        .split('\n')
        .filter((line) => line.startsWith(sign) && line.includes('payment_method_types'))
        .map((line) => line.slice(1));
    expect(naming('+')).toEqual(naming('-'));
    expect(scanReviewReason(reviewed, false, true)).toBeUndefined();

    const report = passed(reviewed);
    const reviews = publicationWaiver(report, true)!;
    expect(reviews.map(({ gate }) => gate)).toContain('removed-request-parameter');
    const { manifest, files } = createReviewArtifacts(report, 'github', undefined, reviews);
    expect(manifest.title).toMatch(/^\[Needs review\] /);
    expect(files['pull-request.md']).toContain('## Removed request parameters left for you');
    expect(files['pull-request.md']).toContain(`\`${shape.call}\``);
  },
);

// Founder decision (2026-10-28, docs/AI-REPAIR.md): an older literal pin moves even where Refit
// cannot trace its client, so the upgraded types never meet a stale version in a second file.
it('moves the literal pin of a client Refit cannot trace, and does not list it as unchanged', async () => {
  const reviewed = await scan(
    {
      'lib/stripe.js': client(BEFORE),
      'checkout.js': checkout('./lib/stripe.js', "['card']"),
      'scripts/admin.ts': `import Stripe from 'stripe';\nregister(new Stripe(process.env.STRIPE_KEY!, { apiVersion: '2026-02-25.clover' }));\nexport const options = { apiVersion: '2026-02-25.clover' as Stripe.LatestApiVersion };\n`,
    },
    true,
  );
  expect(changedFiles(reviewed)).toContain('scripts/admin.ts');
  const diff = 'diff' in reviewed.patch ? reviewed.patch.diff : '';
  expect(diff).not.toMatch(/^\+.*2026-02-25\.clover/m);
  expect(diff.match(new RegExp(`^\\+.*'${TARGET}'`, 'gm'))).toHaveLength(3);
  const reviews = publicationWaiver(passed(reviewed), true)!;
  const untraced = reviews.find(({ gate }) => gate === 'api-version-untraced');
  expect(untraced && 'sites' in untraced ? untraced.sites : []).toEqual([]);
});
