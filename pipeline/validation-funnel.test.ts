import { expect, it } from 'vitest';
import { blockerCensus, funnel, preparationGroup } from '../scripts/validation-funnel.mjs';

const affected = { fullAdapter: { confirmed: 1 } };
const failed = (validation: string) => ({
  status: 'validation-failed',
  stage: 'validation',
  validation,
  reason: `Validation returned ${validation}; publication was not attempted.`,
});

// Shapes and messages from rows of Actions run 40077373087 (main at fc4dc00).
const ROWS = [
  { repo: 'unaffected/app', fullAdapter: { confirmed: 0 }, checks: 'tests' },
  {
    ...affected,
    repo: 'horizon-ui/shadcn-nextjs-boilerplate',
    checks: 'none',
    packageManager: 'none',
  },
  {
    ...affected,
    repo: 'nizzyabi/nizzy-starter',
    checks: 'typecheck',
    packageManager: 'npm',
    workflow: {
      status: 'error',
      stage: 'validation',
      error:
        'Dependency archive exceeds 1024 MiB. An operator can set REFIT_VALIDATION_WORKSPACE=4g (up to a 2 GiB archive and 5 GiB container memory) for a larger tree.',
    },
  },
  { ...affected, repo: '4NDR3S-01/StyleHub', checks: 'tests', workflow: failed('baseline-failed') },
  {
    ...affected,
    repo: 'beindigital-products/wedillybird',
    checks: 'tests',
    workflow: {
      ...failed('error'),
      checkErrors: { baseline: 'Check exceeded 120 seconds; the container was stopped.' },
    },
  },
  { ...affected, repo: 'Kanba-co/kanba', checks: 'typecheck', workflow: failed('regression') },
  {
    ...affected,
    repo: 'get-convex/convex-saas',
    checks: 'typecheck',
    outcomeClass: 'infrastructure',
    infrastructure: {
      kind: 'docker',
      message: 'Error response from daemon: No such image: stripe/stripe-mock:latest',
    },
    workflow: {
      status: 'error',
      stage: 'validation',
      error: 'Command failed: docker image inspect',
    },
  },
  {
    ...affected,
    repo: 'graded/d',
    checks: 'typecheck',
    workflow: {
      status: 'needs-review',
      stage: 'validation',
      validation: 'passed',
      grade: { letter: 'D', level: 'none', reason: 'The type check does not cover api/pay.js.' },
    },
  },
  {
    ...affected,
    repo: 'graded/b',
    checks: 'tests',
    workflow: {
      status: 'published',
      validation: 'passed',
      grade: { letter: 'B', level: 'stripe-tests' },
    },
  },
  // Before check selection, a repository without checks ran `node -e 0` and stopped or passed.
  { ...affected, repo: 'no-check/old', checks: 'generated-only', checkSelection: { reason: 'x' } },
  {
    ...affected,
    repo: 'no-check/stopped',
    checks: 'generated-only',
    workflow: { status: 'needs-review', stage: 'scan', reason: 'A traced SDK request...' },
  },
  {
    ...affected,
    repo: 'no-check/kept',
    checks: 'generated-only',
    checkSelection: { reason: 'There is no test script; no file imports stripe.' },
    workflow: {
      status: 'needs-review',
      stage: 'checks',
      diff: 'diff --git a/server.js b/server.js',
      grade: { letter: 'D', level: 'none', reason: 'There is no test script.' },
    },
  },
];

it('places each affected repository at the first stage it did not pass', () => {
  const result = funnel(ROWS);
  expect(result).toMatchObject({ rows: 12, affected: 11 });
  expect(Object.fromEntries(result.repositories.map((row) => [row.repo, row.stage]))).toEqual({
    'horizon-ui/shadcn-nextjs-boilerplate': 'preparation-refused',
    'nizzyabi/nizzy-starter': 'preparation-refused',
    '4NDR3S-01/StyleHub': 'baseline-failed',
    'beindigital-products/wedillybird': 'check-timeout',
    'Kanba-co/kanba': 'patched-failed',
    'get-convex/convex-saas': 'generated-check-infrastructure',
    'graded/d': 'validated',
    'graded/b': 'validated',
    'no-check/old': 'no-runnable-check',
    'no-check/stopped': 'scan-stop',
    'no-check/kept': 'no-runnable-check',
  });
  expect(result.preparation).toEqual({ 'no-lockfile': 1, 'dependency-archive-limit': 1 });
  // Validated rows by letter; rows without a check keep a grade-D patch or have none.
  expect(result.grades).toEqual({ D: 1, B: 1 });
  expect(result.noCheck).toEqual({ 'no patch': 1, 'D, patch kept': 1 });
});

it('groups preparation refusals by the message Refit raises', () => {
  expect(preparationGroup('Validation does not accept submodules (vendor/lib).')).toBe('submodule');
  expect(
    preparationGroup(
      'npm dependency preparation failed: `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
    ),
  ).toBe('lockfile-out-of-sync');
  // Messages from untested drafts of run 40236299492 (main 179c6bc).
  expect(
    preparationGroup(
      'The repository commits package.json without a lockfile, so the dependency versions to verify are unknown.',
    ),
  ).toBe('no-lockfile');
  expect(
    preparationGroup(
      'pnpm overrides differ from the overrides pnpm-lock.yaml records. Run pnpm install and commit the updated pnpm-lock.yaml.',
    ),
  ).toBe('lockfile-out-of-sync');
  expect(
    preparationGroup(
      'pnpm dependency preparation failed (1). ERR_PNPM_LOCKFILE_CONFIG_MISMATCH Cannot proceed with the frozen installation.',
    ),
  ).toBe('lockfile-out-of-sync');
  expect(
    preparationGroup(
      'Automatic preparation reads a bun.lock only when every package is a public registry package with integrity, laid out for a single root project.',
    ),
  ).toBe('non-registry-source');
  expect(
    preparationGroup(
      'Unsupported pnpm lockfile settings, patches or graph metadata require a custom image.',
    ),
  ).toBe('unsupported-pnpm-settings');
  expect(
    preparationGroup(
      'Workspace bins, nested workspace declarations and workspace pnpm settings require a custom validation image.',
    ),
  ).toBe('unsupported-workspace-layout');
  expect(
    preparationGroup(
      'npm workspaces require at most 64 positive relative path/glob patterns. Negations, escaping paths and object declarations other than { packages: [...] } require a custom image.',
    ),
  ).toBe('unsupported-workspace-layout');
  expect(preparationGroup('something new')).toBe('other');
});

// Owner decision 1 keeps a patch untested, graded D, when preparation fails. Shapes from rows of
// Laptop 1's run 40236299492 (main 179c6bc), which recorded only the grade reason, and from rows
// that record the dependency failure itself.
const unprepared = (summary: string, extra: object = {}) => ({
  status: 'needs-review',
  stage: 'validation',
  validation: 'untested',
  diff: 'diff --git a/app/api/checkout/route.ts b/app/api/checkout/route.ts',
  grade: {
    letter: 'D',
    level: 'none',
    reason: `Dependencies could not be prepared, so no check ran: ${summary}`,
  },
  ...extra,
});

it('places untested patches at the preparation refusal that kept them untested', () => {
  const result = funnel([
    {
      ...affected,
      repo: 'odota/core',
      checks: 'tests',
      workflow: unprepared('lockfile entries have no registry integrity hash'),
    },
    {
      ...affected,
      repo: 'karljuhl/Club_Connect',
      checks: 'typecheck',
      workflow: unprepared('Refit could not install them in its sandbox'),
    },
    {
      ...affected,
      repo: 'shagunmistry/FlowCraft',
      checks: 'tests',
      workflow: unprepared('the committed lockfile is out of sync with package.json', {
        dependencyFailure: {
          reason: 'lockfile-out-of-sync',
          message:
            'package.json dependencies differ from the committed package-lock.json: next is "15.3.6" in package.json but "15.3.0" in the lockfile.',
        },
      }),
    },
    {
      ...affected,
      repo: 'LucasKlemke/doctor-reborn',
      checks: 'typecheck',
      workflow: unprepared('Refit could not install them in its sandbox', {
        dependencyFailure: {
          reason: 'preparation-failed',
          message:
            'Tracked node_modules, conflicting lockfiles, shrinkwrap or pnpm hooks require a custom validation image. The repository commits package-lock.json and pnpm-lock.yaml; keep only the lockfile of the package manager you use.',
        },
      }),
    },
    // A project without a lockfile runs the workflow too; a scan stop still comes first.
    {
      ...affected,
      repo: 'horizon-ui/shadcn-nextjs-boilerplate',
      checks: 'none',
      packageManager: 'none',
      workflow: unprepared('the repository has no committed lockfile'),
    },
    {
      ...affected,
      repo: 'aionarae/amazon-beta',
      checks: 'none',
      packageManager: 'none',
      workflow: { status: 'needs-review', stage: 'scan', reason: 'A traced SDK request...' },
    },
  ]);
  expect(
    Object.fromEntries(result.repositories.map((row) => [row.repo, row.detail ?? row.stage])),
  ).toEqual({
    'odota/core': 'lockfile-integrity',
    'karljuhl/Club_Connect': 'other',
    'shagunmistry/FlowCraft': 'lockfile-out-of-sync',
    'LucasKlemke/doctor-reborn': 'conflicting-lockfiles',
    'horizon-ui/shadcn-nextjs-boilerplate': 'no-lockfile',
    'aionarae/amazon-beta': 'scan-stop',
  });
  expect(result.stages).toEqual({ 'preparation-refused': 5, 'scan-stop': 1 });
  expect(result.preparationPatch).toEqual({ 'D, patch kept': 5 });
});

// Shapes from rows of Actions run 40609750399 (blefnk/all-in-one-nextjs-template, duggal1/flux-io).
it('lists every blocker on a row and counts rows where it is the only one', () => {
  const dropped =
    'The target API version no longer accepts this request parameter, and no reviewed replacement exists; removing or replacing it changes request behavior. The owner-approved rename to allowed_payment_method_types applies to this value, but the stripe package cannot be upgraded to a release whose types have allowed_payment_method_types: Only root npm, pnpm or Yarn 1 projects are upgraded.';
  const untraced =
    'Receiver or property cannot be proven by the supported local analysis; inspect manually.';
  const census = blockerCensus(
    [
      {
        ...affected,
        repo: 'blefnk/all-in-one-nextjs-template',
        checks: 'none',
        packageManager: 'none',
        workflow: {
          status: 'needs-review',
          stage: 'validation',
          validation: 'untested',
          sdkUpgrade: { skipped: 'Only root npm, pnpm or Yarn 1 projects are upgraded.' },
          waivedGates: ['dependency-preparation', 'removed-request-parameter', 'contract-changes'],
        },
      },
      {
        ...affected,
        repo: 'duggal1/flux-io',
        checks: 'typecheck',
        workflow: {
          ...unprepared('the committed lockfile is out of sync with package.json'),
          sdkUpgrade: { from: '16.7.0', to: '23.0.0' },
          typeOracle: { patched: { status: 'compared', count: 0, introduced: [] } },
        },
      },
      {
        ...affected,
        repo: 'tmachnacki/podvex',
        checks: 'typecheck',
        workflow: {
          status: 'needs-review',
          stage: 'validation',
          validation: 'passed',
          sdkUpgrade: { skipped: 'stripe 23.0.0 is already locked.' },
          typeOracle: {
            patched: {
              count: 1,
              introduced: [{ code: 'TS2339', file: 'a.ts', line: 3 }],
            },
          },
          grade: { letter: 'C' },
        },
      },
      {
        ...affected,
        repo: 'afdon/music-app',
        checks: 'typecheck',
        workflow: {
          status: 'needs-review',
          stage: 'validation',
          validation: 'passed',
          grade: { letter: 'C' },
        },
      },
      {
        ...affected,
        repo: 'KPZ231/what-now-chaos',
        checks: 'tests',
        workflow: {
          status: 'needs-review',
          stage: 'validation',
          validation: 'passed',
          grade: { letter: 'D', reason: 'No test reaches src/app/api/checkout/route.js.' },
        },
      },
      {
        ...affected,
        repo: 'CiphersLab/SaaSPilot',
        checks: 'typecheck',
        productionMode: { reviewReasons: { [untraced]: 1 } },
        workflow: {
          status: 'validated',
          stage: 'validation',
          validation: 'passed',
          grade: { letter: 'C' },
        },
      },
    ],
    new Map([
      ['afdon/music-app', { validation: { repair: { keptProperties: ['trial_from_plan'] } } }],
      [
        'blefnk/all-in-one-nextjs-template',
        {
          findings: [
            {
              confidence: 'confirmed',
              reason: dropped,
              requestParameter: { parameter: 'payment_method_types' },
            },
            { confidence: 'review', reason: untraced },
            { confidence: 'confirmed', reason: 'A moved field the rules migrate.' },
          ],
        },
      ],
    ]),
  );
  expect(
    Object.fromEntries(
      census.repositories.map((row) => [row.repo, row.blockers.map((entry) => entry.blocker)]),
    ),
  ).toEqual({
    'blefnk/all-in-one-nextjs-template': [
      'no-lockfile',
      'stripe-upgrade-refused-other',
      'pmt-rename-dropped-stripe-upgrade',
      'untraced-reads',
      'contract-change',
    ],
    'duggal1/flux-io': ['lockfile-out-of-sync'],
    'tmachnacki/podvex': ['new-type-errors-after-upgrade'],
    'afdon/music-app': ['kept-untyped-property'],
    'KPZ231/what-now-chaos': ['checks-miss-changed-code'],
    'CiphersLab/SaaSPilot': [],
  });
  expect(census.blockers['lockfile-out-of-sync']).toEqual({
    rows: 1,
    only: 1,
    repos: ['duggal1/flux-io'],
  });
  expect(census.blockers['no-lockfile']).toMatchObject({ rows: 1, only: 0 });
  expect(census.unblocked).toBe(1);
});
