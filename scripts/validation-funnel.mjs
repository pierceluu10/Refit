#!/usr/bin/env node
// Where affected Stripe repositories leave the validation path, from a benchmark results.json:
// each affected row is placed at the first stage it did not pass, validated rows are counted by
// evidence grade (A to D), and rows without a check by whether they kept a grade-D patch.
// Usage: node scripts/validation-funnel.mjs <results.json> [--json]
import { readFileSync } from 'node:fs';

// Generated checks run only after the baseline and patched checks passed (pipeline/validation.ts),
// so a row lost to a missing stripe-mock image passed both.
const MISSING_STRIPE_MOCK = /No such image: stripe\/stripe-mock/;
const CHECK_TIMEOUT = /Check exceeded \d+ seconds/;

// Preparation refusals by the message Refit raises, most specific first.
export const PREPARATION_GROUPS = [
  ['dependency-archive-limit', /^Dependency archive exceeds \d+ MiB/],
  ['workspace-out-of-space', /dependency preparation ran out of space in its \w+ workspace/],
  ['source-archive-limit', /^Committed source exceeds the \d+ MiB validation archive limit/],
  ['submodule', /^Validation does not accept submodules/],
  ['no-lockfile', /^The repository commits package\.json without a lockfile/],
  [
    'lockfile-out-of-sync',
    /differ from the committed package-lock\.json|importer specifiers differ from committed manifests|overrides differ from the overrides pnpm-lock\.yaml records|^npm dependency preparation failed[\s\S]*\bin sync\b|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH/,
  ],
  [
    'non-registry-source',
    /supports public npm registry dependencies only|must use public registry|Package tarballs must use public registry|reads a bun\.lock only when every package is a public registry package|codeload\.github\.com|\bgit\+|github:/,
  ],
  [
    'lockfile-integrity',
    /without a version, registry "resolved" URL and SHA-256-or-stronger "integrity"|needs a registry name\/version and SHA-256-or-stronger integrity|Every npm package requires a registry URL/,
  ],
  ['conflicting-lockfiles', /commits [\w.-]+ and [\w.-]+; keep only the lockfile/],
  [
    'tracked-node-modules-or-hooks',
    /^Tracked node_modules, conflicting lockfiles, shrinkwrap or pnpm hooks/,
  ],
  ['unsupported-pnpm-settings', /^Unsupported pnpm (?:lockfile )?settings/],
  [
    'unsupported-workspace-layout',
    /^Workspace bins, nested workspace declarations|^npm workspaces require at most \d+ positive relative/,
  ],
  ['unsupported-lockfile', /requires a root npm lockfile version 2 or 3/],
  ['peer-dependency-conflict', /\bERESOLVE\b/],
  ['install-timeout', /^Dependency preparation exceeded \d+ seconds/],
];

export const STAGES = [
  'scan-stop',
  'preparation-refused',
  'no-runnable-check',
  'baseline-failed',
  'check-timeout',
  'check-error',
  'patched-failed',
  'generated-check-infrastructure',
  'other-infrastructure',
  'validated',
];

export function preparationGroup(message) {
  return PREPARATION_GROUPS.find(([, pattern]) => pattern.test(message))?.[0] ?? 'other';
}

// The summaries pipeline/dependency-preparation.ts gives an untested patch's failed preparation,
// for rows from runs that recorded only the grade reason.
const DEPENDENCY_SUMMARIES = [
  ['no-lockfile', 'the repository has no committed lockfile'],
  ['lockfile-out-of-sync', 'the committed lockfile is out of sync with package.json'],
  ['lockfile-integrity', 'lockfile entries have no registry integrity hash'],
  [
    'peer-dependency-conflict',
    "npm rejects the committed lockfile's conflicting peer dependencies",
  ],
  [
    'dependency-archive-limit',
    "the installed dependencies exceed Refit's validation sandbox limit",
  ],
];
const UNPREPARED = 'Dependencies could not be prepared, so no check ran: ';

function untestedPreparation(workflow) {
  if (workflow.validation !== 'untested') return undefined;
  if (workflow.dependencyFailure) return preparationGroup(workflow.dependencyFailure.message ?? '');
  const reason = workflow.grade?.reason ?? '';
  if (!reason.startsWith(UNPREPARED)) return undefined;
  const summary = reason.slice(UNPREPARED.length);
  return DEPENDENCY_SUMMARIES.find(([, text]) => summary.startsWith(text))?.[0] ?? 'other';
}

// The first stage an affected row did not pass, with the detail behind it.
export function funnelStage(row) {
  const workflow = row.workflow;
  const missingMock = MISSING_STRIPE_MOCK.test(row.infrastructure?.message ?? '');
  if (row.outcomeClass === 'infrastructure' && !missingMock)
    return { stage: 'other-infrastructure', detail: row.infrastructure?.kind };
  // Owner decision 1: a project without a lockfile still runs the workflow and keeps its patch.
  if (row.checks === 'none' && workflow?.stage !== 'scan')
    return {
      stage: 'preparation-refused',
      detail: row.packageManager === 'none' ? 'no-lockfile' : 'stripe-outside-root-package',
      patch: Boolean(workflow?.diff),
    };
  // A repository no check can run in (`generated-only`; older runs checked it with `node -e 0`).
  const noCheck = row.checks === 'generated-only';
  if (!workflow)
    return noCheck
      ? { stage: 'no-runnable-check', detail: row.checkSelection?.reason }
      : { stage: 'not-validated' };
  if (workflow.stage === 'scan') return { stage: 'scan-stop' };
  if (noCheck)
    return {
      stage: 'no-runnable-check',
      detail: row.checkSelection?.reason,
      patch: Boolean(workflow.diff),
    };
  if (workflow.status === 'error' && !workflow.validation && !missingMock) {
    const message = workflow.error ?? workflow.reason ?? '';
    return { stage: 'preparation-refused', detail: preparationGroup(message), message };
  }
  // Owner decision 1: failed preparation keeps the patch untested, graded D.
  const unprepared = untestedPreparation(workflow);
  if (unprepared) return { stage: 'preparation-refused', detail: unprepared, patch: true };
  if (missingMock) return { stage: 'generated-check-infrastructure', detail: row.checks };
  if (workflow.validation === 'baseline-failed')
    return { stage: 'baseline-failed', detail: workflow.baselineStop };
  if (workflow.validation === 'error') {
    const errors = [workflow.checkErrors?.baseline, workflow.checkErrors?.patched].filter(Boolean);
    return errors.some((error) => CHECK_TIMEOUT.test(error))
      ? { stage: 'check-timeout' }
      : { stage: 'check-error', detail: errors.join(' | ') || undefined };
  }
  if (workflow.validation === 'regression') return { stage: 'patched-failed' };
  // An unavailable generated type check without tests: no check ran, and the patch is kept.
  if (workflow.validation === 'untested' && workflow.typeCheckUnavailable)
    return { stage: 'no-runnable-check', detail: workflow.typeCheckUnavailable, patch: true };
  if (workflow.validation === 'passed')
    return {
      stage: 'validated',
      detail: workflow.grade?.letter ?? workflow.grade?.level ?? 'ungraded',
    };
  return { stage: 'other', detail: workflow.validation ?? workflow.status };
}

export function funnel(rows) {
  const affected = rows.filter((row) => row.fullAdapter?.confirmed > 0);
  const placed = affected.map((row) => ({ repo: row.repo, ...funnelStage(row) }));
  const count = (key) =>
    Object.fromEntries(
      Object.entries(
        placed.reduce((counts, row) => {
          const value = key(row);
          if (value) counts[value] = (counts[value] ?? 0) + 1;
          return counts;
        }, {}),
      ).sort(([, left], [, right]) => right - left),
    );
  return {
    rows: rows.length,
    affected: affected.length,
    stages: count((row) => row.stage),
    preparation: count((row) => (row.stage === 'preparation-refused' ? row.detail : undefined)),
    preparationPatch: count((row) =>
      row.stage === 'preparation-refused' ? (row.patch ? 'D, patch kept' : 'no patch') : undefined,
    ),
    grades: count((row) => (row.stage === 'validated' ? row.detail : undefined)),
    // Grade D without a check: the patch is kept for a [Needs review] draft, or none was proposed.
    noCheck: count((row) =>
      row.stage === 'no-runnable-check' ? (row.patch ? 'D, patch kept' : 'no patch') : undefined,
    ),
    repositories: placed,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, flag] = process.argv.slice(2);
  if (!path) throw new Error('Usage: node scripts/validation-funnel.mjs <results.json> [--json]');
  const result = funnel(JSON.parse(readFileSync(path, 'utf8')));
  if (flag === '--json') console.log(JSON.stringify(result, null, 2));
  else {
    const table = (title, counts) =>
      [`| ${title} | Repositories |`, '| --- | ---: |']
        .concat(Object.entries(counts).map(([name, value]) => `| ${name} | ${value} |`))
        .join('\n');
    console.log(`${result.affected} affected of ${result.rows} rows\n`);
    console.log(`${table('Stage', result.stages)}\n`);
    console.log(`${table('Preparation refused', result.preparation)}\n`);
    console.log(`${table('Preparation refused, patch', result.preparationPatch)}\n`);
    console.log(`${table('Validated, by evidence grade', result.grades)}\n`);
    console.log(table('No runnable check', result.noCheck));
  }
}
