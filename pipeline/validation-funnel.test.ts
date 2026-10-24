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
    repo: 'graded/none',
    checks: 'typecheck',
    workflow: {
      status: 'published',
      stage: 'validation',
      validation: 'passed',
      grade: { level: 'none', reason: 'tsc reaches none of the changed code.' },
    },
  },
  {
    ...affected,
    repo: 'graded/tests',
    checks: 'tests',
    workflow: { status: 'published', validation: 'passed', grade: { level: 'stripe-tests' } },
  },
  { ...affected, repo: 'no-check/app', checks: 'generated-only', checkSelection: { reason: 'x' } },
];

it('places each affected repository at the first stage it did not pass', () => {
  const result = funnel(ROWS);
  console.log(JSON.stringify(result.stages));
  expect(result).toMatchObject({ rows: 10, affected: 9 });
  expect(Object.fromEntries(result.repositories.map((row) => [row.repo, row.stage]))).toEqual({
    'horizon-ui/shadcn-nextjs-boilerplate': 'preparation-refused',
    'nizzyabi/nizzy-starter': 'preparation-refused',
    '4NDR3S-01/StyleHub': 'baseline-failed',
    'beindigital-products/wedillybird': 'check-timeout',
    'Kanba-co/kanba': 'patched-failed',
    'get-convex/convex-saas': 'generated-check-infrastructure',
    'graded/none': 'no-runnable-check',
    'graded/tests': 'validated',
    'no-check/app': 'no-runnable-check',
  });
  expect(result.preparation).toEqual({ 'no-lockfile': 1, 'dependency-archive-limit': 1 });
  expect(result.grades).toEqual({ 'stripe-tests': 1 });
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
