import { expect, it } from 'vitest';
import { funnel, preparationGroup } from '../scripts/validation-funnel.mjs';

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
  expect(preparationGroup('something new')).toBe('other');
});
