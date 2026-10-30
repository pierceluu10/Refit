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
const route = (version: string) =>
  `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '${version}' });\nexport const POST = () => stripe.checkout.sessions.create({ mode: 'payment' });\n`;

// Two shapes from the dev set: a Next.js app whose webhook route makes its own older client
// (Loopletter, tinypivot), and an app with a script that already pins the target (noir-crm).
const SHAPES: {
  files: Record<string, string>;
  pins: string[][];
  unlisted: string[];
  changed: string[];
}[] = [
  {
    files: {
      'lib/stripe.js': client(BEFORE),
      'checkout.js': checkout('./lib/stripe.js', "['card']"),
      'app/api/webhooks/stripe/route.js': route('2025-06-30.basil'),
    },
    pins: [
      ['app/api/webhooks/stripe/route.js:2', '2025-06-30.basil'],
      ['lib/stripe.js:2', BEFORE],
    ],
    unlisted: [],
    changed: ['app/api/webhooks/stripe/route.js', 'checkout.js', 'lib/stripe.js'],
  },
  {
    files: {
      'src/stripe.js': client(BEFORE),
      'checkout.js': checkout('./src/stripe.js', "['card']"),
      'scripts/cancel-all.js': route(TARGET),
    },
    // The script already sends the target, so the patch leaves it and does not list it.
    pins: [['src/stripe.js:2', BEFORE]],
    unlisted: ['scripts/cancel-all.js:2'],
    changed: ['checkout.js', 'src/stripe.js'],
  },
];

// Owner decision 1: pins that send different versions all move to the target with the same rules,
// and the draft lists each one with the version it sent. Without it the run stops at the scan.
it.each(SHAPES)('moves every older pin to the target and lists each one', async (shape) => {
  const stopped = await scan(shape.files, false);
  expect(stopped.apiVersion.source.status).toBe('conflict');
  expect(scanReviewReason(stopped, false, false)).toMatch(
    new RegExp(`^Declared SDK API version .+ conflicts with the application pin ${BEFORE}\\.$`),
  );
  for (const [site, version] of shape.pins)
    if (version !== BEFORE) expect(changedFiles(stopped)).not.toContain(site.split(':')[0]);

  const reviewed = await scan(shape.files, true);
  expect(scanReviewReason(reviewed, false, true)).toBeUndefined();
  expect(changedFiles(reviewed)).toEqual(shape.changed);
  const diff = 'diff' in reviewed.patch ? reviewed.patch.diff : '';
  // The card-only rename rides the pins, as it does for one client.
  expect(diff).toContain("allowed_payment_method_types: ['card']");
  expect(diff).not.toMatch(new RegExp(`^\\+.*'(?:${BEFORE}|2025-06-30\\.basil)'`, 'm'));

  const report = passed(reviewed);
  const reviews = publicationWaiver(report, true)!;
  expect(reviews.find(({ gate }) => gate === 'api-version')?.reason).toBe(
    `Not every API-version pin in this code sends the configured \`${BEFORE}\`. The patch moves every pin listed here (its line before this patch and the version it sent) to \`${TARGET}\`; Refit compared the \`${BEFORE}\` contract with it.`,
  );
  const { manifest, files } = createReviewArtifacts(report, 'github', undefined, reviews);
  expect(manifest.title).toMatch(/^\[Needs review\] /);
  for (const [site, version] of shape.pins)
    expect(files['pull-request.md']).toContain(`  - \`${site}\` \`${version}\``);
  for (const site of shape.unlisted) expect(files['pull-request.md']).not.toContain(site);
  expect(publicationWaiver(report, false)).toBeUndefined();
});

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

// Shaped like an npm v3 lockfile on `version` and the registry's stripe 23.0.0 metadata, the
// release stripe-package-upgrade.ts records for endive.
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const npmProject = (version: string) => ({
  'package.json': json({ name: 'app', dependencies: { stripe: `^${version}` } }),
  'package-lock.json': json({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: { stripe: `^${version}` } },
      'node_modules/stripe': {
        version,
        resolved: `https://registry.npmjs.org/stripe/-/stripe-${version}.tgz`,
        integrity: INTEGRITY,
      },
    },
  }),
});
function registry() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'stripe',
            version: '23.0.0',
            license: 'MIT',
            dependencies: {},
            engines: { node: '>=20' },
            dist: {
              tarball: 'https://registry.npmjs.org/stripe/-/stripe-23.0.0.tgz',
              integrity: INTEGRITY,
            },
          }),
        ),
    ),
  );
}

// Two shapes of a version Refit cannot trace beside a literal pin (dev set: an environment
// variable on a route, and a config object). The card-only rename needs every pin moved, so it stays for review.
// `renamed`: founders' decision (2026-10-27): the card list on a call whose own client is traced is
// renamed even though another client's version is not.
const UNTRACED_SHAPES: {
  files: Record<string, string>;
  untraced: string;
  moved: string[];
  renamed?: true;
}[] = [
  {
    files: {
      'lib/stripe.ts': client(BEFORE),
      'checkout.ts': checkout('./lib/stripe', "['card']"),
      'app/api/refund/route.ts': `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: process.env.STRIPE_API_VERSION as Stripe.LatestApiVersion });\nexport const POST = () => stripe.checkout.sessions.create({ mode: 'payment' });\n`,
    },
    untraced: 'app/api/refund/route.ts:2',
    moved: ['checkout.ts', 'lib/stripe.ts'],
    renamed: true,
  },
  {
    files: {
      'src/stripe.ts': client(BEFORE),
      'src/config.ts': `export const settings = { version: process.env.STRIPE_VERSION ?? '${BEFORE}' };\n`,
      'src/connect.ts': `import Stripe from 'stripe';\nimport { settings } from './config';\nconst stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: settings.version as Stripe.LatestApiVersion });\nexport const POST = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n`,
    },
    untraced: 'src/connect.ts:3',
    moved: ['src/stripe.ts'],
  },
];

// Owner decision 1: the patch never edits a version Refit cannot trace. It still moves the traced
// pins and upgrades stripe-node, and the draft names each untraced site and the version to set.
it.each(UNTRACED_SHAPES)(
  'leaves a version it cannot trace for review and still upgrades stripe-node',
  async (shape) => {
    registry();
    const files = { ...npmProject('22.6.2'), ...shape.files };
    const stopped = await scan(files, false);
    expect(stopped.patch.status === 'proposed').toBe(Boolean(shape.renamed));

    const reviewed = await scan(files, true);
    expect(reviewed.patch).toMatchObject({
      status: 'proposed',
      sdkUpgrade: { from: '22.6.2', to: '23.0.0' },
    });
    const diff = 'diff' in reviewed.patch ? reviewed.patch.diff : '';
    expect(changedFiles(reviewed)).toEqual(
      [...shape.moved, 'package-lock.json', 'package.json'].sort(),
    );
    // Pin-dependent rules on the untraced client's path keep stopping, listed with why (owner
    // answer (c)).
    const parameter = reviewed.findings.find((finding) => finding.requestParameter);
    if (shape.renamed) {
      expect(diff).toContain("allowed_payment_method_types: ['card']");
      expect(parameter).toBeUndefined();
    } else {
      expect(diff).not.toContain('allowed_payment_method_types');
      expect(parameter?.reason).toContain(
        `Refit cannot resolve the API version the client created at ${shape.untraced} sends`,
      );
    }

    const report = passed(reviewed);
    const reviews = publicationWaiver(report, true)!;
    const untraced = reviews.find(({ gate }) => gate === 'api-version-untraced');
    expect(untraced).toMatchObject({
      reason: `Refit cannot trace which API version the code listed here sends, or cannot move it without moving a webhook endpoint too, so the patch leaves it unchanged. Refit compared the \`${BEFORE}\` contract with \`${TARGET}\`; if this code sends another version, what needs migrating can differ.`,
      check: `Set each version listed here to \`${TARGET}\` where its value comes from, and check what this code needs for the version it sends now.`,
    });
    const [file, line] = shape.untraced.split(':');
    expect(untraced && 'sites' in untraced ? untraced.sites : []).toEqual([
      { file, line: Number(line) },
    ]);
    expect(reviews.map(({ gate }) => gate).includes('removed-request-parameter')).toBe(
      !shape.renamed,
    );
    const { manifest, files: artifacts } = createReviewArtifacts(
      report,
      'github',
      undefined,
      reviews,
    );
    expect(manifest.title).toMatch(/^\[Needs review\] /);
    expect(artifacts['pull-request.md']).toContain(`  - \`${shape.untraced}\``);
    expect(publicationWaiver(report, false)).toBeUndefined();
  },
);

// Two shapes of clients that set no apiVersion on a stripe-node whose default Refit does not know:
// before 12 the account default decides (one shared client), and 21.0.0, which the table skips
// (two route clients).
const DEFAULT_SHAPES: { release: string; files: Record<string, string>; clients: string[] }[] = [
  {
    release: '11.18.0',
    files: {
      'lib/stripe.js': `import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_KEY);\n`,
      'checkout.js': checkout('./lib/stripe.js', "['card']"),
    },
    clients: ['lib/stripe.js:2'],
  },
  {
    release: '21.0.0',
    files: {
      'app/api/checkout/route.js': `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY, {});\nexport const POST = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n`,
      'app/api/portal/route.js': `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY);\nexport const POST = () => stripe.checkout.sessions.create({ mode: 'setup' });\n`,
    },
    clients: ['app/api/checkout/route.js:2', 'app/api/portal/route.js:2'],
  },
];

// Owner decision 1 and answer (b): Refit never adds a pin. It upgrades stripe-node, and the draft
// says that the account default decided the version before and the target decides it after.
it.each(DEFAULT_SHAPES)(
  'says the account default decided the version before the upgrade',
  async (shape) => {
    registry();
    const files = { ...npmProject(shape.release), ...shape.files };
    const reviewed = await scan(files, true);
    expect(reviewed.patch).toMatchObject({
      status: 'proposed',
      sdkUpgrade: { from: shape.release, to: '23.0.0' },
    });
    const diff = 'diff' in reviewed.patch ? reviewed.patch.diff : '';
    expect(diff).toContain("allowed_payment_method_types: ['card']");
    expect(diff).not.toMatch(/^\+.*apiVersion/m);
    // The flag adds the reason only; the patch is the one Refit proposed before.
    const unflagged = await scan(files, false);
    expect('diff' in unflagged.patch ? unflagged.patch.diff : '').toBe(diff);

    const report = passed(reviewed);
    const reviews = publicationWaiver(report, true)!;
    const defaulted = reviews.find(({ gate }) => gate === 'api-version-default');
    expect(defaulted?.reason).toBe(
      `No Stripe client listed here sets apiVersion, and Refit does not know which version stripe-node ${shape.release} sent: releases before 12 send none, so your Stripe account's default decided it, and Refit's table does not record what later ones pin. Refit compared the \`${BEFORE}\` contract with \`${TARGET}\`. After this patch stripe-node 23.0.0 sends \`${TARGET}\` unless the code sets a version.`,
    );
    const { manifest, files: artifacts } = createReviewArtifacts(
      report,
      'github',
      undefined,
      reviews,
    );
    expect(manifest.title).toMatch(/^\[Needs review\] /);
    for (const site of shape.clients)
      expect(artifacts['pull-request.md']).toContain(`  - \`${site}\``);
    expect(publicationWaiver(report, false)).toBeUndefined();
  },
);

it('adds no default reason when the table records what the locked stripe-node sends', async () => {
  registry();
  const reviewed = await scan({ ...npmProject('22.6.2'), ...DEFAULT_SHAPES[0].files }, true);
  expect(reviewed.patch).toMatchObject({ sdkUpgrade: { from: '22.6.2', to: '23.0.0' } });
  const reviews = publicationWaiver(passed(reviewed), true)!;
  expect(reviews.map(({ gate }) => gate)).not.toContain('api-version-default');
});

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
