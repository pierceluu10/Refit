import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { stripeContractVersion } from './enrollment-contracts.ts';
import { enrollmentReviewText } from './enrollment-review.ts';
import { renderReadiness } from './readiness-presentation.ts';
import { inspectRepositoryReadiness, sortBlockedChecks } from './readiness.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  loadApprovedRepository,
  RepositoryApprovalError,
} from './repository-enrollment.ts';

// A repository that commits no .refit.json, through refit doctor and refit enroll. The client is
// Ankit-Sharma1011/Quill's src/lib/stripe.ts from the P3 enrollment sample.
const execute = promisify(execFile);
const roots: string[] = [];
// Real Stripe contracts are 7 MB each, so the round trip runs only against a saved directory:
// REFIT_STRIPE_CONTRACTS=~/.refit/contracts after refit stripe-snapshot --version 2026-04-22.dahlia
// --version 2026-09-30.endive.
const SAVED = process.env.REFIT_STRIPE_CONTRACTS;
const CLIENT = `import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  apiVersion: "2026-04-22.dahlia",
  typescript: true,
});

export async function plans() {
  return stripe.prices.list({ active: true });
}
`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'refit-generated-'));
  roots.push(root);
  return root;
}

async function commit(repository: string, message: string) {
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '-qm',
    message,
  ]);
}

async function repository(options: { lockfile?: boolean; files?: Record<string, string> } = {}) {
  const root = join(await directory(), 'app');
  await mkdir(join(root, 'src/lib'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      scripts: { test: 'vitest run' },
      dependencies: { stripe: '^22.1.1' },
    }),
  );
  if (options.lockfile !== false)
    await writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { stripe: '^22.1.1' } },
          'node_modules/stripe': { version: '22.1.1' },
        },
      }),
    );
  for (const [path, content] of Object.entries(options.files ?? { 'src/lib/stripe.ts': CLIENT })) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await execute('git', ['-C', root, 'init', '-qb', 'main']);
  await commit(root, 'test: seed');
  return root;
}

it('names the contracts to save when the generated configuration has none on this machine', async () => {
  const app = await repository();
  const contracts = await directory();
  const report = await inspectRepositoryReadiness({ repository: app, contracts });
  expect(report.status).toBe('needs-attention');
  expect(report.checks).toEqual([
    {
      id: 'contracts',
      title: 'Stripe contracts',
      status: 'blocked',
      detail: `The generated configuration compares Stripe API versions 2026-04-22.dahlia and 2026-09-30.endive, and 2026-04-22.dahlia and 2026-09-30.endive are not saved in ${contracts} yet.`,
      action:
        'Run refit stripe-snapshot --version 2026-04-22.dahlia --version 2026-09-30.endive, then refit doctor again.',
    },
  ]);
  await expect(
    inspectRepositoryEnrollment({ repository: app, github: 'acme/app', base: 'main', contracts }),
  ).rejects.toThrow(
    "Stripe's 2026-04-22.dahlia contract is not saved on this machine yet. Run refit stripe-snapshot --version 2026-04-22.dahlia to save it.",
  );
});

it('gives every reason it cannot generate a configuration, each with its fix', async () => {
  const app = await repository({ lockfile: false });
  const stop = {
    id: 'no-lockfile',
    detail:
      'Refit installs dependencies only from a committed lockfile, and this repository has none at its root.',
    action:
      'Without a committed lockfile Refit cannot install dependencies, so it cannot run the checks on a draft.',
  };
  const report = await inspectRepositoryReadiness({
    repository: app,
    contracts: await directory(),
  });
  expect(report.checks).toEqual([{ ...stop, title: 'Generated configuration', status: 'blocked' }]);
  await expect(
    inspectRepositoryEnrollment({ repository: app, github: 'acme/app', base: 'main' }),
  ).rejects.toMatchObject({
    name: 'EnrollmentStopError',
    stops: [stop],
    message: `${stop.detail} ${stop.action}`,
  });
  // Under owner decision 1 the configuration is generated, so doctor goes on to the contracts.
  const contracts = await directory();
  expect(
    (await inspectRepositoryReadiness({ repository: app, contracts, allowUntested: true })).checks,
  ).toEqual([expect.objectContaining({ id: 'contracts', status: 'blocked' })]);
  await expect(
    inspectRepositoryEnrollment({
      repository: app,
      github: 'acme/app',
      base: 'main',
      contracts,
      allowUntested: true,
    }),
  ).rejects.toThrow("Stripe's 2026-04-22.dahlia contract is not saved on this machine yet.");
  // An uncommitted change is a blocker too, reported with the generation stops.
  await writeFile(join(app, 'src/lib/stripe.ts'), `${CLIENT}// edited\n`);
  expect(
    (
      await inspectRepositoryReadiness({ repository: app, contracts: await directory() })
    ).checks.map((check) => [check.id, check.status]),
  ).toEqual([
    ['repository', 'blocked'],
    ['no-lockfile', 'blocked'],
  ]);
});

it.skipIf(!SAVED)(
  'approves the generated configuration by fingerprint and refuses it once the code moves version',
  async () => {
    const app = await repository();
    const enrollment = await inspectRepositoryEnrollment({
      repository: app,
      github: 'acme/app',
      base: 'main',
      contracts: SAVED,
    });
    expect(enrollment.generated?.apiVersion).toEqual({
      value: '2026-04-22.dahlia',
      source: 'set at src/lib/stripe.ts:3',
    });
    expect(enrollment.files.map((file) => [file.role, file.path])).toEqual([
      ['workflow', '.refit.json'],
      ['baseline', 'refit/stripe-2026-04-22.dahlia.json'],
    ]);
    const review = enrollmentReviewText(enrollment);
    expect(review).toContain(
      'Generated    No .refit.json is committed, so Refit generated one: Stripe API version 2026-04-22.dahlia (set at src/lib/stripe.ts:3), moving to 2026-09-30.endive, checked by the test script in package.json, run with npm.',
    );
    expect(review).toContain('Inputs (the generated .refit.json and saved Stripe contracts)');
    // Nobody pinned the version by hand, so the review does not call it an operator pin.
    expect(review).toContain(
      'stripe: Application API version 2026-04-22.dahlia matches the before contract. Every Stripe client and request override Refit traced sends it.',
    );
    const state = await directory();
    const { approval } = await approveRepositoryEnrollment({
      enrollment,
      fingerprint: enrollment.fingerprint,
      output: join(state, 'approval.json'),
    });
    const loaded = await loadApprovedRepository({
      repository: app,
      approval,
      stateDirectory: state,
      integration: 'stripe',
      contracts: SAVED,
    });
    expect(loaded.fingerprint).toBe(enrollment.fingerprint);
    expect(loaded.workflow).toMatchObject({
      apiVersion: '2026-04-22.dahlia',
      command: ['npm', 'test'],
      prepareDependencies: true,
    });
    expect(loaded.source).toEqual({
      kind: 'file',
      path: join(SAVED!, 'refit/stripe-2026-09-30.endive.json'),
    });
    // The approved baseline is the cached copy of the exact stripe/openapi commit the table pins.
    expect(JSON.parse(await readFile(loaded.workflow.before, 'utf8'))).toMatchObject({
      kind: 'refit-snapshot',
      revision: stripeContractVersion('2026-04-22.dahlia')!.commit,
      hash: stripeContractVersion('2026-04-22.dahlia')!.sha256,
    });
    // The code moves to another version: the generated inputs change, so the approval stops and
    // says what moved.
    const load = () =>
      loadApprovedRepository({
        repository: app,
        approval,
        stateDirectory: state,
        integration: 'stripe',
        contracts: SAVED,
      });
    await writeFile(join(app, 'src/lib/stripe.ts'), CLIENT.replace('2026-04-22', '2026-05-27'));
    await commit(app, 'test: move the pin');
    await expect(load()).rejects.toThrow(
      new RepositoryApprovalError(
        'The configuration Refit generates for this repository changed since it was approved: your code now sends Stripe API version 2026-05-27.dahlia, moving to 2026-09-30.endive. Approve again to run that move.',
      ),
    );
    // A merged Refit draft moves the code to the target.
    await writeFile(
      join(app, 'src/lib/stripe.ts'),
      CLIENT.replace('2026-04-22.dahlia', '2026-09-30.endive'),
    );
    await commit(app, 'test: merge the draft');
    await expect(load()).rejects.toThrow(
      new RepositoryApprovalError(
        'Your code now sends Stripe API version 2026-09-30.endive, the newest Refit has a contract for, so there is nothing to move.',
      ),
    );
  },
);

it.skipIf(!SAVED)(
  'approves a configuration without a lockfile only for a worker that publishes it for review',
  async () => {
    const app = await repository({ lockfile: false });
    const enroll = { repository: app, github: 'acme/app', base: 'main', contracts: SAVED };
    const enrollment = await inspectRepositoryEnrollment({ ...enroll, allowUntested: true });
    expect(enrollment.generated?.reviews.map((stop) => stop.id)).toEqual(['no-lockfile']);
    expect(enrollmentReviewText(enrollment)).toContain(
      'Each draft Refit opens with it is titled [Needs review]: Refit installs dependencies only from a committed lockfile',
    );
    const state = await directory();
    const { approval } = await approveRepositoryEnrollment({
      enrollment,
      fingerprint: enrollment.fingerprint,
      output: join(state, 'approval.json'),
    });
    const load = (allowUntested?: boolean) =>
      loadApprovedRepository({
        repository: app,
        approval,
        stateDirectory: state,
        integration: 'stripe',
        contracts: SAVED,
        allowUntested,
      });
    await expect(load()).rejects.toThrow(
      new RepositoryApprovalError(
        'Repository configuration needs review: Refit installs dependencies only from a committed lockfile, and this repository has none at its root. Without a committed lockfile Refit cannot install dependencies, so it cannot run the checks on a draft.',
      ),
    );
    const loaded = await load(true);
    expect(loaded.fingerprint).toBe(enrollment.fingerprint);
    expect(loaded.workflow).toMatchObject({ command: ['npm', 'test'], prepareDependencies: true });
    // Doctor's dependency check blocks, and decision 1 runs the workflow past it: preparation then
    // fails on the missing lockfile and the patch is published untested.
    const report = await inspectRepositoryReadiness({
      repository: app,
      contracts: SAVED,
      allowUntested: true,
    });
    expect(report.missing).toBeUndefined();
    const sorted = sortBlockedChecks(report);
    expect(sorted.workflow.map((check) => check.id)).toContain('dependencies');
    expect(sorted.setup.map((check) => check.id)).not.toContain('dependencies');
  },
);

// Owner decision 1: two shapes whose version enrollment used to refuse, several pinned versions and
// one it cannot read. Each enrolls only for a worker that publishes for review, and doctor leaves the
// version check to the workflow, which lists the pins in the draft.
const VERSION_SHAPES: {
  files: Record<string, string>;
  apiVersion: string;
  reviews: string[];
  versionCheck: 'blocked' | 'passed';
}[] = [
  {
    files: {
      'src/lib/stripe.ts': CLIENT,
      'app/api/webhooks/stripe/route.ts': `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-10-29.clover' });\nexport const POST = () => stripe.events.list();\n`,
    },
    apiVersion: '2025-10-29.clover',
    reviews: ['api-version-several'],
    versionCheck: 'blocked',
  },
  {
    files: {
      'src/lib/stripe.ts': CLIENT.replace(
        '"2026-04-22.dahlia"',
        'process.env.STRIPE_API_VERSION as Stripe.LatestApiVersion',
      ),
    },
    apiVersion: '2026-04-22.dahlia',
    reviews: ['api-version-unreadable', 'api-version-assumed'],
    versionCheck: 'passed',
  },
];
it.skipIf(!SAVED).each(VERSION_SHAPES)(
  'enrolls code on $reviews only for a worker that publishes it for review',
  async ({ files, apiVersion, reviews, versionCheck }) => {
    const app = await repository({ files });
    const enroll = { repository: app, github: 'acme/app', base: 'main', contracts: SAVED };
    await expect(inspectRepositoryEnrollment(enroll)).rejects.toThrow();
    const enrollment = await inspectRepositoryEnrollment({ ...enroll, allowUntested: true });
    expect(enrollment.generated?.apiVersion.value).toBe(apiVersion);
    expect(enrollment.generated?.reviews.map((stop) => stop.id)).toEqual(reviews);
    expect(enrollmentReviewText(enrollment)).toContain(
      'Each draft Refit opens with it is titled [Needs review]: ',
    );
    const state = await directory();
    const { approval } = await approveRepositoryEnrollment({
      enrollment,
      fingerprint: enrollment.fingerprint,
      output: join(state, 'approval.json'),
    });
    const load = (allowUntested?: boolean) =>
      loadApprovedRepository({
        repository: app,
        approval,
        stateDirectory: state,
        integration: 'stripe',
        contracts: SAVED,
        allowUntested,
      });
    await expect(load()).rejects.toThrow(RepositoryApprovalError);
    expect((await load(true)).workflow).toMatchObject({ apiVersion });
    const report = await inspectRepositoryReadiness({
      repository: app,
      contracts: SAVED,
      allowUntested: true,
    });
    expect(report.checks.find((check) => check.id === 'api-version')?.status).toBe(versionCheck);
    expect(sortBlockedChecks(report).setup.map((check) => check.id)).not.toContain('api-version');
  },
);

it.skipIf(!SAVED)(
  'shows the generated .refit.json and says to commit it before changing its settings',
  async () => {
    const app = await repository();
    // Two lockfiles, as in Ankit-Sharma1011/Quill, which commits package-lock.json and pnpm-lock.yaml.
    await writeFile(join(app, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    await commit(app, 'test: add a second lockfile');
    const report = await inspectRepositoryReadiness({ repository: app, contracts: SAVED });
    expect(report.generated?.configuration).toMatchObject({
      formatVersion: 2,
      integrations: [{ id: 'stripe', apiVersion: '2026-04-22.dahlia', command: ['pnpm', 'test'] }],
    });
    const rendered = renderReadiness(report);
    expect(rendered).toContain(
      'Configuration  generated, because this repository commits no .refit.json\n',
    );
    expect(rendered).not.toContain('operator pin');
    expect(report.checks.find((check) => check.id === 'sdk-version')).toMatchObject({
      status: 'review',
      detail:
        'Refit cannot tell which stripe release package.json (^22.1.1) installs: Multiple package-manager lockfiles require explicit review; no effective graph is assumed.',
    });
    const dependencies = report.checks.find((check) => check.id === 'dependencies');
    expect(dependencies?.status).toBe('blocked');
    expect(dependencies?.action).toMatch(
      /^Make the change the message names in the repository and commit it, or: In \.refit\.json, .* This repository commits no \.refit\.json, so Refit uses the one it generated \(refit doctor --json prints it as generated\.configuration\), with the contracts for \S+ and \S+\.$/,
    );
  },
);
