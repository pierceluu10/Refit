import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { stripeContractVersion } from './enrollment-contracts.ts';
import { enrollmentReviewText } from './enrollment-review.ts';
import { inspectRepositoryReadiness } from './readiness.ts';
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

async function repository(options: { lockfile?: boolean } = {}) {
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
  await writeFile(join(root, 'src/lib/stripe.ts'), CLIENT);
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
    action: 'Run npm install, pnpm install or yarn install once and commit the lockfile it writes.',
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
    // The code moves to another version: the generated inputs change, so the approval stops.
    await writeFile(join(app, 'src/lib/stripe.ts'), CLIENT.replace('2026-04-22', '2026-05-27'));
    await commit(app, 'test: move the pin');
    await expect(
      loadApprovedRepository({
        repository: app,
        approval,
        stateDirectory: state,
        integration: 'stripe',
        contracts: SAVED,
      }),
    ).rejects.toThrow(RepositoryApprovalError);
  },
);
