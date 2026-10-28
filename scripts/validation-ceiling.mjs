#!/usr/bin/env node
// How many affected rows of a benchmark run could be validated at all, and why each other row is
// not validated. Every blocker validation-funnel.mjs --all-blockers finds gets one written rule
// (docs/VALIDATION-CEILING.md): fixable, by the lane that covers it or by "none" with a cause, or
// not validatable for one of four reasons, with the evidence quoted. When unsure the rule says
// fixable with lane "none", so the ceiling never hides a Refit gap.
// Usage: node scripts/validation-ceiling.mjs <results.json> [--artifacts <dir>] [--json]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { funnelStage, rowBlockers } from './validation-funnel.mjs';

// The plans a lane comes from, so a founder can find its prompt and PR.
export const LANES = {
  'deps-0': 'DEPENDENCY-BLOCKERS.md lane 0: committed-source archive limit',
  'deps-A': 'DEPENDENCY-BLOCKERS.md lane A: lockfile resolver and types-only peer bump',
  'deps-B': 'DEPENDENCY-BLOCKERS.md lane B: type-only repairs of upgrade type errors',
  'deps-C': 'DEPENDENCY-BLOCKERS.md lane C: payment_method_types rename gates',
  'heldout-1': 'HELDOUT-EASY-WINS.md lane 1: untraced reads Refit proves are not Stripe (#367)',
  'heldout-2': 'HELDOUT-EASY-WINS.md lane 2: contract-change reach shapes (#365)',
  'heldout-3': 'HELDOUT-EASY-WINS.md lane 3: several committed lockfiles (#366)',
  'ceiling-2':
    'VALIDATION-CEILING.md agent 2: runtime stand-ins (generated clients, env, auth, database)',
  'ceiling-3': 'VALIDATION-CEILING.md agent 3: documented-replacement rules (#357)',
  'ceiling-4': 'VALIDATION-CEILING.md agent 4: upgrade fallout needing a behaviour change',
  'ceiling-5': 'VALIDATION-CEILING.md agent 5: signed webhook events for both versions',
  'test-mode-T': 'STRIPE-TEST-MODE.md lane T: behaviour tests in Stripe test mode grant grade A',
  none: 'no planned lane covers it',
};

// The only reasons a row may be called not validatable.
export const NOT_VALIDATABLE = [
  'customer-secrets-or-services',
  'no-check-possible',
  'no-documented-replacement',
  'product-decision',
];

const fixable = (lane, cause) => ({ verdict: 'fixable', lane, ...(cause ? { cause } : {}) });
const notValidatable = (reason, evidence) => ({ verdict: 'not-validatable', reason, evidence });

// Blockers whose lane follows from the blocker alone.
const STATIC = {
  'source-archive-limit': fixable('deps-0'),
  'no-lockfile': fixable('deps-A'),
  'lockfile-out-of-sync': fixable('deps-A'),
  'lockfile-integrity': fixable('deps-A'),
  'peer-dependency-conflict': fixable('deps-A'),
  'stripe-upgrade-refused-peer': fixable('deps-A'),
  'stripe-upgrade-refused-dependency-changes': fixable('deps-A'),
  'conflicting-dependency-files': fixable('heldout-3'),
  'baseline-failed-prisma-client': fixable('ceiling-2'),
  'baseline-failed-next-env': fixable('ceiling-2'),
  'pmt-rename-dropped-api-version-kept': fixable('deps-C'),
  'pmt-rename-dropped-configured-migration': fixable('deps-C'),
  'pmt-rename-dropped-unresolved-api-version': fixable('deps-C'),
  'pmt-rename-dropped-no-literal-pin': fixable('deps-C'),
  'pmt-rename-dropped-other': fixable('deps-C'),
  'pmt-outside-creation-call': fixable('deps-C'),
  'untraced-reads': fixable('heldout-1'),
  'webhook-version': fixable('ceiling-5'),
  // Lane T's referee is what may validate an AI patch or a patch only generated checks reached.
  'ai-patch-review': fixable('test-mode-T'),
  'grade-d': fixable('test-mode-T'),
  // A require()-only project has no type check, but lane T writes node:test behaviour tests for it.
  'no-runnable-check': fixable('test-mode-T'),
  'dependency-tree-too-large': fixable('none', 'dependency tree over the sandbox limit'),
  'unsupported-lockfile-or-workspace': fixable('none', 'unsupported lockfile or workspace layout'),
  'stripe-outside-root-package': fixable('none', 'stripe only in a nested package'),
  'install-timeout': fixable('none', 'dependency install timeout'),
  submodule: fixable('none', 'submodules left out of validation'),
  'preparation-other': fixable('none', 'other preparation refusal'),
  'check-timeout': fixable('none', 'check timeout'),
  'check-error': fixable('none', 'check error'),
  'untraced-api-version': fixable('none', 'untraced API version'),
  'api-version-default': fixable('none', 'no apiVersion on a stripe-node whose default is unknown'),
  'api-version-unconfirmed': fixable('none', 'API version pin Refit cannot confirm'),
  // The patch that moved the pin and upgraded stripe-node failed its checks: upgrade fallout.
  'api-version-kept': fixable('ceiling-4'),
  infrastructure: fixable('none', 'benchmark infrastructure'),
  unexplained: fixable('none', 'not validated, blocker not recorded'),
};

// Packages behind a registry or host the customer controls: Refit cannot fetch them without the
// customer's credentials. Public Git and local paths are a Refit gap instead.
const PRIVATE_SOURCE =
  /npm\.pkg\.github\.com|pkgs\.dev\.azure\.com|jfrog|artifactory|nexus|gitlab\.[\w.-]+\/api|_authToken|NPM_TOKEN|git\+ssh:|ssh:\/\/|git@/i;
const UPGRADE_FOLLOWS = [
  [
    'deps-A',
    /Only root npm, pnpm or Yarn 1 projects|needs @types\/[\w-]+ \S+, which .+ does not provide/,
  ],
  ['heldout-3', /does not lock stripe at the project root|the lockfiles disagree/],
];
// Source-evidence stops by the sentence Refit writes, with the lane or the cause.
const SOURCE_EVIDENCE = [
  [/removed the upcoming invoice API|but the target API version removed/, fixable('ceiling-3')],
  [
    /may be mutated or escape through an alias or call|but the value may be mutated/,
    fixable('none', 'Stripe response or client may be mutated or escape'),
  ],
];
// Runtime dependencies a repository's own test needs before it reaches Stripe code (agent 2).
const RUNTIME =
  /process\.env\.\w+|environment variable|ECONNREFUSED|ENOTFOUND|getaddrinfo|DATABASE_URL|MongoServerError|MongooseServerSelectionError|supabaseUrl is required|PrismaClientInitializationError/;
// oasdiff ids of a change that takes something away; agent 3 gives the documented replacement.
const REMOVAL = /removed/;
const LEAF_READ = /: \S+:\d+ reads `[^`]+`\.$/;
const UNREAD = /Refit cannot read the request property/;
// Errors a type assertion repairs without changing behaviour (lane B); the rest need agent 4.
const TYPE_ONLY_ERRORS = new Set(['TS2322', 'TS2345', 'TS2367', 'TS2678', 'TS2820']);

// The contract changes that hold a row, from the gate's list or, before a draft, productionMode.
export function blockingChanges(row, report) {
  const gate = report?.waivedGates?.find((entry) => entry.gate === 'contract-changes');
  if (gate) {
    const known = new Map(
      (report.specificationDiff?.changes ?? []).map((change) => [
        `${change.operation} ${change.path} ${change.text}`,
        change,
      ]),
    );
    return gate.changes.map((line) => {
      // The gate writes `<change>: <reach reason>`, and either part may hold ': '.
      const ends = [...line.matchAll(/: /g)].map((match) => match.index).concat(line.length);
      const change = ends.map((end) => known.get(line.slice(0, end))).find(Boolean);
      return {
        id: change?.id ?? 'not-recorded',
        reach: change?.reach ?? 'not-recorded',
        text: line,
      };
    });
  }
  return (row.productionMode?.unmapped ?? []).map((change) => ({
    id: change.id,
    reach:
      change.reach ?? (/may request|cannot trace/.test(change.reachReason) ? 'unknown' : 'reached'),
    text: [change.operation, change.path, `${change.text}: ${change.reachReason}`]
      .filter(Boolean)
      .join(' '),
  }));
}

export function changeRule(change) {
  if (/payment_method_types/.test(change.text)) return fixable('deps-C');
  if (/^api-path-removed/.test(change.id)) return fixable('ceiling-3');
  // Reached only by the leaf's name, a parameter Refit cannot read, or not traced at all: the
  // reach shapes of lane 2.
  if (change.reach === 'unknown' || LEAF_READ.test(change.text) || UNREAD.test(change.text))
    return fixable('heldout-2');
  // Stripe names what to send instead (the mined `promotion` move, for one).
  if (change.id === 'new-required-request-property') return fixable('ceiling-3');
  if (change.reach !== 'reached') return fixable('none', 'contract change, reach not recorded');
  if (REMOVAL.test(change.id)) return fixable('ceiling-3');
  return fixable('none', `reached ${change.id}`);
}

// The rule for one blocker of a row; contract changes are split by change.
export function blockerRules(entry, row, report, blockers) {
  const { blocker, evidence } = entry;
  if (STATIC[blocker]) return [{ ...entry, ...STATIC[blocker] }];
  switch (blocker) {
    case 'contract-change': {
      const changes = blockingChanges(row, report);
      if (changes.length === 0)
        return [{ ...entry, ...fixable('none', 'contract change, changes not recorded') }];
      const rules = new Map();
      for (const change of changes) {
        const rule = changeRule(change);
        const key = `${rule.lane} ${rule.cause ?? ''}`;
        if (!rules.has(key))
          rules.set(key, { blocker, evidence: change.text.slice(0, 300), ...rule });
      }
      return [...rules.values()];
    }
    case 'non-registry-source':
      return [
        PRIVATE_SOURCE.test(evidence)
          ? { ...entry, ...notValidatable('customer-secrets-or-services', evidence) }
          : { ...entry, ...fixable('none', 'public Git, URL or local-path dependency') },
      ];
    case 'stripe-upgrade-refused-other':
    case 'pmt-rename-dropped-stripe-upgrade': {
      const lane = UPGRADE_FOLLOWS.find(([, pattern]) => pattern.test(evidence))?.[0];
      return [
        {
          ...entry,
          ...(lane
            ? fixable(lane)
            : fixable('none', 'stripe-node upgrade refused for this lockfile shape')),
        },
      ];
    }
    // A patched check that fails on type errors is upgrade fallout even where the oracle did not run.
    case 'new-type-errors-after-upgrade':
    case 'patched-check-failed': {
      const codes = evidence.match(/TS\d+/g) ?? [];
      if (codes.length === 0)
        return [{ ...entry, ...fixable('none', 'patched check fails without new type errors') }];
      const typeOnly = codes.every((code) => TYPE_ONLY_ERRORS.has(code));
      return [{ ...entry, ...fixable(typeOnly ? 'deps-B' : 'ceiling-4') }];
    }
    case 'baseline-failed-other': {
      const baseline = report?.validation?.baseline;
      const output = `${evidence}\n${baseline?.stdout ?? ''}\n${baseline?.stderr ?? ''}`;
      const plain = output.replace(/\u001b\[[0-9;]*m/g, '').trim();
      return [
        {
          ...entry,
          evidence: evidence === 'not recorded' && plain ? plain.slice(-300) : evidence,
          ...(RUNTIME.test(output)
            ? fixable('ceiling-2')
            : fixable('none', "repository's own check fails on the original code")),
        },
      ];
    }
    case 'removed-request-parameter-other': {
      const parameters = (report?.findings ?? [])
        .filter((finding) => finding.requestParameter)
        .map((finding) => finding.requestParameter.parameter);
      const pmt =
        parameters.includes('payment_method_types') ||
        (row.productionMode?.findings ?? []).some((finding) =>
          /payment_method_types/.test(finding.property),
        );
      return [{ ...entry, ...fixable(pmt ? 'deps-C' : 'ceiling-3') }];
    }
    case 'source-evidence-other':
      return [
        {
          ...entry,
          ...(SOURCE_EVIDENCE.find(([pattern]) => pattern.test(evidence))?.[1] ??
            fixable('none', `source evidence: ${evidence.slice(0, 80)}`)),
        },
      ];
    // No patch follows from the row's other stops; alone it is its own gap.
    case 'no-patch':
      return [
        {
          ...entry,
          ...(blockers.length > 1 ? fixable('follows') : fixable('none', 'no patch proposed')),
        },
      ];
    default:
      return [{ ...entry, ...fixable('none', blocker) }];
  }
}

// Production validated: the run published nothing [Needs review]. Before #359 a grade-D pass still
// ended `validated`, so grade D is not counted for any run.
export function validated(row) {
  return row.production?.status === 'validated' && row.workflow?.grade?.letter !== 'D';
}

export function classifyRow(row, report) {
  const stage = funnelStage(row).stage;
  if (validated(row)) return { repo: row.repo, stage, verdict: 'validated', blockers: [] };
  let found = rowBlockers(row, report);
  if (found.length === 0)
    found = [
      row.workflow?.validation === 'passed' && row.workflow?.grade?.letter === 'D'
        ? { blocker: 'grade-d', evidence: row.workflow.grade.reason?.slice(0, 300) ?? 'grade D' }
        : {
            blocker: 'unexplained',
            evidence: (row.production?.reason ?? row.workflow?.reason ?? 'not recorded').slice(
              0,
              300,
            ),
          },
    ];
  const blockers = found.flatMap((entry) => blockerRules(entry, row, report, found));
  const reasons = [
    ...new Set(blockers.filter((b) => b.verdict === 'not-validatable').map((b) => b.reason)),
  ];
  return {
    repo: row.repo,
    stage,
    verdict: reasons.length ? 'not-validatable' : 'fixable',
    ...(reasons.length ? { reasons } : {}),
    lanes: [...new Set(blockers.filter((b) => b.verdict === 'fixable').map((b) => b.lane))].filter(
      (lane) => lane !== 'follows',
    ),
    blockers,
  };
}

// Each row's report.json.gz in downloaded shard artifacts, read when asked for and kept only in the
// parts the rules read: a full set's reports do not fit in memory together.
export function lazyReports(directory) {
  const paths = new Map();
  for (const shard of readdirSync(directory)) {
    let names = [];
    try {
      names = readdirSync(join(directory, shard, 'run', 'repos'));
    } catch {}
    for (const name of names)
      paths.set(
        name.replace('__', '/'),
        join(directory, shard, 'run', 'repos', name, 'run', 'report.json.gz'),
      );
  }
  const read = (repo) => {
    try {
      const report = JSON.parse(gunzipSync(readFileSync(paths.get(repo))));
      const tail = (text) => (typeof text === 'string' ? text.slice(-20000) : undefined);
      return {
        findings: report.findings,
        waivedGates: report.waivedGates,
        patch: { sdkUpgrade: report.patch?.sdkUpgrade },
        specificationDiff: {
          changes: (report.specificationDiff?.changes ?? []).filter(
            (change) => change.reach === 'reached' || change.reach === 'unknown',
          ),
        },
        validation: report.validation && {
          typeOracle: report.validation.typeOracle,
          baseline: report.validation.baseline && {
            stdout: tail(report.validation.baseline.stdout),
            stderr: tail(report.validation.baseline.stderr),
          },
        },
      };
    } catch {
      return undefined;
    }
  };
  return {
    has: (repo) => paths.has(repo),
    get: (repo) => (paths.has(repo) ? read(repo) : undefined),
  };
}

const tally = (values) =>
  Object.fromEntries(
    Object.entries(
      values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {}),
    ).sort(
      ([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName),
    ),
  );

const uncoveredCauses = (row) => [
  ...new Set(row.blockers.filter((b) => b.lane === 'none').map((b) => b.cause)),
];

export function ceiling(rows, reports = new Map()) {
  const affected = rows.filter((row) => row.fullAdapter?.confirmed > 0);
  const classified = affected.map((row) => {
    const report = reports.get(row.repo);
    return { ...classifyRow(row, report), report: Boolean(report) };
  });
  const fixableRows = classified.filter((row) => row.verdict === 'fixable');
  const validatedCount = classified.filter((row) => row.verdict === 'validated').length;
  return {
    rows: rows.length,
    affected: affected.length,
    reports: classified.filter((row) => row.report).length,
    validated: validatedCount,
    validatable: validatedCount + fixableRows.length,
    notValidatable: tally(
      classified.filter((row) => row.verdict === 'not-validatable').flatMap((row) => row.reasons),
    ),
    // Rows with a blocker of each lane, and rows that lane alone would clear.
    lanes: Object.fromEntries(
      Object.entries(tally(fixableRows.flatMap((row) => row.lanes))).map(([lane, count]) => [
        lane,
        {
          rows: count,
          only: fixableRows.filter((row) => row.lanes.length === 1 && row.lanes[0] === lane).length,
        },
      ]),
    ),
    // The "none" rows by cause, what no lane covers yet, and the rows that cause alone holds.
    uncovered: Object.fromEntries(
      Object.entries(tally(fixableRows.flatMap(uncoveredCauses))).map(([cause, count]) => [
        cause,
        {
          rows: count,
          only: fixableRows.filter(
            (row) =>
              row.lanes.length === 1 &&
              uncoveredCauses(row).length === 1 &&
              uncoveredCauses(row)[0] === cause,
          ).length,
        },
      ]),
    ),
    repositories: classified,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [path, ...flags] = process.argv.slice(2);
  if (!path)
    throw new Error(
      'Usage: node scripts/validation-ceiling.mjs <results.json> [--artifacts <dir>] [--json]',
    );
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  const artifacts = flags.includes('--artifacts')
    ? flags[flags.indexOf('--artifacts') + 1]
    : undefined;
  const result = ceiling(rows, artifacts ? lazyReports(artifacts) : undefined);
  if (flags.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Validated ${result.validated} of ${result.validatable} validatable (${result.affected} affected of ${result.rows} rows; reports for ${result.reports})\n`,
    );
    const table = (title, counts) =>
      [`| ${title} | Rows |`, '| --- | ---: |']
        .concat(Object.entries(counts).map(([name, value]) => `| ${name} | ${value} |`))
        .join('\n');
    console.log(`${table('Not validatable, by reason', result.notValidatable)}\n`);
    console.log('| Fixable by lane | Rows | Only this lane |\n| --- | ---: | ---: |');
    for (const [lane, count] of Object.entries(result.lanes))
      console.log(`| ${lane} | ${count.rows} | ${count.only} |`);
    console.log(
      '\n| No lane covers it, by cause | Rows | Only this cause |\n| --- | ---: | ---: |',
    );
    for (const [cause, count] of Object.entries(result.uncovered))
      console.log(`| ${cause} | ${count.rows} | ${count.only} |`);
  }
}
