import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { STRIPE } from './providers.ts';
import { publicationWaiver, publishDraft } from './publication.ts';
import { runPipeline } from './run.ts';
import { digest } from './specifications.ts';
import { validateMigration } from './validation.ts';
import { runWorkflow, scanReviewReason } from './workflow.ts';

vi.mock('./validation.ts', () => ({ validateMigration: vi.fn() }));
vi.mock('./publication.ts', async (original) => ({
  ...(await original<typeof import('./publication.ts')>()),
  publishDraft: vi.fn(async () => ({ status: 'created', url: 'https://github.com/o/r/pull/1' })),
}));

type Report = Awaited<ReturnType<typeof validateMigration>>;
const roots: string[] = [];
const BEFORE = '2023-10-16';
const TARGET = '2026-09-30.endive';
const WRITER = { model: 'gpt-6.1-sol', dryRun: true as const };
const REGRESSION =
  "Refit's patch failed the repository checks, so it is kept with this run's artifacts as evidence and not published.";

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const integer = { type: 'integer' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties });
// Reduced Stripe contracts: the subscription period moves to its items, and Checkout Session
// creation drops payment_method_types.
function contract(after: boolean) {
  return {
    openapi: '3.0.0',
    info: { version: after ? TARGET : BEFORE },
    paths: {
      '/v1/checkout/sessions': {
        post: {
          operationId: 'PostCheckoutSessions',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: object({
                  mode: {},
                  ...(after ? { allowed_payment_method_types: {} } : { payment_method_types: {} }),
                }),
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        subscription: object({
          id: { type: 'string' },
          items: object({
            data: { type: 'array', items: { $ref: '#/components/schemas/subscription_item' } },
          }),
          ...(after ? {} : { current_period_start: integer, current_period_end: integer }),
        }),
        subscription_item: object({
          id: { type: 'string' },
          ...(after ? { current_period_start: integer, current_period_end: integer } : {}),
        }),
        'checkout.session': object({ id: { type: 'string' } }),
      },
    },
  };
}

const PROVIDER = {
  ...STRIPE,
  id: 'stripe-fallback',
  operations: [
    { resource: 'subscriptions', method: 'retrieve', schema: 'subscription' },
    {
      resource: 'checkout.sessions',
      method: 'create',
      schema: 'checkout.session',
      operationId: 'PostCheckoutSessions',
    },
  ],
};

// An npm v3 lockfile on stripe 18.3.0 and the registry's 23.0.0 metadata, the release
// stripe-package-upgrade.ts records for endive.
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const npmProject = {
  'package.json': json({ name: 'app', dependencies: { stripe: '^18.3.0' } }),
  'package-lock.json': json({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: { stripe: '^18.3.0' } },
      'node_modules/stripe': {
        version: '18.3.0',
        resolved: 'https://registry.npmjs.org/stripe/-/stripe-18.3.0.tgz',
        integrity: INTEGRITY,
      },
    },
  }),
};
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

const client = (version: string) =>
  `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_KEY!, { apiVersion: '${version}' });\n`;

// Shaped like push-279 rows whose patch with the pin move and the stripe-node 23 upgrade failed
// typecheck. Loopletter: a webhook route on its own newer client reads the moved period, so the
// version-tolerant helper is a patch without the move. warranty-watcher: one client and a removed
// request parameter left in place, so without the move there is nothing to patch.
const SHAPES: {
  name: string;
  files: Record<string, string>;
  pins: string[];
  stop: string;
  kept: string[];
}[] = [
  {
    name: 'Loopletter',
    files: {
      'app/api/subscription/portal/route.ts': `${client(BEFORE)}export const POST = () => stripe.checkout.sessions.create({ mode: 'subscription' });\n`,
      'app/api/webhooks/stripe/route.ts': `${client('2025-06-30.basil')}export async function ends(id: string) {\n  const subscription = await stripe.subscriptions.retrieve(id);\n  return subscription.current_period_end;\n}\n`,
    },
    pins: ['app/api/subscription/portal/route.ts:2', 'app/api/webhooks/stripe/route.ts:2'],
    stop: 'Declared SDK API version 2025-06-30.basil at app/api/webhooks/stripe/route.ts:2 conflicts with the application pin 2023-10-16.',
    // The period helper is written into the file that reads the period.
    kept: ['app/api/webhooks/stripe/route.ts'],
  },
  {
    name: 'warranty-watcher',
    files: {
      'lib/stripe/server.ts': `${client(BEFORE)}export const checkout = () => stripe.checkout.sessions.create({ mode: 'subscription', payment_method_types: ['card_present'] });\n`,
    },
    pins: ['lib/stripe/server.ts:2'],
    stop: 'A traced SDK request sends a parameter the target API version removed. No reviewed replacement exists, and dropping or replacing it changes request behavior; automatic migration, AI and publication stop for review. The call: lib/stripe/server.ts:3 sends payment_method_types.',
    kept: [],
  },
];

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-fallback-'));
  roots.push(root);
  const directory = join(root, 'repository');
  for (const [path, content] of Object.entries({ ...npmProject, ...files })) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await writeFile(join(root, 'before.json'), JSON.stringify(contract(false)));
  await writeFile(join(root, 'after.json'), JSON.stringify(contract(true)));
  await writeFile(join(root, 'provider.json'), JSON.stringify(PROVIDER));
  return {
    repository: directory,
    before: join(root, 'before.json'),
    after: join(root, 'after.json'),
    providerConfig: join(root, 'provider.json'),
    apiVersion: BEFORE,
    output: join(root, 'run'),
  };
}

const execute = promisify(execFile);
async function commit(directory: string) {
  await execute('git', ['init', '-q', directory]);
  await execute('git', ['-C', directory, 'add', '.']);
  await execute('git', [
    '-C',
    directory,
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
}

const changedFiles = (diff: string) =>
  [...diff.matchAll(/^\+\+\+ "b\/(.+)"$/gm)].map((match) => match[1]).sort();

// The proposal as validation reports it with `status`; no Docker ran.
function validated(report: Awaited<ReturnType<typeof runPipeline>>, status: string): Report {
  const diff = 'diff' in report.patch ? report.patch.diff : '';
  const check = {
    status: status === 'passed' ? 'passed' : 'failed',
    exitCode: status === 'passed' ? 0 : 2,
    stdout: '',
    stderr: '',
  };
  return {
    ...report,
    patch: { ...report.patch, validation: status },
    publicationFiles: changedFiles(diff).map((path) => ({ path, mode: '100644', content: 'x' })),
    validation: {
      status,
      revision: 'a'.repeat(40),
      command: ['npm', 'run', 'typecheck'],
      baselineCommand: ['npm', 'run', 'typecheck'],
      patchHash: digest(diff),
      baseline: { status: 'passed', exitCode: 0, stdout: '', stderr: '' },
      patched: check,
    },
  } as unknown as Report;
}

// Owner decision 1: when the patch that moves the API version fails the checks, the workflow
// validates it again without the move. Edits that read either version are kept as a [Needs review]
// draft; with none, the run ends as the scan's stop did before decision 1, and nothing publishes.
it.each(SHAPES)(
  'drops the API-version move from a regressing patch ($name)',
  async ({ files, pins, stop, kept }) => {
    registry();
    const inputs = await repository(files);
    const proposal = (keepApiVersion: boolean) =>
      runPipeline({ ...inputs, proposePatch: true, leaveReviewedFindings: true, keepApiVersion });

    const full = await proposal(false);
    if (!('diff' in full.patch)) throw new Error('Expected the full patch');
    expect(full.patch.diff).toContain(`apiVersion: '${TARGET}'`);
    expect(changedFiles(full.patch.diff)).toEqual(
      expect.arrayContaining(['package-lock.json', 'package.json']),
    );
    const without = await proposal(true);
    const keptDiff = 'diff' in without.patch ? without.patch.diff : '';
    expect(changedFiles(keptDiff)).toEqual(kept);
    expect(keptDiff).not.toContain(TARGET);
    expect(scanReviewReason(full, false, false)).toBe(stop);

    vi.mocked(validateMigration).mockImplementation(async (options) => {
      const report = await runPipeline({ ...options, proposePatch: true });
      return validated(report, options.keepApiVersion ? 'passed' : 'regression');
    });
    const result = await runWorkflow({
      ...inputs,
      image: 'node:22-alpine',
      command: ['npm', 'run', 'typecheck'],
      behaviourTestWriter: WRITER,
      publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
    });
    expect(
      vi.mocked(validateMigration).mock.calls.map(([options]) => options.keepApiVersion),
    ).toEqual([false, true]);
    // The retry never makes a second, identical behaviour-test request.
    expect(
      vi.mocked(validateMigration).mock.calls.map(([options]) => options.behaviourTestWriter),
    ).toEqual([WRITER, undefined]);
    if (kept.length) {
      expect(result.manifest).toMatchObject({ status: 'draft-created' });
      expect(result.manifest.waivedGates).toContain('api-version-kept');
      expect(result.manifest.waivedGates).not.toContain('api-version');
      const [published] = vi.mocked(publishDraft).mock.calls[0];
      expect(published.patch).toMatchObject({ keptApiVersion: true });
      const reviews = publicationWaiver(published, true)!;
      const gate = reviews.find((entry) => entry.gate === 'api-version-kept')!;
      expect(gate.reason).toBe(
        `\`npm run typecheck\` failed on the patch that moved the API version to \`${TARGET}\`, so this patch leaves every pin listed here and the stripe package unchanged. It keeps only edits that work under either version; Refit compared the \`${BEFORE}\` contract with \`${TARGET}\`.`,
      );
      expect(
        'sites' in gate && gate.sites!.map((site) => `${site.file}:${site.line}`).sort(),
      ).toEqual(pins);
      const body = await readFile(join(result.directory, 'pull-request.md'), 'utf8');
      expect(body).toMatch(/^## Why this needs review\n/);
    } else {
      expect(result.manifest).toMatchObject({ status: 'needs-review', stage: 'validation' });
      expect(result.manifest.reason).toBe(`${stop} ${REGRESSION}`);
      expect(publishDraft).not.toHaveBeenCalled();
    }
  },
);

it('ends a regression that moved no API version at the scan stop, without a retry', async () => {
  registry();
  const inputs = await repository(SHAPES[0].files);
  vi.mocked(validateMigration).mockImplementation(async (options) =>
    validated(
      await runPipeline({ ...options, proposePatch: true, keepApiVersion: true }),
      'regression',
    ),
  );
  const result = await runWorkflow({
    ...inputs,
    image: 'node:22-alpine',
    command: ['npm', 'run', 'typecheck'],
    allowUnresolved: true,
  });
  // Nothing to drop, so no second validation; the scan would have stopped, so the run ends there.
  expect(validateMigration).toHaveBeenCalledOnce();
  expect(result.manifest).toMatchObject({ status: 'needs-review' });
  expect(result.manifest.reason).toBe(`${SHAPES[0].stop} ${REGRESSION}`);
  expect(publishDraft).not.toHaveBeenCalled();
});

// A docker stand-in for validation: a check fails on a tree that sends the target version, as
// stripe-node 23's types failed these repositories' typecheck, and passes on every other tree.
async function checksFailOnTarget() {
  const root = await mkdtemp(join(tmpdir(), 'refit-fallback-docker-'));
  roots.push(root);
  await writeFile(
    join(root, 'docker'),
    `#!/usr/bin/env node
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'image') { console.log(args[3] === '{{.Id}}' ? 'sha256:${'a'.repeat(64)}' : JSON.stringify(['NODE_VERSION=22.23.3'])); process.exit(0); }
if (args[0] !== 'run') process.exit(0);
const input = args.find((arg) => arg.endsWith(',dst=/input,readonly')).slice('type=bind,src='.length, -',dst=/input,readonly'.length);
const sends = (directory) => readdirSync(directory, { withFileTypes: true }).some((entry) =>
  entry.isDirectory() ? sends(join(directory, entry.name)) : readFileSync(join(directory, entry.name), 'utf8').includes(${JSON.stringify(TARGET)}));
process.exit(sends(input) ? 2 : 0);
`,
  );
  await chmod(join(root, 'docker'), 0o755);
  vi.stubEnv('PATH', root + delimiter + process.env.PATH);
}

// The same shapes through the real validation: the retry without the move must not end the run
// in an error, whether nothing is left to patch (warranty-watcher) or the pins it leaves still
// conflict as they did in the committed code (Loopletter).
it.each(SHAPES)(
  'validates the patch without the API-version move ($name)',
  async ({ files, stop, kept }) => {
    registry();
    await checksFailOnTarget();
    const inputs = await repository(files);
    await commit(inputs.repository);
    const { validateMigration: validate } =
      await vi.importActual<typeof import('./validation.ts')>('./validation.ts');
    vi.mocked(validateMigration).mockImplementation(validate);
    const result = await runWorkflow({
      ...inputs,
      image: 'node:22-alpine',
      command: ['npm', 'run', 'typecheck'],
      publication: { repository: 'o/r', base: 'main', token: 'unused', allowUnresolved: true },
    });
    expect(
      vi.mocked(validateMigration).mock.calls.map(([options]) => options.keepApiVersion),
    ).toEqual([false, true]);
    if (kept.length) {
      expect(result.manifest).toMatchObject({ status: 'draft-created' });
      const [published] = vi.mocked(publishDraft).mock.calls[0];
      expect(published.patch).toMatchObject({ keptApiVersion: true });
      expect(published.validation.status).toBe('passed');
      expect(published.publicationFiles.map((file) => file.path)).toEqual(kept);
    } else {
      expect(result.manifest).toMatchObject({ status: 'needs-review', stage: 'validation' });
      expect(result.manifest.reason).toBe(`${stop} ${REGRESSION}`);
      expect(publishDraft).not.toHaveBeenCalled();
    }
  },
);
