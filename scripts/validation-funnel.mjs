#!/usr/bin/env node
// Where affected Stripe repositories leave the validation path, from a benchmark results.json:
// each affected row is placed at the first stage it did not pass, validated rows are counted by
// evidence grade (A to D), and rows without a check by whether they kept a grade-D patch.
// With --all-blockers it lists every blocker on each affected row instead, reading each row's
// report.json.gz from downloaded shard artifacts (--artifacts <dir>) for causes results.json lacks.
// Usage: node scripts/validation-funnel.mjs <results.json> [--json] [--all-blockers [--artifacts <dir>]]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

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

// Every blocker category, in table order. Preparation groups fold into the dependency lanes.
export const BLOCKERS = [
  'source-archive-limit',
  'dependency-tree-too-large',
  'no-lockfile',
  'lockfile-out-of-sync',
  'lockfile-integrity',
  'non-registry-source',
  'conflicting-dependency-files',
  'unsupported-lockfile-or-workspace',
  'stripe-outside-root-package',
  'peer-dependency-conflict',
  'install-timeout',
  'submodule',
  'preparation-other',
  'stripe-upgrade-refused-peer',
  'stripe-upgrade-refused-dependency-changes',
  'stripe-upgrade-refused-other',
  'new-type-errors-after-upgrade',
  'baseline-failed-prisma-client',
  'baseline-failed-next-env',
  'baseline-failed-other',
  'no-runnable-check',
  'check-timeout',
  'check-error',
  'patched-check-failed',
  'pmt-rename-dropped-api-version-kept',
  'pmt-rename-dropped-configured-migration',
  'pmt-rename-dropped-unresolved-api-version',
  'pmt-rename-dropped-no-literal-pin',
  'pmt-rename-dropped-stripe-upgrade',
  'pmt-rename-dropped-other',
  'pmt-outside-creation-call',
  'removed-request-parameter-other',
  'untraced-api-version',
  'api-version-default',
  'api-version-unconfirmed',
  'api-version-kept',
  'contract-change',
  'untraced-reads',
  'source-evidence-other',
  'webhook-version',
  'ai-patch-review',
  'infrastructure',
  'no-patch',
];

const PREPARATION_BLOCKERS = {
  'dependency-archive-limit': 'dependency-tree-too-large',
  'workspace-out-of-space': 'dependency-tree-too-large',
  'conflicting-lockfiles': 'conflicting-dependency-files',
  'tracked-node-modules-or-hooks': 'conflicting-dependency-files',
  'unsupported-pnpm-settings': 'unsupported-lockfile-or-workspace',
  'unsupported-workspace-layout': 'unsupported-lockfile-or-workspace',
  'unsupported-lockfile': 'unsupported-lockfile-or-workspace',
  other: 'preparation-other',
};
// stripePackageUpgrade() refusals (pipeline/stripe-package-upgrade.ts).
const UPGRADE_PEER = /^stripe \S+ needs .+, which .+ does not provide; upgrade it first\.$/;
const UPGRADE_DEPENDENCIES = /^stripe \S+ needs dependency changes/;
const UPGRADE_NOOP = /^stripe \S+ is already (?:declared|locked)\.$/;
// The two generated-file causes of docs/PREPARATION-FAILURES.md.
const PRISMA = /@prisma\/client|PrismaClient|prisma generate/i;
const NEXT_ENV = /next-env\.d\.ts|Cannot find module '[^']+\.(?:svg|png|jpe?g|gif|webp|ico|avif)'/;
// The gate pipeline/run.ts appends to a removed payment_method_types the card rename covered (F2).
const RENAME_DROPPED =
  /The owner-approved rename to allowed_payment_method_types applies to this value, but (.+)\.$/;
const RENAME_GATES = [
  ['pmt-rename-dropped-api-version-kept', /^the patch that moved the API version failed/],
  ['pmt-rename-dropped-configured-migration', /^this patch applies a configured migration/],
  ['pmt-rename-dropped-unresolved-api-version', /^Refit cannot resolve the API version/],
  ['pmt-rename-dropped-no-literal-pin', /^no client pins a literal apiVersion/],
  ['pmt-rename-dropped-stripe-upgrade', /^the stripe package cannot be upgraded/],
];
// analyzer.ts: a removed parameter in an object no traced call receives.
const OUTSIDE_CALL =
  /^This object sets a request parameter the target API version removed, but Refit cannot trace it/;
const REMOVED_PARAMETER = /^The target API version no longer accepts this request parameter/;
const UNTRACED_READ =
  /cannot be proven by the supported local analysis|could not trace to an SDK response/;
const WEBHOOK = /Incoming webhook API version|webhook payload|webhook endpoint/i;
const GATE_BLOCKERS = {
  'api-version-untraced': 'untraced-api-version',
  'api-version-default': 'api-version-default',
  'api-version': 'api-version-unconfirmed',
  'api-version-kept': 'api-version-kept',
  'contract-changes': 'contract-change',
  'webhook-api-version': 'webhook-version',
  'ai-patch': 'ai-patch-review',
  submodules: 'submodule',
};

// The blocker a finding's reason names, with the part of the reason that says so.
function reasonBlocker(reason) {
  const dropped = RENAME_DROPPED.exec(reason);
  if (dropped)
    return [
      RENAME_GATES.find(([, pattern]) => pattern.test(dropped[1]))?.[0] ??
        'pmt-rename-dropped-other',
      dropped[1],
    ];
  if (OUTSIDE_CALL.test(reason)) return ['pmt-outside-creation-call', reason];
  if (REMOVED_PARAMETER.test(reason) || /removed request parameter/i.test(reason))
    return ['removed-request-parameter-other', reason];
  if (WEBHOOK.test(reason)) return ['webhook-version', reason];
  if (UNTRACED_READ.test(reason)) return ['untraced-reads', reason];
  return ['source-evidence-other', reason];
}

// Findings that still stop a row, from its report (full reasons) or else productionMode's counts.
function findingReasons(row, report) {
  if (report?.findings)
    return report.findings
      .filter(
        (finding) =>
          finding.requestParameter ||
          finding.confidence === 'review' ||
          (finding.webhook && !finding.webhook.migration),
      )
      .map((finding) =>
        finding.requestParameter && OUTSIDE_CALL.test(finding.reason)
          ? finding.requestParameter.parameter === 'payment_method_types'
            ? finding.reason
            : 'removed request parameter outside a traced body'
          : finding.reason,
      );
  return Object.keys(row.productionMode?.reviewReasons ?? {});
}

// Every blocker on one affected row, each with what recorded it; `[]` for a clean validation.
export function rowBlockers(row, report) {
  const found = new Map();
  const add = (blocker, evidence) => {
    if (!found.has(blocker)) found.set(blocker, evidence);
  };
  const workflow = row.workflow ?? {};
  const placed = funnelStage(row);
  if (placed.stage === 'preparation-refused') {
    const group = placed.detail ?? 'other';
    add(
      PREPARATION_BLOCKERS[group] ?? group,
      (
        placed.message ??
        workflow.dependencyFailure?.message ??
        workflow.grade?.reason ??
        group
      ).slice(0, 300),
    );
  }
  const upgrade = workflow.sdkUpgrade ?? report?.patch?.sdkUpgrade;
  if (upgrade?.skipped && !UPGRADE_NOOP.test(upgrade.skipped))
    add(
      UPGRADE_PEER.test(upgrade.skipped)
        ? 'stripe-upgrade-refused-peer'
        : UPGRADE_DEPENDENCIES.test(upgrade.skipped)
          ? 'stripe-upgrade-refused-dependency-changes'
          : 'stripe-upgrade-refused-other',
      upgrade.skipped,
    );
  const oracle = workflow.typeOracle ?? report?.validation?.typeOracle;
  if (oracle?.patched?.count > 0)
    add(
      'new-type-errors-after-upgrade',
      oracle.patched.introduced
        ?.slice(0, 3)
        .map((error) => `${error.code} ${error.file}:${error.line}`)
        .join('; ') ?? `${oracle.patched.count} errors`,
    );
  if (placed.stage === 'baseline-failed') {
    const failures = (workflow.checkFailures ?? []).filter(
      (failure) => failure.side === 'baseline',
    );
    const text = [
      placed.detail,
      ...failures.map((failure) => failure.firstFailure),
      ...((workflow.typeErrors?.baseline ?? []).map?.((error) => error.message ?? error) ?? []),
      report?.validation?.baseline?.output,
    ]
      .filter((value) => typeof value === 'string')
      .join('\n');
    add(
      PRISMA.test(text)
        ? 'baseline-failed-prisma-client'
        : NEXT_ENV.test(text)
          ? 'baseline-failed-next-env'
          : 'baseline-failed-other',
      text.slice(0, 300) || 'not recorded',
    );
  }
  const stageBlockers = {
    'no-runnable-check': 'no-runnable-check',
    'check-timeout': 'check-timeout',
    'check-error': 'check-error',
    'generated-check-infrastructure': 'infrastructure',
    'other-infrastructure': 'infrastructure',
  };
  if (stageBlockers[placed.stage])
    add(stageBlockers[placed.stage], String(placed.detail ?? placed.stage).slice(0, 300));
  if (placed.stage === 'patched-failed' && !found.has('new-type-errors-after-upgrade'))
    add(
      'patched-check-failed',
      (workflow.checkFailures ?? [])
        .filter((failure) => failure.side === 'patched')
        .map((failure) => failure.firstFailure)
        .join(' | ') || 'not recorded',
    );
  for (const reason of findingReasons(row, report)) {
    const [blocker, evidence] = reasonBlocker(reason);
    add(blocker, evidence.slice(0, 300));
  }
  for (const gate of workflow.waivedGates ?? [])
    if (GATE_BLOCKERS[gate]) add(GATE_BLOCKERS[gate], `gate ${gate}`);
  // Rows that never reached a draft record reached contract changes only in productionMode.
  if (!workflow.waivedGates && row.productionMode?.unmappedChanges > 0)
    add(
      'contract-change',
      `${row.productionMode.unmappedChanges} unmapped: ${[...new Set(row.productionMode.unmapped?.map((change) => change.id))].join(', ')}`,
    );
  if (placed.stage === 'scan-stop' && !workflow.diff)
    add('no-patch', (workflow.reason ?? row.productionMode?.stop ?? 'not recorded').slice(0, 300));
  return [...found].map(([blocker, evidence]) => ({ blocker, evidence }));
}

// Each row's report.json.gz in downloaded shard artifacts, by repository name.
export function artifactReports(directory) {
  const reports = new Map();
  for (const shard of readdirSync(directory)) {
    const repos = join(directory, shard, 'run', 'repos');
    let names;
    try {
      names = readdirSync(repos);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const report = JSON.parse(
          gunzipSync(readFileSync(join(repos, name, 'run', 'report.json.gz'))),
        );
        reports.set(name.replace('__', '/'), report);
      } catch {}
    }
  }
  return reports;
}

// Per blocker: the rows that have it and the rows where it is the only one.
export function blockerCensus(rows, reports = new Map()) {
  const affected = rows.filter((row) => row.fullAdapter?.confirmed > 0);
  const repositories = affected.map((row) => {
    const blockers = rowBlockers(row, reports.get(row.repo));
    return { repo: row.repo, stage: funnelStage(row).stage, blockers };
  });
  const counts = Object.fromEntries(
    BLOCKERS.map((blocker) => {
      const having = repositories.filter((row) =>
        row.blockers.some((entry) => entry.blocker === blocker),
      );
      return [
        blocker,
        {
          rows: having.length,
          only: having.filter((row) => row.blockers.length === 1).length,
          repos: having.map((row) => row.repo),
        },
      ];
    }).filter(([, count]) => count.rows > 0),
  );
  return {
    rows: rows.length,
    affected: affected.length,
    unblocked: repositories.filter((row) => row.blockers.length === 0).length,
    reports: affected.filter((row) => reports.has(row.repo)).length,
    blockers: counts,
    repositories,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, ...flags] = process.argv.slice(2);
  if (!path)
    throw new Error(
      'Usage: node scripts/validation-funnel.mjs <results.json> [--json] [--all-blockers [--artifacts <dir>]]',
    );
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  const artifacts = flags.includes('--artifacts')
    ? flags[flags.indexOf('--artifacts') + 1]
    : undefined;
  if (flags.includes('--all-blockers')) {
    const census = blockerCensus(rows, artifacts ? artifactReports(artifacts) : undefined);
    if (flags.includes('--json')) console.log(JSON.stringify(census, null, 2));
    else {
      console.log(
        `${census.affected} affected of ${census.rows} rows, ${census.unblocked} without a blocker\n`,
      );
      console.log('| Blocker | Rows | Only blocker |\n| --- | ---: | ---: |');
      for (const [name, count] of Object.entries(census.blockers))
        console.log(`| ${name} | ${count.rows} | ${count.only} |`);
    }
    process.exit(0);
  }
  const result = funnel(rows);
  if (flags.includes('--json')) console.log(JSON.stringify(result, null, 2));
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
