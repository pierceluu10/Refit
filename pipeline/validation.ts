import { aiSafetyStop, migrationReviewReason, unresolvedSites } from './migration-review.ts';
import { diffLines } from 'diff';
import type { AiOptions, AiUsage } from './ai-budget.ts';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { runPipeline } from './run.ts';
import { validateProviderOperationMappings } from './provider-operations.ts';
import { SHOPIFY, shopifyVersionDeclarations } from './shopify-pipeline.ts';
import {
  apiVersionSourceBlocked,
  compareApiVersion,
  validateApiVersion,
  type ApiVersionPolicy,
} from './api-version.ts';
import { digest, isObject, readSpecification } from './specifications.ts';
import type { ProviderAdapter } from './providers.ts';
import { unmappedBreakingChanges } from './openapi-diff.ts';
import { PipelineInputError, type Finding, type Repository, type SourceEdit } from './types.ts';
import { TEST_PATH } from './source-paths.ts';
import { readRepository } from './repository.ts';
import {
  validateCheckCommand,
  validateCheckTimeout,
  validateRepairAttempts,
} from './validation-options.ts';
import { committedFiles, sdkPackageDirectory } from './preparation-packages.ts';
import { CONTRACT_CHANGE, proposeAiPatch, TYPE_ERROR_CHANGE } from './ai-patches.ts';
import { droppedRequestPaths, untouchedCalls, untracedEdits } from './ai-patch-policies.ts';
import { PAYMENT_METHOD_RENAME_RULES, removedRequestParameters } from './request-removals.ts';
import { gitEnvironment } from './git-environment.ts';
import { readCommittedRepository } from './committed-repository.ts';
import { prepareDependencies, preparationFailure } from './dependency-preparation.ts';
import { prepareEnvironment } from './repository-environment.ts';
import { baselineStop } from './preparation-stops.ts';
import { typeErrorKeys, typeErrors } from './type-errors.ts';
import { baselineCheck } from './validation-baseline-cache.ts';
import { inspectArtifactFile } from './verification.ts';
import { analyzeRepository } from './analyzer.ts';
import ts from 'typescript-compiler';
import {
  extractStripeMock,
  generatedCommand,
  generatedEnvironment,
  compareGeneratedRuns,
  generatedEntryPoints,
  generatedImportMap,
  stageMockDocument,
  typescriptDirectory,
  writeHarness,
  type GeneratedChecks,
} from './generated-checks.ts';
import { codeDiff, PACKAGE_FILES, packageDiff } from './stripe-package-upgrade.ts';
import {
  type OracleComparison,
  type TypeOracle,
  localReceiverReads,
  typeOraclePasses,
  typeOracleReach,
} from './stripe-type-evidence.ts';
import {
  behaviourCommand,
  changedStripeLines,
  compareBehaviourRuns,
  behaviourGrade,
  validateBehaviourTests,
  writeBehaviourHarness,
  type BehaviourTest,
} from './behaviour-tests.ts';
import { compactPatch, renderPatch } from './patches.ts';
import {
  crossesOpenEnums,
  crossesTypeRemovals,
  KEEP_UNTYPED_REQUEST_PROPERTIES,
  OPEN_ENUM_REPAIR,
  OPEN_ENUM_RULE,
  keepsPartialRestore,
  openEnumRepair,
  restorableOpenEnumErrors,
  untypedRequestProperty,
} from './stripe-open-enums.ts';
import { SUBSCRIPTION_PERIOD_RULE } from './stripe-subscription-periods.ts';
import { selectValidationRuntime } from './validation-runtime.ts';
import { checkFailures, checkFailureText, INTRODUCED_TYPE_ERRORS } from './check-failures.ts';
import {
  advisoryTypeError,
  checkKinds,
  gradeEvidence,
  runsTests,
  TESTS_FAILED,
  testsFoundNone,
  TYPE_CHECK_STARTED,
  typeCheckCommand,
  typeCheckCoverage,
  unavailableTypeCheck,
  ungradedEvidence,
} from './check-selection.ts';
import {
  behaviourTestSkip,
  writeBehaviourTests,
  type BehaviourTestWriter,
} from './behaviour-test-writer.ts';
import { stripeOnlyImports, stripeOnlyProject } from './dependency-stripe-only.ts';
import {
  dockerSandboxArguments,
  preparationProfile,
  removeDockerContainer,
  removeExpiredSandboxContainers,
  resolveDockerImage,
  validationProfile,
} from './docker-sandbox.ts';

export interface PublicationFile {
  path: string;
  mode: '100644' | '100755';
  content: string;
}

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 50 * 1024 * 1024;
// Committed source is copied into the validation workspace beside the unpacked dependency archive.
// The 4 GiB workspace holds a 2 GiB archive and 256 MiB of source; smaller profiles keep 50 MiB.
const sourceArchiveBytes = () => (validationProfile().workspace === '4g' ? 256 : 50) * 1024 * 1024;
const MAX_REPAIR_LOG_CHARACTERS = 16_384;

export interface ValidationAttempt {
  number: number;
  patchHash: string;
  diff: string;
  check: CheckResult;
  responseId: string | null;
  evidenceHash: string | null;
  usage: AiUsage | null;
  costUsd: number | null;
  // Why Refit rejected the model's earlier answer before its corrected request; usage and cost
  // cover both requests.
  rejectedProposals?: string[];
}

// Owner decisions 1 and 8: AI's attempt at what the rules' patch left unresolved, on top of it.
interface CoverageAttempt {
  outcome: 'no-proposal' | 'refused' | 'checks-failed' | 'kept';
  // Every request of the attempt, its repairs included.
  costUsd: number;
  // What the model was asked to resolve, at its lines in the rules' patch.
  targets: ReturnType<typeof unresolvedSites>;
  error?: string;
  // The model's own account when it proposed nothing beyond the rules, so the run can show why.
  response?: { id: string; summary: string; uncertainties: string[] };
  // A proposal that failed its checks after repair, left out of the result.
  attempts?: ValidationAttempt[];
  repair?: { requested: number; stopReason: string; error: string | null };
  // Sites the rules' patch left that the kept proposal's rescan no longer finds.
  resolved?: ReturnType<typeof unresolvedSites>;
  // Owner decision D2 for a kept proposal: why it is not published as validated (none: it is).
  gate?: { passed: boolean; failures: string[]; typeCheckOnly?: boolean };
  // Owner decision D2b: untraced reads the AI left unchanged that the type checker shows read the
  // repository's own objects, never a Stripe type; they no longer count as unresolved.
  localReads?: ReturnType<typeof unresolvedSites>;
  // The stronger step asked after a first answer with no edit (ai-patches.ts).
  escalation?: { model: string; reasoningEffort: string | null; edits: number };
}
// Contract changes named per traced call in a coverage target; the run report has the rest.
const MAX_TARGET_CHANGES = 3;
// Lines a D2 gate failure names; the run report has the rest.
const MAX_GATE_SITES = 5;

const siteList = (sites: readonly { file: string; line: number }[]) =>
  `${sites
    .slice(0, MAX_GATE_SITES)
    .map((site) => (site.line ? `${site.file}:${site.line}` : site.file))
    .join(
      ', ',
    )}${sites.length > MAX_GATE_SITES ? ` and ${sites.length - MAX_GATE_SITES} more` : ''}`;

// Contract changes a type check sees once the target stripe-node is installed (owner decision D2a):
// a removed field, a changed type, a removed enum value. A field that became required, optional or
// nullable, a new default and every other change are behavioural and need the repository's tests.
const TYPE_VISIBLE_CHANGES = new Set([
  'request-property-removed',
  'response-required-property-removed',
  'response-optional-property-removed',
  'request-property-type-changed',
  'response-property-type-changed',
  'request-property-enum-value-removed',
  'response-property-enum-value-removed',
]);
const TYPESCRIPT_SOURCE = /\.[cm]?tsx?$/;

// Owner decision D2 (Pierce, 2026-10-27): a kept coverage AI patch publishes as a validated draft
// only when the target stripe-node is installed and the patched code type-checks against it with
// no new errors (`typeChecked`, the type oracle), the repository's own tests ran and passed on it
// offline (`testsPassed`), it edits only the Stripe sites Refit traced in the rules' code, sends
// every request parameter the rules' code sent, and changes the traced call of every reached
// breaking contract change no rule migrates. D2a lets the passing type check stand in for tests
// (`typeCheckOnly`) when every such change is type-visible, every file the AI changed is TypeScript
// the type check covers (`typeCheckedFiles`) and the checks passed. `failures` says why it does
// not publish validated; none means it does.
export function aiValidationGate(options: {
  rules: Repository;
  patched: Repository;
  provider: ProviderAdapter;
  // What the model was asked to resolve, at lines of the rules' code (coverageTargets).
  targets: readonly Pick<
    Finding,
    'file' | 'line' | 'changeId' | 'expression' | 'confidence' | 'untraced'
  >[];
  // Breaking contract changes no rule migrates (unmappedBreakingChanges).
  unmapped: readonly unknown[];
  typeChecked: boolean;
  testsPassed: boolean;
  checksPassed: boolean;
  typeCheckedFiles: ReadonlySet<string>;
}) {
  const files = new Set(
    [...options.rules.files, ...options.patched.files]
      .map((file) => file.path)
      .filter(
        (path) =>
          options.rules.files.find((file) => file.path === path)?.content !==
          options.patched.files.find((file) => file.path === path)?.content,
      ),
  );
  const outside = untracedEdits(
    options.rules,
    options.patched,
    files,
    options.provider,
    options.targets.filter((target) => target.changeId !== CONTRACT_CHANGE),
  );
  const dropped = droppedRequestPaths(options.rules, options.patched, files, options.provider);
  const calls = options.targets.filter((target) => target.changeId === CONTRACT_CHANGE);
  const untouched = untouchedCalls(options.rules, options.patched, options.provider, calls);
  const unmapped = options.unmapped.filter(isObject);
  const unhandled = unmapped.filter((entry) => {
    const operation = `${String(entry.operation).toUpperCase()} ${String(entry.path)}`;
    const sites = calls.filter((call) => call.expression === operation);
    return !sites.length || sites.some((site) => untouched.includes(site));
  });
  const behavioural = unmapped.filter((entry) => !TYPE_VISIBLE_CHANGES.has(String(entry.id)));
  const untyped = [...files].filter(
    (path) =>
      !TYPESCRIPT_SOURCE.test(path) ||
      path.endsWith('.d.ts') ||
      !options.typeCheckedFiles.has(path),
  );
  const typeCheckOnly =
    !options.testsPassed &&
    options.typeChecked &&
    options.checksPassed &&
    !behavioural.length &&
    !untyped.length;
  const failures = [
    ...(options.typeChecked
      ? []
      : [
          'The type oracle did not show that the patched code type-checks against the target stripe-node, installed in the workspace, with no new errors.',
        ]),
    ...(options.testsPassed || typeCheckOnly
      ? []
      : [
          `The repository's own tests did not run and pass on the patch offline, and the type check cannot stand in for them: ${
            !options.checksPassed
              ? 'the checks did not pass'
              : behavioural.length
                ? `${behavioural
                    .slice(0, MAX_GATE_SITES)
                    .map((entry) => String(entry.id))
                    .join(', ')} ${behavioural.length === 1 ? 'is' : 'are'} not type-visible`
                : untyped.length
                  ? `the type check does not cover ${siteList(untyped.map((file) => ({ file, line: 0 })))}`
                  : 'the type oracle did not pass'
          }.`,
        ]),
    ...(outside.length
      ? [`The AI changed code outside the Stripe sites Refit traced: ${siteList(outside)}.`]
      : []),
    ...(dropped.length
      ? [
          `The AI no longer sends ${dropped
            .slice(0, MAX_GATE_SITES)
            .map((entry) => `${entry.call} ${entry.path} (${entry.file}:${entry.line})`)
            .join(', ')}.`,
        ]
      : []),
    ...(unhandled.length
      ? [
          `The AI left the traced call unchanged for ${unhandled
            .slice(0, MAX_GATE_SITES)
            .map(
              (entry) =>
                `${String(entry.operation).toUpperCase()} ${String(entry.path)} ${String(entry.text)}`,
            )
            .join('; ')}.`,
        ]
      : []),
  ];
  return { failures, typeCheckOnly: !failures.length && typeCheckOnly };
}

// What an AI proposal, or the error that refused one, reports its requests cost.
function costOf(value: unknown) {
  const { budget, proposal } = (value ?? {}) as {
    budget?: { costUsd?: number } | null;
    proposal?: { budget?: { costUsd?: number } | null };
  };
  return budget?.costUsd ?? proposal?.budget?.costUsd ?? 0;
}

// The line an unchanged line of `before` is on in `after`; undefined once an edit changed it.
export function movedLine(before: string, after: string, line: number) {
  let from = 1;
  let to = 1;
  for (const part of diffLines(before, after)) {
    if (part.added) {
      to += part.count;
      continue;
    }
    if (line < from + part.count) return part.removed ? undefined : to + line - from;
    from += part.count;
    if (!part.removed) to += part.count;
  }
  return undefined;
}

// Sites of `before` whose file, change and expression `after` has fewer of.
function resolvedSites(
  before: ReturnType<typeof unresolvedSites> = [],
  after: ReturnType<typeof unresolvedSites> = [],
) {
  const key = (site: (typeof before)[number]) =>
    `${site.file}\n${site.changeId}\n${site.expression}`;
  const left = new Map<string, number>();
  for (const site of after) left.set(key(site), (left.get(key(site)) ?? 0) + 1);
  return before.filter((site) => {
    const count = left.get(key(site)) ?? 0;
    left.set(key(site), count - 1);
    return count <= 0;
  });
}

export interface CheckResult {
  status: 'passed' | 'failed' | 'error' | 'not-run';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}
const NOT_RUN: CheckResult = { status: 'not-run', exitCode: null, stdout: '', stderr: '' };

// With compareTypeErrors, the original code's type errors are the baseline: a typecheck that
// reports errors still ran, and the patched check fails only on errors the patch introduced.
function introducedTypeErrors(baseline: CheckResult, patched: CheckResult) {
  const before = typeErrorKeys(baseline);
  return typeErrors(patched).filter((error) => !before.has(error.key));
}

// Literal comparisons the upgraded types reject, usually misspelled webhook event names that never
// matched, and the `never` narrowing they cause are application bugs to flag, not migration errors
// to fix (owner decision, 2026-10-16).
const REVIEW_TYPE_ERROR =
  /^Type '"[^"]*"' is not comparable to type|^This comparison appears to be unintentional because the types '"[^"]*"'|on type 'never'\.$/;

export function reviewTypeError(error: { message: string }) {
  return REVIEW_TYPE_ERROR.test(error.message);
}

const REJECTED_PROPERTY =
  /Object literal may only specify known properties, (?:and|but) '([^']+)' does not exist in type '[^']*'/;

// Object-literal properties the upgraded types reject that the original code's check accepted,
// such as Checkout's `subscription_data.trial_from_plan`, which stripe-node 12 typed and later
// versions drop. tsc reports them on the error line or the indented line after it.
export function rejectedProperties(baseline: CheckResult, patched: CheckResult) {
  const reports = (check: CheckResult) =>
    `${check.stdout}\n${check.stderr}`
      .split('\n')
      .map((line) => REJECTED_PROPERTY.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match));
  const before = new Set(reports(baseline).map((match) => match[0]));
  return [
    ...new Set(
      reports(patched)
        .filter((match) => !before.has(match[0]))
        .map((match) => match[1]),
    ),
  ];
}

// Stripe moved a subscription's billing period onto its items in 2025-03-31.basil. Reading it from
// an item means choosing one, which only the reviewed stripeSubscriptionPeriods rule may do.
const SUBSCRIPTION_PERIOD_READ =
  /^Property 'current_period_(?:start|end)' does not exist on type '[^']*\bSubscription\b[^']*'/;

export function subscriptionPeriodRead(error: { message: string }) {
  return SUBSCRIPTION_PERIOD_READ.test(error.message);
}

// stripe-node's own types prove these reads are on a Stripe Subscription, so validation re-proposes
// them through the version-tolerant period helper, which returns the old field when the object has
// it and the items' shared period otherwise; with items on different periods it returns undefined,
// as the removed field did (https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end,
// read 2026-10-24: the fields "are no longer available on the subscription resource").
export const TYPE_CHECKED_PERIOD_READS = true;

// Where each rejected read sits in the original source: the error's position in the patched file,
// moved back across the proposal's edits. Undefined when an error is not a plain property read the
// edits left alone, or the patched file is not exactly the original with those edits.
export function typeCheckedPeriodReads(
  errors: { file: string; line: number; column: number; code: string; message: string }[],
  patched: { path: string; content: string }[],
  original: { path: string; content: string }[],
  edits: SourceEdit[],
) {
  const reads: { file: string; position: number }[] = [];
  for (const error of errors) {
    const after = patched.find((file) => file.path === error.file)?.content;
    const before = original.find((file) => file.path === error.file)?.content;
    if (
      !['TS2339', 'TS2551'].includes(error.code) ||
      !subscriptionPeriodRead(error) ||
      after === undefined ||
      before === undefined
    )
      return;
    const fileEdits = edits
      .filter((edit) => edit.file === error.file)
      .sort((a, b) => a.start - b.start);
    let rebuilt = before;
    for (const edit of [...fileEdits].reverse())
      rebuilt = rebuilt.slice(0, edit.start) + edit.replacement + rebuilt.slice(edit.end);
    if (rebuilt !== after) return;
    const starts = ts.createSourceFile(error.file, after, ts.ScriptTarget.Latest).getLineStarts();
    const offset = (starts[error.line - 1] ?? NaN) + error.column - 1;
    if (!(offset >= 0 && offset < (starts[error.line] ?? after.length + 1))) return;
    let shift = 0;
    for (const edit of fileEdits) {
      const start = edit.start + shift;
      if (offset < start) break;
      if (offset < start + edit.replacement.length) return;
      shift += edit.replacement.length - (edit.end - edit.start);
    }
    reads.push({ file: error.file, position: offset - shift });
  }
  return reads;
}

const formatTypeError = (error: ReturnType<typeof typeErrors>[number]) =>
  `${error.file}(${error.line},${error.column}): error ${error.code}: ${error.message}`;

export function compareTypeCheck(
  baseline: CheckResult,
  patched?: CheckResult,
  // Introduced errors that are advisory instead of failing (advisoryTypeError).
  advisory?: (file: string) => boolean,
): CheckResult {
  const check = patched ?? baseline;
  const errors = typeErrors(check);
  if (check.status === 'error' || check.status === 'not-run') return check;
  // Failing tests fail a chain whatever type errors they printed.
  if (check.stdout.includes(TESTS_FAILED) || (check.exitCode !== 0 && !errors.length))
    return { ...check, status: 'failed' };
  if (!patched) return { ...check, status: 'passed' };
  const introduced = introducedTypeErrors(baseline, check).filter(
    (error) => !advisory?.(error.file),
  );
  return introduced.length
    ? {
        ...check,
        status: 'failed',
        stdout: `${INTRODUCED_TYPE_ERRORS}${introduced.map(formatTypeError).join('\n')}\n\n${check.stdout}`,
      }
    : { ...check, status: 'passed' };
}

// A type check finished when it exited cleanly or reported type errors.
const typeCheckFinished = (run: CheckResult) =>
  !['error', 'not-run'].includes(run.status) && (run.exitCode === 0 || typeErrors(run).length > 0);

// The type oracle (stripe-type-evidence.ts TypeOracle): only where the final patch installs a
// stripe-node upgrade of its own and the check compares type errors. The original code is checked
// once more, with only the patch's package files applied and its prepared dependencies.
export async function runTypeOracle(options: {
  compareTypeErrors?: boolean;
  command: string[];
  upgrade?: { from?: string; to?: string };
  // The final patch's package.json and lockfile sections.
  packages: string;
  // The final patch's prepared dependencies, when it installed its own.
  dependencies?: string;
  baseline: CheckResult;
  patched: CheckResult;
  typeCheckUnavailable?: string;
  report: Pick<
    Awaited<ReturnType<typeof runPipeline>>,
    'specificationDiff' | 'operationImpacts' | 'adapter'
  >;
  before: Record<string, unknown>;
  files: { path: string; content: string }[];
  // Original paths, with the nested package Refit checks in as their prefix.
  packageDirectory?: string;
  check: (diff: string, command: string[], dependencies: string) => Promise<CheckResult>;
}): Promise<TypeOracle | undefined> {
  const to = options.upgrade?.to;
  if (!options.compareTypeErrors || !to || !options.packages || !options.dependencies)
    return undefined;
  const sdk = { from: options.upgrade?.from ?? null, to };
  const kinds = checkKinds(options.command, {});
  const command =
    typeCheckCommand(options.command) ??
    (kinds.size === 1 && kinds.has('typecheck') ? options.command : undefined);
  const prefix = options.packageDirectory ? `${options.packageDirectory}/` : '';
  const compare = (run: CheckResult | undefined, side: string): OracleComparison => {
    if (options.typeCheckUnavailable)
      return {
        status: 'unavailable',
        reason: `the type check is unavailable: ${options.typeCheckUnavailable}`,
      };
    if (!run) return { status: 'unavailable', reason: 'the check has no type check of its own' };
    if (!typeCheckFinished(options.baseline))
      return {
        status: 'unavailable',
        reason: 'the type check did not finish on the original code',
      };
    if (!typeCheckFinished(run))
      return {
        status: 'unavailable',
        reason: `the type check did not finish on ${side}${run.error ? `: ${run.error}` : ''}`,
      };
    const seen = new Set<string>();
    return {
      status: 'compared',
      introduced: introducedTypeErrors(options.baseline, run)
        .filter((error) => {
          const position = `${error.key} ${error.line} ${error.column}`;
          return !seen.has(position) && Boolean(seen.add(position));
        })
        .map(({ key, ...error }) => ({ ...error, file: `${prefix}${error.file}` })),
    };
  };
  const unpatched = compare(
    command && typeCheckFinished(options.baseline) && !options.typeCheckUnavailable
      ? // The oracle is evidence only: a sandbox that cannot apply or run it leaves it unavailable.
        await options
          .check(options.packages, command, options.dependencies)
          .catch((error: unknown) => ({
            ...NOT_RUN,
            status: 'error' as const,
            error: error instanceof Error ? error.message : String(error),
          }))
      : command
        ? NOT_RUN
        : undefined,
    'the original code with the target stripe-node',
  );
  const reached =
    unpatched.status === 'compared'
      ? typeOracleReach(
          options.report.specificationDiff.changes as Record<string, unknown>[],
          unpatched.introduced,
          {
            files: options.files,
            impacts: options.report.operationImpacts,
            mappings: validateProviderOperationMappings(options.report.adapter, options.before),
            before: options.before,
            sdk: to,
          },
        )
      : [];
  return {
    sdk,
    unpatched,
    patched: compare(options.patched, 'the patched code'),
    reached,
  };
}

async function command(binary: string, args: string[], cwd?: string) {
  return execute(binary, args, {
    cwd,
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    encoding: 'utf8',
    env: binary === 'git' ? gitEnvironment() : undefined,
  });
}

// Refit's compiler, which a scoped type check runs in a repository that installs none
// (check-selection.ts REFIT_TSC).
const typescriptMount = () => [{ source: typescriptDirectory(), target: '/refit/typescript' }];
// How long each check may run, and the nested package it runs in (preparation-packages.ts).
interface CheckSandbox {
  timeoutMs: number;
  packageDirectory?: string;
}

async function containerCheck({
  directory,
  image,
  command: argumentsList,
  dependencies,
  readOnlyMounts = typescriptMount(),
  signal,
  timeoutMs,
  packageDirectory,
}: {
  directory: string;
  image: string;
  command: string[];
  dependencies?: string;
  readOnlyMounts?: { source: string; target: string }[];
  signal?: AbortSignal;
} & CheckSandbox): Promise<CheckResult> {
  const name = `refit-${randomUUID()}`;
  await removeExpiredSandboxContainers();
  try {
    const result = await execute(
      'docker',
      dockerSandboxArguments({
        name,
        directory,
        image,
        command: argumentsList,
        network: 'none',
        timeoutMs,
        dependencies,
        readOnlyMounts,
        packageDirectory,
      }),
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        // The Docker client forwards SIGTERM to the container, where a process that ignores it keeps
        // the client waiting forever; SIGKILL ends the client and the finally block the container.
        killSignal: 'SIGKILL',
        signal,
      },
    );
    return { status: 'passed', exitCode: 0, ...result };
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error)) throw error;
    const failure = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    return {
      status: exitCode !== null && !failure.killed && exitCode < 125 ? 'failed' : 'error',
      exitCode,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      error:
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? `Check output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB; the container was stopped.`
          : failure.killed
            ? `Check exceeded ${timeoutMs / 1000} seconds; the container was stopped.`
            : failure.message,
    };
  } finally {
    // A killed Docker client does not necessarily stop the container it started.
    await removeDockerContainer(name);
  }
}

const GIB = 1024 ** 3;

// Running two sandboxes at once is an operator opt-in (owner decision, 2026-10-22): the memory
// check below reads the host's total, not what other validations already hold.
const OVERLAP_SETTING = 'REFIT_VALIDATION_OVERLAP';

// Two sandboxes at once need room for both at their memory limit (two installs, or two checks)
// and 1 GiB more. Without the opt-in, or on a smaller host such as the 4 GB hosted worker,
// validation runs one sandbox at a time as before.
async function roomForTwoSandboxes() {
  if (process.env[OVERLAP_SETTING] !== '1') return false;
  const limit = Math.max(
    ...[preparationProfile().memory, validationProfile().memory].map(
      (memory) => Number.parseInt(memory, 10) * GIB,
    ),
  );
  try {
    const { stdout } = await execute('docker', ['info', '--format', '{{.MemTotal}}'], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    return Number(stdout.trim()) >= 2 * limit + GIB;
  } catch {
    // A host Refit cannot measure gets the sequential path, which needs no extra room.
    return false;
  }
}

// Archives the committed revision under `root` and extracts it as the baseline directory.
async function extractSnapshot(repository: string, revision: string, root: string) {
  const archive = join(root, 'source.tar');
  const sourceBytes = sourceArchiveBytes();
  const archiveResult = await execute(
    'git',
    ['-C', repository, 'archive', '--format=tar', revision],
    {
      encoding: 'buffer',
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: sourceBytes,
      env: gitEnvironment(),
    },
  ).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      throw new PipelineInputError(
        `Committed source exceeds the ${sourceBytes / 1024 / 1024} MiB validation archive limit. Stop committing build output, media or data files (or track them with Git LFS) so the committed tree fits.`,
      );
    throw error;
  });
  await writeFile(archive, archiveResult.stdout);
  const baselineDirectory = join(root, 'baseline');
  await mkdir(baselineDirectory);
  await command('tar', ['-xf', archive, '-C', baselineDirectory]);
  return { archive, archiveHash: digest(archiveResult.stdout), baselineDirectory };
}

// The sandbox runs as an unprivileged user, so a folder it mounts must be readable by others;
// mkdtemp creates mode 700, which only Docker Desktop on macOS lets through.
export async function sandboxInput(root: string, prefix: string) {
  const directory = await mkdtemp(join(root, prefix));
  await chmod(directory, 0o755);
  return directory;
}

async function applyPatch(archive: string, directory: string, patch: string, diff: string) {
  await command('tar', ['-xf', archive, '-C', directory]);
  await writeFile(patch, diff);
  await command('git', ['apply', '--check', patch], directory);
  await command('git', ['apply', patch], directory);
}

// Returns the mode of a committed file whose archived content still matches its Git blob.
function committedMode(entries: readonly string[], path: string, content: string) {
  const entry = entries.find((item) => item.slice(item.indexOf('\t') + 1) === path);
  const metadata = entry?.slice(0, entry.indexOf('\t')).split(' ');
  const blob = createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
  if (!metadata || metadata[2] !== blob)
    throw new PipelineInputError('Archived source does not match the committed Git blob.');
  return metadata[0] as PublicationFile['mode'];
}

// Checks the archive preparation copied into the validation snapshot and returns its environment.
async function snapshotDependencies(
  prepared: Awaited<ReturnType<typeof prepareDependencies>>,
  destination: string,
) {
  const copied = await inspectArtifactFile(destination, validationProfile().archiveBytes);
  if (
    copied.sha256 !== prepared.environment.archiveHash ||
    copied.bytes !== prepared.environment.archiveBytes
  )
    throw new PipelineInputError(
      'Prepared dependencies changed while creating the validation snapshot.',
    );
  return { ...prepared.environment, reused: prepared.reused };
}

// A patch that changes package files needs dependencies prepared from the patched lockfile, which
// preparation reads from a committed snapshot of the candidate.
async function prepareCandidateDependencies(
  candidateDirectory: string,
  root: string,
  image: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    packageDirectory?: string;
  },
) {
  await command('git', ['init', '-q'], candidateDirectory);
  await command('git', ['add', '-A'], candidateDirectory);
  // A large tree would make the commit start `git gc --auto` in the background, which can still be
  // writing packs when the .git directory is removed below (ENOTEMPTY).
  await command(
    'git',
    [
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'user.name=Refit',
      '-c',
      'user.email=refit@localhost',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'Refit migration candidate',
    ],
    candidateDirectory,
  );
  const dependencies = join(root, `${basename(candidateDirectory)}-dependencies.tar`);
  const prepared = await prepareEnvironment({
    repository: candidateDirectory,
    image,
    packageDirectory: options.packageDirectory,
    copyArchiveTo: dependencies,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  await rm(join(candidateDirectory, '.git'), { recursive: true, force: true });
  return { dependencies, environment: await snapshotDependencies(prepared, dependencies) };
}

// When the repository's dependencies cannot be prepared, the changed Stripe modules may still load
// with only the stripe package: each side gets stripe and the closure its own lockfile records
// (the locked version on the original side, the patch's on the patched side), installed with the
// lockfile's integrity and scripts off by the same preparation, then run offline.
async function stripeOnlyDependencies(options: {
  root: string;
  image: string;
  original: { directory: string; repository: Repository };
  patched: { directory: string; repository: Repository };
  findings: readonly Pick<Finding, 'file'>[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const changed = changedStripeLines(
    options.original.repository,
    options.patched.repository,
    options.findings,
  );
  const reasons = [
    ...new Set([
      ...stripeOnlyImports(options.original.repository, Object.keys(changed.original)),
      ...stripeOnlyImports(options.patched.repository, Object.keys(changed.patched)),
    ]),
  ];
  if (reasons.length) return { record: { status: 'not-loadable' as const, reasons } };
  const projects = [];
  for (const side of ['original', 'patched'] as const) {
    const lockfile = await readFile(
      join(options[side].directory, 'package-lock.json'),
      'utf8',
    ).catch(() => undefined);
    const project = lockfile
      ? stripeOnlyProject(lockfile)
      : { reason: 'Only an npm package-lock.json records the stripe closure Refit installs.' };
    if ('reason' in project)
      return { record: { status: 'not-preparable' as const, reasons: [project.reason] } };
    projects.push(project);
  }
  try {
    const archives: string[] = [];
    for (const [index, project] of projects.entries()) {
      // A patch that keeps the lockfile installs the same closure on both sides.
      if (index === 1 && JSON.stringify(project) === JSON.stringify(projects[0])) {
        archives.push(archives[0]);
        continue;
      }
      const directory = await sandboxInput(options.root, `stripe-only-${index}-`);
      await writeFile(join(directory, 'package.json'), `${JSON.stringify(project.manifest)}\n`);
      await writeFile(
        join(directory, 'package-lock.json'),
        `${JSON.stringify(project.lockfile)}\n`,
      );
      archives.push(
        (await prepareCandidateDependencies(directory, options.root, options.image, options))
          .dependencies,
      );
    }
    return {
      record: {
        status: 'prepared' as const,
        versions: { original: projects[0].version, patched: projects[1].version },
        integrity: { original: projects[0].integrity, patched: projects[1].integrity },
      },
      dependencies: { original: archives[0], patched: archives[1] },
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return {
      record: {
        status: 'refused' as const,
        reasons: [error instanceof Error ? error.message : String(error)],
      },
    };
  }
}

function typeCheckComparison(
  baselineRun: CheckResult,
  compareTypeErrors?: boolean,
  advisory?: (file: string) => boolean,
  // A generated type check that checked nothing on the original code (unavailableTypeCheck): only
  // a chain's tests decide, and without tests no check ran.
  unavailable?: string,
) {
  const testsOnly = (check: CheckResult): CheckResult =>
    ['error', 'not-run'].includes(check.status)
      ? check
      : { ...check, status: check.stdout.includes(TESTS_FAILED) ? 'failed' : 'passed' };
  if (unavailable)
    return {
      baseline: baselineRun.stdout.includes(TYPE_CHECK_STARTED)
        ? testsOnly(baselineRun)
        : {
            ...baselineRun,
            status: 'error' as const,
            error: `The generated type check is unavailable: ${unavailable}`,
          },
      compared: testsOnly,
      noTests: false,
    };
  // A test script that found no test files on the original code proves nothing: only the chain's
  // type check counts, on both sides, unless the patched run's tests failed some other way.
  const noTests = Boolean(compareTypeErrors) && testsFoundNone(baselineRun);
  const typeCheckOnly = (check: CheckResult): CheckResult =>
    noTests && testsFoundNone(check)
      ? { ...check, stdout: check.stdout.replace(TESTS_FAILED, '') }
      : check;
  return {
    baseline: compareTypeErrors ? compareTypeCheck(typeCheckOnly(baselineRun)) : baselineRun,
    compared: (check: CheckResult) =>
      compareTypeErrors ? compareTypeCheck(baselineRun, typeCheckOnly(check), advisory) : check,
    noTests,
  };
}

// Generated checks and behaviour tests change the outcome only through a counted regression
// (compareGeneratedRuns, compareBehaviourRuns); one that is broken or could not run is evidence that
// is missing, not a failure.
function checkStatus(
  baseline: CheckResult,
  patched: CheckResult,
  ...counted: ({ regressions: unknown[] } | undefined)[]
) {
  return [baseline, patched].some((check) => check.status === 'error')
    ? ('error' as const)
    : baseline.status !== 'passed'
      ? ('baseline-failed' as const)
      : patched.status !== 'passed' || counted.some((evidence) => evidence?.regressions.length)
        ? ('regression' as const)
        : ('passed' as const);
}

// A baseline that fails for a known setup reason names the change that fixes it.
function namedBaselineStop(status: string, baselineRun: CheckResult) {
  const stop =
    status === 'baseline-failed'
      ? baselineStop(`${baselineRun.stdout}\n${baselineRun.stderr}`)
      : undefined;
  return stop
    ? { baselineStop: { reason: stop.reason, summary: stop.summary, action: stop.action } }
    : {};
}

const validationLimits = (timeoutMs: number) => ({
  timeoutMs,
  outputBytes: MAX_OUTPUT_BYTES,
  network: 'none',
  workspace: validationProfile().workspace,
  memory: validationProfile().memory,
});

// A failed Docker command's own stderr, on one line, rather than execFile's "Command failed" text.
const setupError = (error: unknown) =>
  (
    ((error as { stderr?: unknown }).stderr as string | undefined)?.trim() ||
    (error instanceof Error ? error.message : String(error))
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 500);

const GENERATED_CLAIM =
  "Exported functions enclosing confirmed findings ran against stripe-mock serving each side's contract and fixtures. Placeholder fixtures check response shapes, not business data or application tests.";

// Runs the enclosing exported functions of confirmed findings against stripe-mock serving each
// side's pinned contract and fixtures, inside the same offline sandbox as configured checks. A
// generated check that cannot be set up (no local stripe-mock image, a YAML contract, a Docker
// failure) is reported as unavailable with its reason and never changes the outcome.
async function generatedStripeChecks(options: {
  settings: GeneratedChecks;
  root: string;
  image: string;
  dependencies?: string;
  original: Awaited<ReturnType<typeof readRepository>>;
  patched: Awaited<ReturnType<typeof readRepository>>;
  findings: Parameters<typeof generatedEntryPoints>[1];
  runs: { directory: string; contract: string; side: 'before' | 'after'; dependencies?: string }[];
  sandbox: CheckSandbox;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}) {
  let entryPoints: ReturnType<typeof generatedEntryPoints> = { entries: [], uncovered: 0 };
  try {
    entryPoints = generatedEntryPoints(options.original, options.findings);
    return await runGeneratedStripeChecks(options, entryPoints);
  } catch (error) {
    options.signal?.throwIfAborted();
    return {
      engine: 'stripe-mock' as const,
      status: 'unavailable' as const,
      reason: `Generated checks could not be set up: ${setupError(error)}`,
      entryPoints: entryPoints.entries,
      uncoveredFindings: entryPoints.uncovered,
      ran: 0,
      notRunnable: [],
      unavailableEntries: [],
      regressions: [],
      baseline: NOT_RUN,
      patched: NOT_RUN,
      claim: GENERATED_CLAIM,
    };
  }
}

// Copies the stripe-mock binary out of the local image and stages each side's contract and
// fixtures beside the harness, read-only; the mounts put them where the sandbox command expects.
async function stageStripeMock(
  settings: GeneratedChecks,
  tools: string,
  contracts: { before: string; after: string },
) {
  const mock = await extractStripeMock(settings.stripeMockImage, tools);
  const staged = (side: 'before' | 'after') => ({
    contract: join(tools, `${side}-spec.json`),
    fixtures: join(tools, `${side}-fixtures.json`),
  });
  const inputs = {
    before: {
      contract: await stageMockDocument(
        contracts.before,
        'before contract',
        staged('before').contract,
      ),
      fixtures: await stageMockDocument(
        settings.beforeFixtures,
        'before fixtures file',
        staged('before').fixtures,
      ),
    },
    after: {
      contract: await stageMockDocument(
        contracts.after,
        'after contract',
        staged('after').contract,
      ),
      fixtures: await stageMockDocument(
        settings.afterFixtures,
        'after fixtures file',
        staged('after').fixtures,
      ),
    },
  };
  return {
    image: mock.imageId,
    binaryHash: mock.binaryHash,
    inputs,
    mounts: (side: 'before' | 'after') => [
      { source: mock.binary, target: '/refit/stripe-mock' },
      { source: staged(side).contract, target: '/refit/spec.json' },
      { source: staged(side).fixtures, target: '/refit/fixtures.json' },
      { source: tools, target: '/refit/generated' },
      ...typescriptMount(),
    ],
  };
}

async function runGeneratedStripeChecks(
  options: Parameters<typeof generatedStripeChecks>[0],
  entryPoints: ReturnType<typeof generatedEntryPoints>,
) {
  const { entries, uncovered } = entryPoints;
  const tools = await sandboxInput(options.root, 'generated-');
  const mock = await stageStripeMock(options.settings, tools, {
    before: options.runs[0].contract,
    after: options.runs[1].contract,
  });
  await writeHarness(
    tools,
    entries,
    generatedImportMap(options.original),
    generatedImportMap(options.patched),
    generatedEnvironment(options.original, options.patched),
  );
  // Each side runs in its own offline sandbox with its own stripe-mock, so both may run at once.
  const generatedRun = async (run: (typeof options.runs)[number]) => {
    if (!entries.length) return NOT_RUN;
    options.onProgress?.(
      `Running generated Stripe checks against ${run.side}-version stripe-mock in offline Docker...`,
    );
    return containerCheck({
      directory: run.directory,
      image: options.image,
      command: generatedCommand(run.side),
      dependencies: run.dependencies ?? options.dependencies,
      readOnlyMounts: mock.mounts(run.side),
      signal: options.signal,
      ...options.sandbox,
    });
  };
  const results = (await roomForTwoSandboxes())
    ? await Promise.all(options.runs.map(generatedRun))
    : [await generatedRun(options.runs[0]), await generatedRun(options.runs[1])];
  return {
    engine: 'stripe-mock' as const,
    image: mock.image,
    binaryHash: mock.binaryHash,
    inputs: mock.inputs,
    entryPoints: entries,
    uncoveredFindings: uncovered,
    ...compareGeneratedRuns(entries, results[0], results[1]),
    claim: GENERATED_CLAIM,
  };
}

// Runs behaviour tests (node:test files) on the original code against the before-version
// stripe-mock and on the patched code against the after-version stripe-mock, in the offline
// sandbox, with V8 coverage of the changed Stripe lines. Directories are prepared snapshots, as in
// validateMigration; `dependencies` are their prepared dependency archives.
export async function runBehaviourTests(options: {
  tests: BehaviourTest[];
  settings: GeneratedChecks;
  image: string;
  root: string;
  original: { directory: string; contract: string; repository: Repository; dependencies?: string };
  patched: { directory: string; contract: string; repository: Repository; dependencies?: string };
  // Files where Refit traced Stripe usage; with files importing stripe, they are the Stripe code.
  findings?: readonly Pick<Finding, 'file'>[];
  // The repository's check time limit and nested package; the default limit without one.
  sandbox?: CheckSandbox;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}) {
  validateBehaviourTests(options.tests);
  const sources = { original: options.original.repository, patched: options.patched.repository };
  const changed = changedStripeLines(sources.original, sources.patched, options.findings);
  const tools = await sandboxInput(options.root, 'behaviour-');
  const mock = await stageStripeMock(options.settings, tools, {
    before: options.original.contract,
    after: options.patched.contract,
  });
  await writeBehaviourHarness(tools, options.tests, changed, sources);
  const run = (side: 'before' | 'after') => {
    const input = side === 'before' ? options.original : options.patched;
    options.onProgress?.(
      `Running behaviour tests against ${side}-version stripe-mock in offline Docker...`,
    );
    return containerCheck({
      directory: input.directory,
      image: options.image,
      command: behaviourCommand(side),
      dependencies: input.dependencies,
      readOnlyMounts: mock.mounts(side),
      signal: options.signal,
      ...(options.sandbox ?? { timeoutMs: validateCheckTimeout() * 1000 }),
    });
  };
  const [original, patched] = (await roomForTwoSandboxes())
    ? await Promise.all([run('before'), run('after')])
    : [await run('before'), await run('after')];
  return {
    image: mock.image,
    binaryHash: mock.binaryHash,
    inputs: mock.inputs,
    ...compareBehaviourRuns({ tests: options.tests, changed, sources, original, patched }),
  };
}

// Behaviour tests that cannot be set up or run are reported as unavailable, never as a failure.
async function behaviourEvidence(
  options: Omit<Parameters<typeof runBehaviourTests>[0], 'settings'> & {
    settings?: GeneratedChecks;
  },
) {
  try {
    if (!options.settings)
      throw new PipelineInputError(
        "Behaviour tests need generatedChecks settings: a local stripe-mock image and both versions' fixtures.",
      );
    return await runBehaviourTests({ ...options, settings: options.settings });
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = `Behaviour tests could not run: ${setupError(error)}`;
    return {
      engine: 'node-test+stripe-mock' as const,
      status: 'unavailable' as const,
      reason,
      grade: null,
      missing: [reason],
      tests: options.tests.map((test) => ({ path: test.path, sha256: digest(test.content) })),
      regressions: [] as { id: string; error: string }[],
    };
  }
}

const mentions = (files: { content: string }[], name: string) =>
  files.reduce(
    (count, file) => count + (file.content.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0),
    0,
  );

// Removed request parameters a repair mentions fewer times than the original code does, less the
// sites the approved card rule (and an opted-in listed rename) already renamed.
export function droppedRequestParameters(
  names: string[],
  original: { content: string }[],
  candidate: { content: string }[],
  ruleEdits: SourceEdit[],
) {
  const renamed = ruleEdits.filter((edit) =>
    PAYMENT_METHOD_RENAME_RULES.has(edit.rule ?? ''),
  ).length;
  return names.filter(
    (name) =>
      mentions(candidate, name) <
      mentions(original, name) - (name === 'payment_method_types' ? renamed : 0),
  );
}

export async function validateMigration(options: {
  repository: string;
  before: string;
  after: string;
  image: string;
  command: string[];
  baselineCommand?: string[];
  // .refit.json checkTimeoutSeconds: how long each check may run (validation-options.ts).
  checkTimeoutSeconds?: number;
  prepareDependencies?: boolean;
  compareTypeErrors?: boolean;
  assessment?: AiOptions;
  aiPatch?: AiOptions;
  documentationSnapshots?: readonly string[];
  providerConfig?: string;
  apiVersion?: string;
  apiVersionPolicy?: ApiVersionPolicy;
  requireApiVersionMatch?: boolean;
  fullDiff?: boolean;
  repairAttempts?: number;
  generatedChecks?: GeneratedChecks;
  // Behaviour tests (refit-behaviour/<name>.test.mjs) to run on both sides once the checks pass;
  // they need generatedChecks' stripe-mock image and fixtures. See runBehaviourTests.
  behaviourTests?: BehaviourTest[];
  // --write-behaviour-tests: without behaviourTests, one model request writes them from the
  // original code (behaviour-test-writer.ts); --write-behaviour-tests-dry-run only builds it.
  behaviourTestWriter?: BehaviourTestWriter;
  // Owner decision 1: see runPipeline.
  leaveReviewedFindings?: boolean;
  keepApiVersion?: boolean;
  keepListedPaymentMethods?: boolean;
  shopifySdkUpgrade?: boolean;
  // Owner decision 1: when dependency preparation refuses, or the baseline checks fail and so give
  // no evidence, the patch is still applied and returned untested instead of throwing or dropped.
  recordUntested?: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}) {
  validateCheckCommand(options.command);
  const baselineCommand = validateCheckCommand(options.baselineCommand ?? options.command);
  const timeoutMs = validateCheckTimeout(options.checkTimeoutSeconds) * 1000;
  const repairLimit = validateRepairAttempts(options.repairAttempts ?? 0, Boolean(options.aiPatch));
  if (options.requireApiVersionMatch) {
    const [before, after] = await Promise.all([
      readSpecification(options.before),
      readSpecification(options.after),
    ]);
    const applicability = compareApiVersion(
      validateApiVersion(options.apiVersion),
      before.document,
      after.document,
    );
    if (applicability.applicability !== 'matches-before')
      throw new PipelineInputError(`Automated publication is blocked. ${applicability.reason}`);
  }
  const snapshot = await readCommittedRepository(options.repository, {
    submodules: options.leaveReviewedFindings,
  });
  const repository = snapshot.directory;
  const preflight = await runPipeline({
    ...options,
    repository,
    proposePatch: false,
    fullDiff: false,
    aiPatch: undefined,
    assessment: undefined,
  });
  if (apiVersionSourceBlocked(preflight.apiVersion, options.leaveReviewedFindings))
    throw new PipelineInputError(`Validation is blocked. ${preflight.apiVersion.reason}`);
  const reviewReason = options.leaveReviewedFindings
    ? undefined
    : migrationReviewReason(preflight, true, true, Boolean(options.aiPatch));
  if (reviewReason) throw new PipelineInputError(reviewReason);
  // Stripe code in one nested package with its own lockfile is prepared and checked there.
  const packageDirectory = sdkPackageDirectory(preflight, committedFiles(snapshot.entries));
  const sandbox: CheckSandbox = { timeoutMs, packageDirectory };
  const git = (args: string[]) =>
    command('git', ['-c', 'core.fsmonitor=false', '-C', repository, ...args]);
  const { revision, entries } = snapshot;
  const runtime = await selectValidationRuntime(snapshot, options.image);
  const image = await resolveDockerImage(runtime.image);
  const root = await mkdtemp(join(tmpdir(), 'refit-validation-'));
  // Wall-clock milliseconds per stage, summed over repeats; they vary between runs.
  const timings: Record<string, number> = {};
  const timed = async <T>(stage: string, work: () => Promise<T>) => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      timings[stage] = (timings[stage] ?? 0) + Math.round(performance.now() - started);
    }
  };
  // Without AI the proposal does not depend on the baseline, so when the Docker host has room for
  // two sandboxes the patch, its dependencies and its checks run alongside the baseline's. Results the sequential order would not have used are
  // discarded unread; anything still running is cancelled and awaited before validation returns.
  const independent = !options.aiPatch && !options.assessment && (await roomForTwoSandboxes());
  const speculation = new AbortController();
  const stopSpeculation = () => speculation.abort();
  options.signal?.addEventListener('abort', stopSpeculation, { once: true });
  const speculative: Promise<unknown>[] = [];
  const ahead = <T>(work: () => Promise<T>) => {
    const promise = work();
    promise.catch(() => undefined);
    speculative.push(promise);
    return promise;
  };
  try {
    const { archive, archiveHash, baselineDirectory } = await timed('snapshot', () =>
      extractSnapshot(repository, revision, root),
    );
    const propose = (baselinePassed: boolean) =>
      timed('proposal', () =>
        runPipeline({
          ...options,
          repository: baselineDirectory,
          proposePatch: true,
          aiPatch: baselinePassed ? options.aiPatch : undefined,
          assessment: baselinePassed ? options.assessment : undefined,
          onProgress: baselinePassed ? options.onProgress : undefined,
        }),
      );
    const proposed = independent ? ahead(() => propose(true)) : undefined;
    // With recordUntested, a patched lockfile Refit cannot install leaves the initial patch
    // untested (owner decision 1) instead of ending the run.
    const preparePatched = async (directory: string, untested: boolean, signal?: AbortSignal) => {
      try {
        return {
          ...(await timed('candidatePreparation', () =>
            prepareCandidateDependencies(directory, root, image, {
              ...options,
              packageDirectory,
              signal,
            }),
          )),
          dependencyFailure: undefined,
        };
      } catch (error) {
        const failure = untested && options.recordUntested ? preparationFailure(error) : undefined;
        if (!failure) throw error;
        options.onProgress?.(`Preparing the patched dependencies failed: ${failure.summary}`);
        return { dependencies: undefined, environment: undefined, dependencyFailure: failure };
      }
    };
    // A patch that changes the lockfile prepares its own dependencies; that install starts now.
    const candidateInstall =
      proposed && options.prepareDependencies
        ? ahead(async () => {
            const { patch } = await proposed;
            const diff = 'diff' in patch ? patch.diff : '';
            if (!diff || !packageDiff(diff, packageDirectory)) return undefined;
            const directory = await sandboxInput(root, 'candidate-');
            await applyPatch(archive, directory, `${directory}.patch`, diff);
            return { directory, ...(await preparePatched(directory, true, speculation.signal)) };
          })
        : undefined;
    let dependencies: string | undefined;
    let environment: Record<string, unknown> | undefined;
    let dependencyFailure: ReturnType<typeof preparationFailure> = undefined;
    // The baseline checks failed with recordUntested: the patch is built but its checks never run.
    let untestedBaseline = false;
    let prepared: Awaited<ReturnType<typeof prepareDependencies>> | undefined;
    if (options.prepareDependencies)
      try {
        prepared = await timed('preparation', () =>
          prepareEnvironment({
            repository,
            image,
            packageDirectory,
            submodules: options.leaveReviewedFindings,
            copyArchiveTo: join(root, 'dependencies.tar'),
            signal: options.signal,
            onProgress: options.onProgress,
          }),
        );
      } catch (error) {
        // Behaviour tests may still run with only stripe installed (stripeOnlyDependencies).
        dependencyFailure =
          options.recordUntested || options.behaviourTestWriter
            ? preparationFailure(error)
            : undefined;
        if (!dependencyFailure) throw error;
        options.onProgress?.(`Dependency preparation failed: ${dependencyFailure.summary}`);
      }
    if (prepared) {
      dependencies = join(root, 'dependencies.tar');
      environment = await timed('dependencySnapshot', () =>
        snapshotDependencies(prepared!, dependencies!),
      );
    }
    type Report = Awaited<ReturnType<typeof runPipeline>>;
    type ProposedReport = Report & { patch: Extract<Report['patch'], { diff: string }> };
    const hasDiff = (entry: Report): entry is ProposedReport => 'diff' in entry.patch;
    type Install = Awaited<NonNullable<typeof candidateInstall>>;
    const prepareCandidate = (
      diff: string,
      originalSources: Awaited<ReturnType<typeof readRepository>>,
      report: Report,
      install?: Promise<Install>,
      untested = false,
    ) =>
      timed('candidates', () => buildCandidate(diff, originalSources, report, install, untested));
    const buildCandidate = async (
      diff: string,
      originalSources: Awaited<ReturnType<typeof readRepository>>,
      report: Report,
      install: Promise<Install> | undefined,
      untested: boolean,
    ) => {
      // The install started with the proposal, for this diff, when the patch changes the lockfile.
      const installed = install && (await install);
      // Reusing a removed bind-mount path can expose a stale directory in Docker Desktop.
      const patchedDirectory = installed?.directory ?? (await sandboxInput(root, 'candidate-'));
      if (!installed)
        await applyPatch(archive, patchedDirectory, `${patchedDirectory}.patch`, diff);
      // An SDK upgrade in the patch needs dependencies prepared from the patched lockfile, which
      // preparation reads from a committed snapshot.
      let candidateDependencies = dependencies;
      let candidateEnvironment: Record<string, unknown> | undefined;
      let candidateFailure: ReturnType<typeof preparationFailure>;
      if (
        packageDiff(diff, packageDirectory) &&
        options.prepareDependencies &&
        !dependencyFailure &&
        !untestedBaseline
      )
        ({
          dependencies: candidateDependencies,
          environment: candidateEnvironment,
          dependencyFailure: candidateFailure,
        } = installed ?? (await preparePatched(patchedDirectory, untested, options.signal)));
      const patchedSources = await readRepository(patchedDirectory, report.adapter.packageName);
      const shopify = report.provider === SHOPIFY.id;
      const declarations = shopify
        ? shopifyVersionDeclarations(patchedSources)
        : analyzeRepository(patchedSources, [], report.adapter).apiVersionDeclarations;
      // Moving every literal pin to the target version is part of the migration, so the patched
      // code is checked against that version instead of the original one.
      const literals = declarations.filter((declaration) => declaration.status === 'literal');
      const bumped =
        report.apiVersion.after !== null &&
        literals.length > 0 &&
        literals.every((declaration) => declaration.value === report.apiVersion.after);
      const candidateVersion = compareApiVersion(
        (bumped ? report.apiVersion.after : report.apiVersion.application) ?? undefined,
        { info: { version: report.apiVersion.before } },
        { info: { version: report.apiVersion.after } },
        { configured: shopify || Boolean(report.adapter.apiVersion), declarations },
        report.apiVersion.policy,
      );
      // Owner decision 1: pins that conflicted in the committed code may still conflict.
      if (
        apiVersionSourceBlocked(candidateVersion, options.leaveReviewedFindings) ||
        (report.apiVersion.source.status === 'verified' &&
          candidateVersion.source.status !== 'verified')
      )
        throw new PipelineInputError(
          'Migration proposal changes or weakens the verified SDK API-version declarations; inspect the version rollout separately.',
        );
      const publicationFiles: PublicationFile[] = [];
      const packageFiles = await Promise.all(
        [
          ...PACKAGE_FILES,
          ...(packageDirectory ? PACKAGE_FILES.map((file) => `${packageDirectory}/${file}`) : []),
        ].map(async (path) => ({
          path,
          before: await readFile(join(baselineDirectory, path), 'utf8').catch(() => undefined),
          after: await readFile(join(patchedDirectory, path), 'utf8').catch(() => undefined),
        })),
      );
      for (const file of [
        ...patchedSources.files,
        ...packageFiles
          .filter((file) => file.before !== undefined && file.after !== undefined)
          .map((file) => ({ path: file.path, content: file.after! })),
      ]) {
        const original =
          originalSources.files.find((source) => source.path === file.path) ??
          packageFiles
            .filter((source) => source.path === file.path && source.before !== undefined)
            .map((source) => ({ path: source.path, content: source.before! }))[0];
        // A file the patch creates (the generated period helper) has no committed original.
        if (!original && !entries.some((entry) => entry.endsWith(`\t${file.path}`))) {
          publicationFiles.push({ path: file.path, mode: '100644', content: file.content });
          continue;
        }
        if (!original || original.content === file.content) continue;
        publicationFiles.push({
          path: file.path,
          mode: committedMode(entries, file.path, original.content),
          content: file.content,
        });
      }
      return {
        publicationFiles,
        sources: patchedSources,
        directory: patchedDirectory,
        dependencies: candidateDependencies,
        environment: candidateEnvironment,
        dependencyFailure: candidateFailure,
      };
    };
    options.signal?.throwIfAborted();
    const earlyReport = proposed && (await proposed);
    const earlyDiff =
      earlyReport && 'diff' in earlyReport.patch ? earlyReport.patch.diff : undefined;
    // Built only to run beside the baseline; used only where the sequential order would use it.
    const speculativeCandidate =
      earlyReport && earlyDiff && !dependencyFailure
        ? ahead(async () =>
            prepareCandidate(
              earlyDiff,
              await readRepository(baselineDirectory, earlyReport.adapter.packageName),
              earlyReport,
              candidateInstall,
              true,
            ),
          )
        : undefined;
    const speculativePatched =
      speculativeCandidate &&
      ahead(async () => {
        const candidate = await speculativeCandidate;
        if (candidate.dependencyFailure) return NOT_RUN;
        return timed('patchedChecks', () =>
          containerCheck({
            directory: candidate.directory,
            image,
            command: options.command,
            dependencies: candidate.dependencies,
            signal: speculation.signal,
            ...sandbox,
          }),
        );
      });
    const recordedBaseline = dependencyFailure
      ? undefined
      : await timed('baselineChecks', () =>
          baselineCheck(
            {
              revision,
              command: baselineCommand,
              image,
              // The bundle's signature, not its archive hash: a rebuild changes tar bytes, not packages.
              dependencies: environment?.signature ?? null,
              limits: validationLimits(sandbox.timeoutMs),
            },
            () => {
              options.onProgress?.('Running baseline checks in offline Docker...');
              return containerCheck({
                directory: baselineDirectory,
                image,
                command: baselineCommand,
                dependencies,
                signal: options.signal,
                ...sandbox,
              });
            },
          ),
        );
    const baselineRun: CheckResult = recordedBaseline?.check ?? NOT_RUN;
    if (recordedBaseline?.recordedAt)
      options.onProgress?.(
        `Reusing the baseline check result recorded ${recordedBaseline.recordedAt}.`,
      );
    const advisory = advisoryTypeError(options.command);
    const typeCheckUnavailable = options.compareTypeErrors
      ? unavailableTypeCheck(options.command, baselineRun)
      : undefined;
    const { baseline, compared, noTests } = typeCheckComparison(
      baselineRun,
      options.compareTypeErrors,
      advisory,
      typeCheckUnavailable,
    );
    // An unavailable generated type check with no tests is no check: the patch is kept untested.
    const noCheck = Boolean(typeCheckUnavailable) && !typeCheckCommand(options.command);
    // Tests that fail on the original code leave a chain's type check to compare (Laptop 1's ruling
    // on #288): the type check alone runs on the patch, so the patch's checks still never ran.
    const testsBroken =
      Boolean(options.compareTypeErrors) &&
      baselineRun.stdout.includes(TESTS_FAILED) &&
      baselineRun.stdout.includes(TYPE_CHECK_STARTED) &&
      !typeCheckUnavailable &&
      !noTests;
    untestedBaseline =
      Boolean(options.recordUntested) &&
      !dependencyFailure &&
      baseline.status !== 'passed' &&
      !testsBroken;
    options.signal?.throwIfAborted();
    const initialReport = earlyReport || (await propose(baseline.status === 'passed'));
    const configuredEndpointProposal = initialReport.operationChanges.some(
      (change) => change.usages.length > 0,
    );
    const configuredRequestProposal = initialReport.requestChanges?.some(
      (change) => change.usages.length > 0,
    );
    const [beforeSpecification, afterSpecification] = await Promise.all([
      readSpecification(options.before),
      readSpecification(options.after),
    ]);
    if (beforeSpecification.hash !== initialReport.snapshots.before)
      throw new PipelineInputError('Baseline specification changed during validation.');
    if (afterSpecification.hash !== initialReport.snapshots.after)
      throw new PipelineInputError('Current specification changed during validation.');
    if (
      !hasDiff(initialReport) ||
      (!initialReport.patch.diff && (baseline.status === 'passed' || dependencyFailure))
    )
      throw new PipelineInputError(
        'No supported patch proposal is available for this committed revision.',
      );
    // A type-checked period-read restore below may replace it with a new proposal.
    let report: ProposedReport = initialReport;
    let proposal = report.patch;
    const originalSources = await readRepository(baselineDirectory, report.adapter.packageName);
    // An untested patch is still applied, so its publication files come from the same candidate.
    // Behaviour tests need it too, even where the repository's own baseline failed or timed out.
    const behaviourWanted = Boolean(options.behaviourTestWriter || options.behaviourTests?.length);
    let candidateFailure: string | undefined;
    const initialCandidate =
      baseline.status === 'passed' ||
      dependencyFailure ||
      testsBroken ||
      noCheck ||
      (untestedBaseline && proposal.diff)
        ? await (speculativeCandidate && baseline.status === 'passed'
            ? speculativeCandidate
            : prepareCandidate(proposal.diff, originalSources, report, undefined, true))
        : behaviourWanted && proposal.diff
          ? // Built only for behaviour tests: a failure blocks them, never the validation.
            await prepareCandidate(proposal.diff, originalSources, report).catch(
              (error: unknown) => {
                options.signal?.throwIfAborted();
                candidateFailure = error instanceof Error ? error.message : String(error);
                return undefined;
              },
            )
          : undefined;
    // The patched lockfile could not be installed, so the patch is written but never checked.
    dependencyFailure ??= initialCandidate?.dependencyFailure;
    let publicationFiles = initialCandidate?.publicationFiles ?? [];
    let candidateDirectory = initialCandidate?.directory;
    let candidateSources = initialCandidate?.sources;
    // A deterministic proposal is the rules' output; AI repairs are guarded against it.
    let ruleSources =
      report.patch.generator === 'deterministic' ? initialCandidate?.sources.files : undefined;
    let candidateDependencies = initialCandidate?.dependencies;
    let candidateEnvironment = initialCandidate?.environment;
    const runPatched = initialCandidate && baseline.status === 'passed' && !dependencyFailure;
    if (runPatched) options.onProgress?.('Running patched checks in offline Docker...');
    let patched: CheckResult = runPatched
      ? compared(
          await (speculativePatched && baseline.status === 'passed'
            ? speculativePatched
            : timed('patchedChecks', () =>
                containerCheck({
                  directory: initialCandidate.directory,
                  image,
                  command: options.command,
                  dependencies: initialCandidate.dependencies,
                  signal: options.signal,
                  ...sandbox,
                }),
              )),
        )
      : NOT_RUN;
    const attempts: ValidationAttempt[] = [];
    const recordAttempt = () =>
      attempts.push({
        number: attempts.length + 1,
        patchHash: digest(proposal.diff),
        diff: proposal.diff,
        check: patched,
        responseId: 'responseId' in proposal ? proposal.responseId : null,
        evidenceHash: 'evidenceHash' in proposal ? proposal.evidenceHash : null,
        usage: 'usage' in proposal ? proposal.usage : null,
        costUsd: 'budget' in proposal ? (proposal.budget?.costUsd ?? null) : null,
        ...('rejectedProposals' in proposal
          ? { rejectedProposals: proposal.rejectedProposals }
          : {}),
      });
    if (initialCandidate) recordAttempt();
    const requestRemovals = removedRequestParameters(
      report.adapter,
      beforeSpecification.document,
      afterSpecification.document,
      { keepListedPaymentMethods: options.keepListedPaymentMethods },
    );
    const removedParameters = [...new Set(requestRemovals.map((removal) => removal.parameter))];
    let repair: {
      limit: number;
      requested: number;
      stopReason: string;
      error: string | null;
      // The open-enum restore applied to part of the errors before an AI repair of the rest.
      openEnumRestored?: boolean;
      // Subscription-period reads moved to the helper because the patched type check rejected them.
      typeCheckedPeriodReads?: number;
      // Request properties stripe-node 13 stopped typing, which the restore keeps sending unchanged.
      keptProperties?: string[];
      // The restore kept only such properties and changed no enum types.
      enumsUnchanged?: boolean;
    } = {
      limit: repairLimit,
      requested: 0,
      stopReason: dependencyFailure
        ? 'dependencies-unavailable'
        : baseline.status === 'passed'
          ? configuredEndpointProposal
            ? 'configured-endpoint-replacement'
            : configuredRequestProposal
              ? 'configured-request-rename'
              : 'not-needed-or-disabled'
          : 'baseline-failed',
      error: null,
    };
    // stripe-node 22.4.0 widened open response enums with OtherString. Before any AI repair, a
    // deterministic repair restores their known literals where the upgraded types reject them. It
    // is kept when every introduced error is that shape and the checks then pass, or, before an AI
    // repair of a rules proposal, when the checks then fail only on the errors it left alone: the
    // model then repairs those errors on the restored candidate instead of all of them. The same
    // restore keeps sending the request properties stripe-node 13.0.0 stopped typing.
    const sdkUpgrade =
      'sdkUpgrade' in report.patch
        ? (report.patch.sdkUpgrade as { from?: string; to?: string } | undefined)
        : undefined;
    // Subscription-period reads the upgraded types reject (TYPE_CHECKED_PERIOD_READS) are proposed
    // again through the period helper. The result is kept when the checks then pass, or fail only on
    // other errors the first candidate already had, which the restores and repairs below may fix.
    const periodErrors =
      TYPE_CHECKED_PERIOD_READS &&
      baseline.status === 'passed' &&
      patched.status === 'failed' &&
      options.compareTypeErrors &&
      candidateSources &&
      sdkUpgrade?.to &&
      'generator' in report.patch &&
      report.patch.generator === 'deterministic' &&
      'ruleEdits' in report.patch
        ? introducedTypeErrors(baselineRun, patched).filter(subscriptionPeriodRead)
        : [];
    const checkedReads =
      periodErrors.length && candidateSources && 'ruleEdits' in report.patch
        ? typeCheckedPeriodReads(
            periodErrors,
            candidateSources.files,
            originalSources.files,
            report.patch.ruleEdits as SourceEdit[],
          )
        : undefined;
    if (checkedReads?.length) {
      const reproposed = await timed('proposal', () =>
        runPipeline({
          ...options,
          repository: baselineDirectory,
          proposePatch: true,
          aiPatch: undefined,
          assessment: undefined,
          onProgress: undefined,
          typeCheckedPeriodReads: checkedReads,
        }),
      );
      const covered =
        reproposed.findings.filter((finding) => finding.typeChecked).length >=
        new Set(checkedReads.map((read) => `${read.file}\0${read.position}`)).size;
      if (hasDiff(reproposed) && reproposed.patch.diff && covered) {
        options.onProgress?.(
          'Moving type-checked subscription period reads to the helper; running checks in offline Docker...',
        );
        const prepared = await prepareCandidate(reproposed.patch.diff, originalSources, reproposed);
        const check = compared(
          await timed('patchedChecks', () =>
            containerCheck({
              directory: prepared.directory,
              image,
              command: options.command,
              dependencies: prepared.dependencies,
              signal: options.signal,
              ...sandbox,
            }),
          ),
        );
        const earlier = new Set(
          introducedTypeErrors(baselineRun, patched).map((error) => error.key),
        );
        const left = introducedTypeErrors(baselineRun, check);
        if (
          check.status === 'passed' ||
          (check.status === 'failed' &&
            left.length > 0 &&
            left.every((error) => earlier.has(error.key) && !subscriptionPeriodRead(error)))
        ) {
          report = reproposed;
          proposal = reproposed.patch;
          publicationFiles = prepared.publicationFiles;
          candidateDirectory = prepared.directory;
          candidateSources = prepared.sources;
          candidateDependencies = prepared.dependencies;
          candidateEnvironment = prepared.environment;
          ruleSources = prepared.sources.files;
          patched = check;
          recordAttempt();
          repair.typeCheckedPeriodReads = checkedReads.length;
        }
      }
    }
    const introducedByRules =
      baseline.status === 'passed' &&
      patched.status === 'failed' &&
      options.compareTypeErrors &&
      candidateSources &&
      sdkUpgrade?.from &&
      sdkUpgrade.to &&
      (crossesOpenEnums(sdkUpgrade.from, sdkUpgrade.to) ||
        (KEEP_UNTYPED_REQUEST_PROPERTIES && crossesTypeRemovals(sdkUpgrade.from, sdkUpgrade.to)))
        ? introducedTypeErrors(baselineRun, patched)
        : [];
    const openEnumErrors =
      candidateSources && options.aiPatch && ruleSources
        ? restorableOpenEnumErrors(candidateSources.files, introducedByRules)
        : introducedByRules;
    const openEnumFiles =
      candidateSources && openEnumErrors.length
        ? openEnumRepair(candidateSources.files, openEnumErrors)
        : undefined;
    if (openEnumFiles?.length && candidateSources) {
      const current = new Map(candidateSources.files.map((file) => [file.path, file.content]));
      const diff =
        proposal.diff +
        renderPatch(
          {
            ...candidateSources,
            files: openEnumFiles.map((file) => ({
              path: file.path,
              content: current.get(file.path)!,
            })),
          },
          openEnumFiles.map((file) => ({
            file: file.path,
            start: 0,
            end: current.get(file.path)!.length,
            replacement: file.content,
            changeId: OPEN_ENUM_RULE,
          })),
        );
      options.onProgress?.(
        'Restoring stripe-node open-enum literals; running checks in offline Docker...',
      );
      const prepared = await prepareCandidate(diff, originalSources, report);
      const check = compared(
        await timed('patchedChecks', () =>
          containerCheck({
            directory: prepared.directory,
            image,
            command: options.command,
            dependencies: prepared.dependencies,
            signal: options.signal,
            ...sandbox,
          }),
        ),
      );
      if (
        check.status === 'passed' ||
        (check.status === 'failed' &&
          keepsPartialRestore(
            introducedByRules,
            openEnumErrors,
            introducedTypeErrors(baselineRun, check),
          ))
      ) {
        proposal = { ...proposal, diff };
        publicationFiles = prepared.publicationFiles;
        candidateDirectory = prepared.directory;
        candidateSources = prepared.sources;
        candidateDependencies = prepared.dependencies;
        candidateEnvironment = prepared.environment;
        patched = check;
        recordAttempt();
        const kept = openEnumErrors.flatMap((error) => untypedRequestProperty(error) ?? []);
        if (kept.length) {
          repair.keptProperties = [...new Set(kept.map((entry) => entry.property))];
          if (kept.length === openEnumErrors.length) repair.enumsUnchanged = true;
        }
        if (check.status === 'passed') repair.stopReason = OPEN_ENUM_REPAIR;
        else {
          repair.openEnumRestored = true;
          // The restore is a rule edit, so the AI guards do not count it as the model's.
          ruleSources = prepared.sources.files;
        }
      }
    }
    // Every AI request's cost, whether its proposal was checked or refused.
    let aiCostUsd = costOf(proposal);
    const aiCoverage =
      Boolean(options.aiPatch && options.leaveReviewedFindings) && !aiSafetyStop(report);
    const configuredPeriods = report.findings.some(
      (finding) => finding.webhook?.migration?.rule === SUBSCRIPTION_PERIOD_RULE,
    );
    // Owner decisions 1 and 8 (2026-10-24): once the rules' patch passes its checks, AI attempts
    // what the rules left (coverage stops) on top of it, the rules' lines frozen, unless a safety
    // stop holds. It is kept only if its checks pass, after repair; otherwise the rules' patch
    // stays the result and the attempt is recorded.
    const rules =
      aiCoverage &&
      report.patch.generator === 'deterministic' &&
      baseline.status === 'passed' &&
      patched.status === 'passed' &&
      candidateSources &&
      !configuredEndpointProposal &&
      !configuredRequestProposal &&
      !configuredPeriods
        ? {
            proposal,
            publicationFiles,
            candidateDirectory,
            candidateSources,
            candidateDependencies,
            candidateEnvironment,
            patched,
            attempts: attempts.length,
            repair,
          }
        : undefined;
    // A removed request parameter is its own finding, which the model may not change.
    const removedParameter = (impact: (typeof report.operationImpacts)[number], text: string) =>
      requestRemovals.some(
        (removal) =>
          removal.operationId === impact.operationId &&
          text === `removed the request property \`${removal.parameter}\``,
      );
    // What the rules left in `files`: removed-field reads, traced or not, and calls traced to a
    // breaking change no rule migrates, at their lines in `files`. Test files stay as written.
    const coverageTargets = (files: Repository['files']) =>
      [
        ...analyzeRepository(
          { ...originalSources, files },
          report.changes,
          report.adapter,
          beforeSpecification.schemas,
        ).findings.filter((finding) => finding.confidence === 'confirmed' || finding.untraced),
        ...report.operationImpacts.flatMap((impact) => {
          const changes = impact.changes.filter((change) => !removedParameter(impact, change.text));
          return changes.length
            ? impact.usages.flatMap((usage) => {
                const before = originalSources.files.find((file) => file.path === usage.file);
                const after = files.find((file) => file.path === usage.file);
                const line =
                  before && after && movedLine(before.content, after.content, usage.line);
                return line
                  ? [
                      {
                        file: usage.file,
                        line,
                        column: usage.column,
                        changeId: CONTRACT_CHANGE,
                        expression: `${impact.httpMethod.toUpperCase()} ${impact.path}`,
                        confidence: 'confirmed' as const,
                        reason: `${changes
                          .slice(0, MAX_TARGET_CHANGES)
                          .map((change) => change.text)
                          .join(
                            '; ',
                          )}${changes.length > MAX_TARGET_CHANGES ? `; and ${changes.length - MAX_TARGET_CHANGES} more` : ''}`,
                      },
                    ]
                  : [];
              })
            : [];
        }),
      ].filter((finding) => !TEST_PATH.test(finding.file));
    const targets = rules ? coverageTargets(rules.candidateSources.files) : [];
    // Calls traced to breaking changes count as unresolved without a rescan site (run.ts); no
    // rescan shows whether the model handled them, so they stay unresolved.
    const operationUsages =
      'unresolvedSites' in proposal && proposal.unresolvedSites
        ? proposal.unresolvedFindings - proposal.unresolvedSites.length
        : 0;
    // A coverage proposal keeps what the rules' patch reports beyond its own rescan.
    const onRules = (candidate: Awaited<ReturnType<typeof proposeAiPatch>>) => ({
      ...candidate,
      unresolvedFindings: candidate.unresolvedFindings + operationUsages,
      ...('sdkUpgrade' in report.patch ? { sdkUpgrade: report.patch.sdkUpgrade } : {}),
    });
    let coverage: CoverageAttempt | undefined;
    const charge = (value: unknown) => {
      const cost = costOf(value);
      aiCostUsd += cost;
      if (coverage) coverage.costUsd += cost;
    };
    if (rules && targets.length) {
      repair = { ...repair };
      coverage = { outcome: 'no-proposal', costUsd: 0, targets: unresolvedSites(targets) };
      options.onProgress?.('Requesting an AI proposal for what the rules left unresolved...');
      try {
        options.signal?.throwIfAborted();
        const ruleEdits = 'ruleEdits' in report.patch ? (report.patch.ruleEdits ?? []) : [];
        const candidate = await proposeAiPatch(
          originalSources,
          report.changes,
          report.findings.filter((finding) => !finding.requestParameter),
          options.aiPatch!,
          report.adapter,
          beforeSpecification.schemas,
          undefined,
          options.documentationSnapshots,
          afterSpecification.schemas,
          ruleEdits,
          { files: rules.candidateSources.files, rules: rules.candidateSources.files, targets },
          requestRemovals,
        );
        charge(candidate);
        if (candidate.escalation) coverage.escalation = candidate.escalation;
        // The model's edits are the proposal's beyond the rules'.
        if (candidate.edits <= ruleEdits.length)
          coverage.response = {
            id: candidate.responseId,
            summary: candidate.summary,
            uncertainties: candidate.uncertainties,
          };
        else {
          candidate.diff += packageDiff(report.patch.diff);
          const prepared = await prepareCandidate(candidate.diff, originalSources, report);
          options.onProgress?.('Running checks on the AI proposal in offline Docker...');
          const check = compared(
            await timed('patchedChecks', () =>
              containerCheck({
                ...sandbox,
                directory: prepared.directory,
                image,
                command: options.command,
                dependencies: prepared.dependencies,
                signal: options.signal,
              }),
            ),
          );
          proposal = onRules(candidate);
          publicationFiles = prepared.publicationFiles;
          candidateDirectory = prepared.directory;
          candidateSources = prepared.sources;
          candidateDependencies = prepared.dependencies;
          candidateEnvironment = prepared.environment;
          patched = check;
          recordAttempt();
          coverage.outcome = 'checks-failed';
        }
      } catch (error) {
        // A failed request leaves the rules' patch, as a failed repair leaves its candidate.
        if (!(error instanceof Error) || options.signal?.aborted) throw error;
        charge(error);
        coverage.outcome = 'refused';
        coverage.error = `${error.name}: ${error.message}`;
      }
    }
    while (
      baseline.status === 'passed' &&
      patched.status === 'failed' &&
      repair.requested < repairLimit &&
      options.aiPatch &&
      !configuredEndpointProposal &&
      !configuredRequestProposal &&
      !report.findings.some(
        (finding) => finding.webhook?.migration?.rule === SUBSCRIPTION_PERIOD_RULE,
      )
    ) {
      const latestRevision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
      if (
        latestRevision !== revision ||
        (await git(['status', '--porcelain', '--untracked-files=all'])).stdout
      ) {
        repair.stopReason = 'stale-repository';
        break;
      }
      const introduced = options.compareTypeErrors
        ? introducedTypeErrors(baselineRun, patched)
        : [];
      // Only review items remain: another round would have nothing it may fix.
      if (introduced.length && introduced.every(reviewTypeError)) {
        repair.stopReason = 'review-required';
        break;
      }
      // No contract documents a property the upgraded types reject, and no repair passes without
      // dropping or replacing it, which changes what the code sends: a person decides.
      const rejected = options.compareTypeErrors ? rejectedProperties(baselineRun, patched) : [];
      if (rejected.length) {
        repair.stopReason = 'review-required';
        repair.error = `The upgraded types reject ${rejected.map((name) => `'${name}'`).join(', ')}; removing or replacing ${rejected.length === 1 ? 'it' : 'them'} changes what the code sends, so it stops for review.`;
        break;
      }
      const periodReads = introduced.filter(subscriptionPeriodRead);
      if (periodReads.length) {
        repair.stopReason = 'review-required';
        repair.error = `Stripe moved subscription billing periods onto subscription items, and ${periodReads.map((error) => `${error.file}:${error.line}`).join(', ')} still ${periodReads.length === 1 ? 'reads one' : 'read them'} from the subscription. Choosing an item is a reviewed rule (stripeSubscriptionPeriods), so it stops for review.`;
        break;
      }
      repair.requested++;
      options.onProgress?.(
        `Patched checks failed. Requesting AI repair ${repair.requested} of ${repairLimit}...`,
      );
      try {
        options.signal?.throwIfAborted();
        const candidate = await proposeAiPatch(
          originalSources,
          report.changes,
          [
            // Owner decisions 1 and 8: a removed request parameter no longer keeps AI out.
            ...report.findings.filter((finding) => !(aiCoverage && finding.requestParameter)),
            // Introduced type errors, at their positions in the failed candidate, become findings
            // the repair may fix, wherever they are.
            ...introduced
              .filter(
                (error) =>
                  !reviewTypeError(error) &&
                  candidateSources?.files.some((file) => file.path === error.file),
              )
              .map((error) => ({
                file: error.file,
                line: error.line,
                column: error.column,
                changeId: TYPE_ERROR_CHANGE,
                expression: error.code,
                confidence: 'confirmed' as const,
                reason: error.message,
              })),
          ],
          options.aiPatch,
          report.adapter,
          beforeSpecification.schemas,
          {
            attempt: repair.requested,
            failedPatch: compactPatch(codeDiff(proposal.diff)),
            check: {
              exitCode: patched.exitCode,
              stdout: patched.stdout.slice(0, MAX_REPAIR_LOG_CHARACTERS),
              stderr: patched.stderr.slice(0, MAX_REPAIR_LOG_CHARACTERS),
              truncated:
                patched.stdout.length > MAX_REPAIR_LOG_CHARACTERS ||
                patched.stderr.length > MAX_REPAIR_LOG_CHARACTERS,
            },
          },
          options.documentationSnapshots,
          afterSpecification.schemas,
          'ruleEdits' in report.patch ? report.patch.ruleEdits : [],
          // A coverage repair starts again from the rules' patch, with the failed attempt in view.
          rules && coverage?.outcome === 'checks-failed'
            ? {
                files: rules.candidateSources.files,
                rules: rules.candidateSources.files,
                targets,
              }
            : options.compareTypeErrors && candidateSources
              ? { files: candidateSources.files, rules: ruleSources }
              : undefined,
          // So a coverage repair's rescan still counts calls sending a removed parameter.
          rules && coverage ? requestRemovals : [],
        );
        charge(candidate);
        // The SDK upgrade is deterministic; repairs change only code and keep it.
        if (candidate.diff) candidate.diff += packageDiff(report.patch.diff);
        if (!candidate.diff) {
          repair.stopReason = 'no-proposal';
          break;
        }
        if (attempts.some((attempt) => attempt.patchHash === digest(candidate.diff))) {
          repair.stopReason = 'repeated-proposal';
          break;
        }
        const preparedCandidate = await prepareCandidate(candidate.diff, originalSources, report);
        // A removed request parameter has no reviewed replacement; a repair must not drop it.
        const dropped = droppedRequestParameters(
          removedParameters,
          originalSources.files,
          preparedCandidate.sources.files,
          ('ruleEdits' in report.patch ? report.patch.ruleEdits : undefined) ?? [],
        );
        if (dropped.length) {
          repair.stopReason = 'review-required';
          repair.error = `AI repair drops removed request parameter ${dropped.join(', ')}; it stops for review.`;
          break;
        }
        options.onProgress?.('Running repaired checks in offline Docker...');
        const check = compared(
          await timed('patchedChecks', () =>
            containerCheck({
              directory: preparedCandidate.directory,
              image,
              command: options.command,
              dependencies: preparedCandidate.dependencies,
              signal: options.signal,
              ...sandbox,
            }),
          ),
        );
        candidateDependencies = preparedCandidate.dependencies;
        candidateEnvironment = preparedCandidate.environment;
        proposal = coverage ? onRules(candidate) : candidate;
        publicationFiles = preparedCandidate.publicationFiles;
        candidateDirectory = preparedCandidate.directory;
        candidateSources = preparedCandidate.sources;
        patched = check;
        recordAttempt();
        repair.stopReason =
          patched.status === 'passed'
            ? 'checks-passed'
            : patched.status === 'error'
              ? 'execution-error'
              : 'attempt-limit';
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        charge(error);
        repair.stopReason = 'repair-error';
        repair.error = `${error.name}: ${error.message}`;
        break;
      }
    }
    const generatedFor = async (directory = candidateDirectory) =>
      options.generatedChecks &&
      directory &&
      candidateSources &&
      baseline.status === 'passed' &&
      patched.status === 'passed'
        ? await timed('generatedChecks', () =>
            generatedStripeChecks({
              settings: options.generatedChecks!,
              root,
              image,
              dependencies,
              original: originalSources,
              patched: candidateSources!,
              findings: report.findings,
              runs: [
                { directory: baselineDirectory, contract: options.before, side: 'before' },
                {
                  directory,
                  contract: options.after,
                  side: 'after',
                  dependencies: candidateDependencies,
                },
              ],
              sandbox,
              onProgress: options.onProgress,
              signal: options.signal,
            }),
          )
        : undefined;
    // With the tests broken before the patch, only the chain's type check runs on it.
    const brokenTestsCommand = testsBroken ? typeCheckCommand(options.command) : undefined;
    const brokenTestsTypeCheck =
      brokenTestsCommand && initialCandidate && !dependencyFailure
        ? compared(
            await timed('patchedChecks', () =>
              containerCheck({
                directory: initialCandidate.directory,
                image,
                command: brokenTestsCommand,
                dependencies: initialCandidate.dependencies,
                signal: options.signal,
                ...sandbox,
              }),
            ),
          )
        : undefined;
    let generated = await generatedFor();
    if (rules && coverage?.outcome === 'checks-failed') {
      if (checkStatus(baseline, patched, generated) === 'passed') {
        coverage.outcome = 'kept';
        coverage.resolved = resolvedSites(
          'unresolvedSites' in rules.proposal ? rules.proposal.unresolvedSites : undefined,
          'unresolvedSites' in proposal ? proposal.unresolvedSites : undefined,
        );
      } else {
        // Its checks failed after repair: it is never published, and the rules' patch stays.
        coverage.attempts = attempts.splice(rules.attempts);
        coverage.repair = repair;
        ({
          proposal,
          publicationFiles,
          candidateDirectory,
          candidateSources,
          candidateDependencies,
          candidateEnvironment,
          patched,
          repair,
        } = rules);
        generated = await generatedFor();
      }
    }
    const stripeOnly =
      dependencyFailure && candidateDirectory && candidateSources && behaviourWanted
        ? await timed('stripeOnlyPreparation', () =>
            stripeOnlyDependencies({
              root,
              image,
              original: { directory: baselineDirectory, repository: originalSources },
              patched: { directory: candidateDirectory!, repository: candidateSources! },
              findings: report.findings,
              signal: options.signal,
              onProgress: options.onProgress,
            }),
          )
        : undefined;
    // Behaviour tests run on every patched copy whose code can load, whether or not the
    // repository's own checks ran, except where the patched checks failed: that patch is never
    // published.
    const behaviourBlocked =
      !candidateDirectory || !candidateSources
        ? `No patched copy of the repository was built${candidateFailure ? `: ${candidateFailure}` : '.'}`
        : baseline.status === 'passed' && patched.status === 'failed'
          ? 'The patched checks failed, so the patch is not published.'
          : dependencyFailure && !stripeOnly?.dependencies
            ? `Dependencies could not be prepared, and the changed Stripe code cannot run on stripe alone: ${stripeOnly?.record.reasons?.join(' ') ?? 'no candidate.'}`
            : undefined;
    // Written from the original code and the preflight scan, which ran before any patch existed.
    const written =
      options.behaviourTestWriter && !options.behaviourTests
        ? behaviourBlocked
          ? { record: behaviourTestSkip(options.behaviourTestWriter, behaviourBlocked), files: [] }
          : await timed('behaviourTestWriter', () =>
              writeBehaviourTests({
                repository: originalSources,
                findings: preflight.findings,
                changes: preflight.changes,
                removals: requestRemovals,
                before: beforeSpecification,
                after: afterSpecification,
                // Where the patch changes the original code, so the tests reach every changed line.
                changedLines: changedStripeLines(
                  originalSources,
                  candidateSources!,
                  report.findings,
                ).original,
                ai: options.behaviourTestWriter!,
              }),
            )
        : undefined;
    const behaviourTests = options.behaviourTests ?? written?.files;
    const behaviour =
      behaviourTests?.length && !behaviourBlocked
        ? await timed('behaviourTests', () =>
            behaviourEvidence({
              tests: behaviourTests,
              settings: options.generatedChecks,
              image,
              root,
              original: {
                directory: baselineDirectory,
                contract: options.before,
                repository: originalSources,
                dependencies: stripeOnly?.dependencies?.original ?? dependencies,
              },
              patched: {
                directory: candidateDirectory!,
                contract: options.after,
                repository: candidateSources!,
                dependencies:
                  stripeOnly?.dependencies?.patched ?? candidateDependencies ?? dependencies,
              },
              findings: report.findings,
              sandbox,
              onProgress: options.onProgress,
              signal: options.signal,
            }),
          )
        : undefined;
    const currentRevision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    const currentStatus = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout;
    const validationStatus =
      currentRevision !== revision || currentStatus
        ? 'stale'
        : dependencyFailure || noCheck
          ? behaviour?.regressions.length
            ? 'regression'
            : 'untested'
          : checkStatus(baseline, patched, generated, behaviour);
    const failures = checkFailures(
      baselineCommand,
      options.command,
      baseline,
      patched,
      generated,
      behaviour,
    );
    const introducedByPatch = brokenTestsTypeCheck
      ? introducedTypeErrors(baselineRun, brokenTestsTypeCheck).filter(
          (error) => !advisory?.(error.file),
        )
      : [];
    // Errors the patch introduced in JavaScript only Refit's generated check reads: advisory.
    const advisoryErrors =
      advisory && !typeCheckUnavailable
        ? introducedTypeErrors(baselineRun, brokenTestsTypeCheck ?? patched).filter((error) =>
            advisory(error.file),
          )
        : [];
    const advisoryGrade = advisoryErrors.map((error) => ({
      file: error.file,
      text: formatTypeError(error),
    }));
    // The repository's own checks passed on both sides and only a generated stripe-mock check failed:
    // the grade still comes from what the repository's checks reached.
    const ownChecksPassed = baseline.status === 'passed' && patched.status === 'passed';
    // Every outcome is graded: without passing checks the patch is grade D, saying which check
    // failed or why none ran, so a [Needs review] draft can state it; tests broken before the
    // patch leave the type check as the evidence. Behaviour tests that give grade A count on
    // their own, also where the baseline failed, errored or could not be prepared: a broken check
    // never vetoes a correct patch. A regression is never graded A.
    const behaviourA =
      behaviour?.grade === 'A' && !['stale', 'regression'].includes(validationStatus);
    const ownGrade =
      (validationStatus === 'passed' || ownChecksPassed || behaviourA) && candidateSources
        ? await gradeEvidence({
            repository: candidateSources,
            command: options.command,
            changedFiles: publicationFiles.map((file) => file.path),
            generated,
            behaviour: behaviour && behaviourGrade(behaviour),
            advisory: advisoryGrade,
            typeCheckUnavailable,
            packageDirectory,
            testsFoundNone: noTests,
          })
        : undefined;
    const grade = ownGrade
      ? validationStatus === 'passed' || !generated
        ? ownGrade
        : {
            ...ownGrade,
            reason: `${ownGrade.reason} The generated stripe-mock checks returned ${generated.baseline.status} on the original code and ${generated.patched.status} on the patch.`,
          }
      : validationStatus === 'baseline-failed' && brokenTestsTypeCheck && candidateSources
        ? await gradeEvidence({
            repository: candidateSources,
            command: options.command,
            changedFiles: publicationFiles.map((file) => file.path),
            testsBroken: {
              reason: checkFailureText({
                checkFailures: failures.checkFailures?.filter(
                  (failure) => failure.side === 'baseline',
                ),
              }).trim(),
              typeCheck: !(
                typeCheckFinished(baselineRun) && typeCheckFinished(brokenTestsTypeCheck)
              )
                ? { passed: false, detail: 'the type check did not finish on both sides' }
                : introducedByPatch.length
                  ? {
                      passed: false,
                      detail: `the patch introduces ${introducedByPatch.length === 1 ? 'a type error' : `${introducedByPatch.length} type errors`}, first ${formatTypeError(introducedByPatch[0])}`,
                    }
                  : { passed: true },
            },
            advisory: advisoryGrade,
            packageDirectory,
          })
        : validationStatus === 'stale'
          ? undefined
          : ungradedEvidence(
              dependencyFailure
                ? `Dependencies could not be prepared, so no check ran: ${dependencyFailure.summary}`
                : noCheck
                  ? `No check ran: the generated type check is unavailable (${typeCheckUnavailable}), and the repository has no tests.`
                  : checkFailureText(failures).trim() ||
                    (generated
                      ? `The generated stripe-mock checks returned ${generated.baseline.status} on the original code and ${generated.patched.status} on the patch.`
                      : `Validation returned ${validationStatus}.`),
            );
    const typeOracle = await runTypeOracle({
      compareTypeErrors: options.compareTypeErrors,
      command: options.command,
      upgrade:
        'sdkUpgrade' in proposal
          ? (proposal.sdkUpgrade as { from?: string; to?: string } | undefined)
          : undefined,
      packages: packageDiff(proposal.diff, packageDirectory),
      // The final patch's own install; without one the target SDK is not what the checks ran on.
      dependencies:
        !dependencyFailure && candidateDependencies !== dependencies
          ? candidateDependencies
          : undefined,
      baseline: baselineRun,
      patched: brokenTestsTypeCheck ?? patched,
      typeCheckUnavailable,
      report,
      before: beforeSpecification.document as Record<string, unknown>,
      files: originalSources.files,
      packageDirectory,
      check: (diff, command, dependencies) =>
        timed('typeOracle', async () => {
          const directory = await sandboxInput(root, 'oracle-');
          await applyPatch(archive, directory, `${directory}.patch`, diff);
          options.onProgress?.('Type-checking the original code with the target stripe-node...');
          return containerCheck({
            directory,
            image,
            command,
            dependencies,
            signal: options.signal,
            ...sandbox,
          });
        }),
    });
    options.signal?.throwIfAborted();
    if (rules && coverage?.outcome === 'kept' && candidateSources) {
      const { failures, typeCheckOnly } = aiValidationGate({
        rules: rules.candidateSources,
        patched: candidateSources,
        provider: report.adapter,
        targets,
        unmapped: unmappedBreakingChanges(
          report.specificationDiff,
          report.changes,
          report.findings,
          report.operationChanges,
          report.requestChanges,
          report.expandedFields,
        ),
        typeChecked: typeOraclePasses(typeOracle),
        testsPassed:
          validationStatus === 'passed' &&
          !noTests &&
          (await runsTests(candidateSources, options.command, packageDirectory)),
        checksPassed: validationStatus === 'passed',
        typeCheckedFiles: typeCheckCoverage(candidateSources, options.command, packageDirectory),
      });
      coverage.gate = {
        passed: !failures.length,
        failures,
        ...(typeCheckOnly ? { typeCheckOnly } : {}),
      };
      // Under D2 the AI changed every reached call no rule migrates, so they no longer count.
      if (!failures.length)
        proposal = {
          ...proposal,
          unresolvedFindings: proposal.unresolvedFindings - operationUsages,
        };
    }
    // Owner decision D2b (2026-10-27): where the AI left an untraced read unchanged (it proposed
    // nothing more, or its kept patch passed the D2 gate), the read stops counting only when the
    // type oracle passed and TypeScript's checker shows its receiver is the repository's own type.
    // shortcut: a Stripe object assigned to a repository type with the field optional is not seen;
    // upgrade by following assignments into the receiver if a review finds one.
    if (
      rules &&
      coverage &&
      candidateSources &&
      (coverage.outcome === 'no-proposal' || coverage.gate?.passed) &&
      typeOraclePasses(typeOracle) &&
      'unresolvedSites' in proposal &&
      proposal.unresolvedSites
    ) {
      const reads = analyzeRepository(
        { ...originalSources, files: candidateSources.files },
        report.changes,
        report.adapter,
        beforeSpecification.schemas,
      ).findings.filter((finding) => finding.untraced && !TEST_PATH.test(finding.file));
      const local = localReceiverReads(candidateSources, reads);
      const left = resolvedSites(proposal.unresolvedSites, unresolvedSites(local));
      if (local.length && left.length === proposal.unresolvedSites.length - local.length) {
        coverage.localReads = unresolvedSites(local);
        proposal = {
          ...proposal,
          unresolvedFindings: proposal.unresolvedFindings - local.length,
          unresolvedSites: left,
        };
      }
    }
    const reviewTypeErrors = options.compareTypeErrors
      ? introducedTypeErrors(baselineRun, patched)
          .filter(reviewTypeError)
          .map(({ key, ...error }) => error)
      : [];
    const validation = {
      status: validationStatus,
      revision,
      image,
      runtime,
      ...(environment ? { environment } : {}),
      ...(dependencyFailure ? { dependencyFailure } : {}),
      // Left out of the snapshot (owner decision 1): nothing in them was scanned, built or tested.
      ...(snapshot.submodules.length ? { submodules: snapshot.submodules } : {}),
      ...(candidateEnvironment ? { patchedEnvironment: candidateEnvironment } : {}),
      command: options.command,
      baselineCommand,
      ...(options.compareTypeErrors ? { compareTypeErrors: true } : {}),
      archiveHash,
      patchHash: digest(proposal.diff),
      baseline,
      // REFIT_BASELINE_CHECK_CACHE_DIRECTORY: the baseline result an identical earlier run recorded.
      ...(recordedBaseline?.recordedAt
        ? { baselineReused: { recordedAt: recordedBaseline.recordedAt } }
        : {}),
      patched,
      ...(generated ? { generated } : {}),
      ...(stripeOnly ? { stripeOnly: stripeOnly.record } : {}),
      ...(written ? { behaviourTestWriter: written.record } : {}),
      ...(behaviour ? { behaviour } : {}),
      ...(grade ? { grade } : {}),
      attempts,
      repair,
      ...(options.aiPatch ? { aiCostUsd } : {}),
      ...(coverage ? { coverageAi: coverage } : {}),
      ...(reviewTypeErrors.length ? { reviewTypeErrors } : {}),
      ...(advisoryErrors.length
        ? { advisoryTypeErrors: advisoryErrors.map(({ key, ...error }) => error) }
        : {}),
      ...(typeCheckUnavailable ? { typeCheckUnavailable } : {}),
      ...(typeOracle ? { typeOracle } : {}),
      ...namedBaselineStop(validationStatus, baselineRun),
      ...(brokenTestsTypeCheck
        ? { brokenTestsTypeCheck: { command: brokenTestsCommand, patched: brokenTestsTypeCheck } }
        : {}),
      ...failures,
      ...(Object.keys(timings).length ? { timings } : {}),
      ...(packageDirectory ? { packageDirectory } : {}),
      limits: validationLimits(timeoutMs),
      publishable: false,
      reason:
        'Validation records check results only. Draft publication requires an explicit GitHub target and passing checks; migration semantics require human review.',
    };
    return {
      ...report,
      patch: { ...proposal, validation: validationStatus },
      validation,
      publicationFiles,
    };
  } finally {
    speculation.abort();
    options.signal?.removeEventListener('abort', stopSpeculation);
    await Promise.allSettled(speculative);
    await rm(root, { recursive: true, force: true });
  }
}

// Validates a source patch that does not come from a contract change, such as a model replacement:
// baseline checks on the committed snapshot, then the same checks with the patch applied, in the
// same offline sandbox and limits as contract migrations. `propose` reads the extracted snapshot,
// so the patch always matches the revision that is checked and published.
export async function validateSourcePatch(options: {
  repository: string;
  propose: (directory: string) => Promise<string | null>;
  // Returns early, without running checks, when this revision and patch were already handled.
  skip?: (revision: string, patchHash: string) => boolean;
  image: string;
  command: string[];
  baselineCommand?: string[];
  checkTimeoutSeconds?: number;
  prepareDependencies?: boolean;
  compareTypeErrors?: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}) {
  validateCheckCommand(options.command);
  const baselineCommand = validateCheckCommand(options.baselineCommand ?? options.command);
  const sandbox: CheckSandbox = {
    timeoutMs: validateCheckTimeout(options.checkTimeoutSeconds) * 1000,
  };
  const snapshot = await readCommittedRepository(options.repository);
  const { revision, entries } = snapshot;
  const runtime = await selectValidationRuntime(snapshot, options.image);
  const image = await resolveDockerImage(runtime.image);
  const root = await mkdtemp(join(tmpdir(), 'refit-source-patch-'));
  try {
    const { archive, archiveHash, baselineDirectory } = await extractSnapshot(
      snapshot.directory,
      revision,
      root,
    );
    const diff = await options.propose(baselineDirectory);
    if (!diff) return { status: 'no-patch' as const, revision };
    if (options.skip?.(revision, digest(diff)))
      return { status: 'skipped' as const, revision, patchHash: digest(diff) };
    options.signal?.throwIfAborted();
    const candidateDirectory = join(root, 'candidate');
    await mkdir(candidateDirectory);
    await applyPatch(archive, candidateDirectory, join(root, 'source.patch'), diff);
    // Only committed text files the patch changed are published, each checked against its blob.
    const [original, changed] = await Promise.all([
      readRepository(baselineDirectory),
      readRepository(candidateDirectory),
    ]);
    const publicationFiles: PublicationFile[] = [];
    for (const file of changed.files) {
      const before = original.files.find((source) => source.path === file.path);
      if (!before || before.content === file.content) continue;
      publicationFiles.push({
        path: file.path,
        mode: committedMode(entries, file.path, before.content),
        content: file.content,
      });
    }
    if (!publicationFiles.length)
      throw new PipelineInputError('The proposed patch changes no committed source file.');
    let dependencies: string | undefined;
    let environment: Record<string, unknown> | undefined;
    if (options.prepareDependencies) {
      dependencies = join(root, 'dependencies.tar');
      const prepared = await prepareEnvironment({
        repository: snapshot.directory,
        image,
        copyArchiveTo: dependencies,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      environment = await snapshotDependencies(prepared, dependencies);
    }
    options.signal?.throwIfAborted();
    options.onProgress?.('Running baseline checks in offline Docker...');
    const baselineRun = await containerCheck({
      directory: baselineDirectory,
      image,
      command: baselineCommand,
      dependencies,
      signal: options.signal,
      ...sandbox,
    });
    const { baseline, compared } = typeCheckComparison(
      baselineRun,
      options.compareTypeErrors,
      advisoryTypeError(options.command),
    );
    let patched: CheckResult = NOT_RUN;
    let candidateEnvironment: Record<string, unknown> | undefined;
    if (baseline.status === 'passed') {
      options.signal?.throwIfAborted();
      let candidateDependencies = dependencies;
      if (options.prepareDependencies && packageDiff(diff))
        ({ dependencies: candidateDependencies, environment: candidateEnvironment } =
          await prepareCandidateDependencies(candidateDirectory, root, image, options));
      options.onProgress?.('Running patched checks in offline Docker...');
      patched = compared(
        await containerCheck({
          directory: candidateDirectory,
          image,
          command: options.command,
          dependencies: candidateDependencies,
          signal: options.signal,
          ...sandbox,
        }),
      );
    }
    const status = checkStatus(baseline, patched);
    return {
      status,
      revision,
      image,
      runtime,
      ...(environment ? { environment } : {}),
      ...(candidateEnvironment ? { candidateEnvironment } : {}),
      command: options.command,
      baselineCommand,
      archiveHash,
      diff,
      patchHash: digest(diff),
      baseline,
      patched,
      publicationFiles,
      ...namedBaselineStop(status, baselineRun),
      ...checkFailures(baselineCommand, options.command, baseline, patched),
      limits: validationLimits(sandbox.timeoutMs),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
