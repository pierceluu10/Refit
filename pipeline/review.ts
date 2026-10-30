import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import ts from 'typescript-compiler';
import { digest, isObject, type AddedProperty } from './specifications.ts';
import type { LockfileChoice } from './dependency-inputs.ts';
import { CURRENCY_CODE_RULE, PASSING_REACH } from './operation-reach.ts';
import { affectedFields } from './report-fields.ts';
import { PipelineInputError, type Finding } from './types.ts';
import type { validateMigration } from './validation.ts';
import type { LocalProof } from './stripe-type-evidence.ts';
import {
  INTEGRATION_MARKER,
  MIGRATION_MARKER,
  migrationIdentity,
  REFIT_VERSION,
} from './migration-identity.ts';
import type { ReviewReason } from './publication.ts';
import { OTHER_DEPENDENCY_FAILURE } from './dependency-preparation.ts';
import { REMOVED_PARAMETER_NOTES } from './request-removals.ts';
import { OPEN_ENUM_REPAIR, UNTYPED_REQUEST_PROPERTIES } from './stripe-open-enums.ts';
import {
  applySourceEdits,
  movedPaymentMethodExpressions,
  PAYMENT_METHOD_TYPES_CHANGELOG,
} from './patches.ts';
import { typeErrorKeys } from './type-errors.ts';
import { HELPER_NAMES, HELPER_RULES } from './stripe-subscription-periods.ts';

// The entry for one gate, when the draft has it.
function gated<Gate extends ReviewReason['gate']>(
  reviews: readonly ReviewReason[] | undefined,
  gate: Gate,
) {
  return reviews?.find(
    (entry): entry is Extract<ReviewReason, { gate: Gate }> => entry.gate === gate,
  );
}

type ValidationReport = Awaited<ReturnType<typeof validateMigration>>;
const MAX_SUMMARY_ITEMS = 5;
// Conventional Commits title limit from the PR template.
const MAX_TITLE = 70;
// Longer diffs stay readable in the Files changed tab and migration.patch.
const MAX_VISIBLE_DIFF_LINES = 80;
const MAX_QUOTE = 300;
const MAX_REMOVED_QUOTE = 80;
// The body stays well under GitHub's 65,536-character limit and readable in one sitting; above
// this, diffs and site lists shorten in steps and the body says what it left out.
export const MAX_BODY_CHARACTERS = 16_000;
export const NEEDS_REVIEW_PREFIX = '[Needs review] ';
const MAX_LISTED_SITES = 25;
// The check the Stripe benchmark runs where a repository has no tests and no TypeScript.
export const NO_OP_CHECK = 'node -e 0';
// Why a draft checked only by NO_OP_CHECK needs review, in every draft Refit opens.
export const NO_OP_REVIEW = {
  reason: `The configured check \`${NO_OP_CHECK}\` runs no code, so nothing in this patch was tested.`,
  check:
    'Run your tests or type check on this branch, or set a real check command in `.refit.json`.',
};
// compareTypeCheck() in validation.ts lists these above the type checker's own output.
const INTRODUCED_TYPE_ERRORS = 'Type errors this patch introduced:\n';
// Refit's own reasons for stopping a check (containerCheck() in validation.ts). Any other error is the
// Docker client's message, with the command line and the check's raw output, so it stays private.
const REFIT_CHECK_STOP = /^Check (?:output )?exceeded /;
// Checked on GitHub, 2026-10-24.
const STRIPE_NODE_CHANGELOG = 'https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md';
// Read 2026-10-25: "Only payment methods that you enabled can be shown to your customers." The
// Checkout API reference says allowed_payment_method_types filters this dynamically eligible set.
const DYNAMIC_PAYMENT_METHODS =
  'https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods';

// A command that only type-checks, as `npx --no-install tsc --noEmit` does.
function typeCheckOnly(command: string) {
  return /^(?:npx (?:--no-install )?)?tsc\b|^(?:npm|pnpm|yarn|bun) run type-?check$/.test(command);
}
// Gates whose check the checklist already words on its own.
const CHECKLISTED_GATES = new Set<ReviewReason['gate']>([
  'dependency-preparation',
  'removed-request-parameter',
  'webhook-api-version',
  'baseline-failed',
  'no-checks',
]);
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

export function plainText(value: string) {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
}

export function code(value: string) {
  const content = value.replace(/[\x00-\x1f\x7f]/g, ' ');
  const fence = '`'.repeat(
    Math.max(1, ...(content.match(/`+/g) ?? []).map((run) => run.length + 1)),
  );
  // CommonMark strips one space from each side, so a backtick at an edge stays content.
  const pad = /^`|`$/.test(content) ? ' ' : '';
  return `${fence}${pad}${content}${pad}${fence}`;
}

export function summaryList(values: string[]) {
  const visible = values.slice(0, MAX_SUMMARY_ITEMS);
  const remaining = values.length - visible.length;
  return `${visible.join(', ')}${remaining ? `, and ${remaining} more` : ''}`;
}

function fenced(language: string, content: string) {
  const runs = content.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((width, run) => Math.max(width, run.length + 1), 3));
  return `${fence}${language}\n${content}\n${fence}`;
}

// A quotation that ends the sentence; a quoted sentence's own period or a cut quote's ellipsis ends it.
function closingQuote(value: string) {
  const whole = value.replace(/\s+/g, ' ').trim();
  const text = whole.length > MAX_QUOTE ? `${whole.slice(0, MAX_QUOTE)}…` : whole;
  return `“${plainText(text)}”${/[.!?…]$/.test(text) ? '' : '.'}`;
}

interface FileChange {
  path: string;
  before: string;
  after: string;
}

// Refit patches replace whole files, so each file's old and new text is its -/+ lines.
function fileChanges(diff: string): FileChange[] {
  return diff
    .split(/^diff --git /m)
    .filter(Boolean)
    .flatMap((block) => {
      const lines = block.split('\n');
      const header = lines.find((line) => line.startsWith('+++ '));
      if (!header) return [];
      let path: string;
      try {
        path = String(JSON.parse(header.slice(4))).replace(/^b\//, '');
      } catch {
        path = header.slice(4).replace(/^b\//, '');
      }
      const before: string[] = [];
      const after: string[] = [];
      let last: string[] | undefined;
      let beforeEnds = true;
      let afterEnds = true;
      for (const line of lines.slice(lines.indexOf(header) + 1)) {
        if (line.startsWith('-')) (last = before).push(line.slice(1));
        else if (line.startsWith('+')) (last = after).push(line.slice(1));
        else if (line.startsWith('\\ ')) {
          if (last === before) beforeEnds = false;
          if (last === after) afterEnds = false;
        }
      }
      const text = (values: string[], ends: boolean) =>
        values.length ? `${values.join('\n')}${ends ? '\n' : ''}` : '';
      return [{ path, before: text(before, beforeEnds), after: text(after, afterEnds) }];
    });
}

const SCRIPT = /\.[cm]?[jt]sx?$/;

// One entry per path: a repair can append a second block for a file the rule already changed.
function changedFiles(diff: string) {
  const files = new Map<string, FileChange>();
  for (const file of fileChanges(diff))
    files.set(file.path, { ...file, before: files.get(file.path)?.before ?? file.before });
  return [...files.values()];
}

// A line an AI patch deleted, quoted short enough to read in a list.
function removedLines(lines: string[]) {
  const [first] = lines.map((line) => line.trim()).filter(Boolean);
  const quoted =
    first && first.length > MAX_REMOVED_QUOTE ? `${first.slice(0, MAX_REMOVED_QUOTE)}…` : first;
  const more = lines.length - 1;
  return `${quoted ? code(quoted) : 'a blank line'}${more ? ` and ${more} more line${more === 1 ? '' : 's'}` : ''}`;
}

// Lines of an AI patch that Refit's rules did not write (owner decision 8): each file's final text
// against the original with only the rule edits applied. A package upgrade's files are the rules'.
// A deletion has no line in the patched file: jsdiff puts its newStart on the patched line after it.
function aiWrittenLines(patch: ValidationReport['patch'], upgraded: boolean) {
  const ruleEdits = ('ruleEdits' in patch && patch.ruleEdits) || [];
  return changedFiles(patch.diff)
    .filter(
      (file) =>
        !(upgraded && (/(?:^|\/)package\.json$/.test(file.path) || LOCKFILE.test(file.path))),
    )
    .flatMap((file) =>
      structuredPatch(
        file.path,
        file.path,
        applySourceEdits(
          file.before,
          ruleEdits.filter((edit) => edit.file === file.path),
        ),
        file.after,
        '',
        '',
        { context: 0 },
      ).hunks.map((hunk) =>
        hunk.newLines > 0
          ? code(
              `${file.path}:${hunk.newStart}${hunk.newLines > 1 ? `-${hunk.newStart + hunk.newLines - 1}` : ''}`,
            )
          : `${code(`${file.path}:${Math.max(hunk.newStart - 1, 1)}`)} removed ${removedLines(
              hunk.lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1)),
            )} ${hunk.newStart > 1 ? 'after' : 'before'} this line`,
      ),
    );
}

// The innermost named function, method or function-valued variable that contains a line (1-based).
function enclosingFunction(source: ts.SourceFile, line: number) {
  const text = source.text.split('\n')[line - 1] ?? '';
  const position =
    source.getPositionOfLineAndCharacter(line - 1, 0) + text.length - text.trimStart().length;
  let name: string | undefined;
  const visit = (node: ts.Node) => {
    if (position < node.getStart(source) || position >= node.getEnd()) return;
    if (ts.isFunctionLike(node)) {
      // Object properties such as Convex's `handler` name a role, not the function.
      const named =
        node.name ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined);
      if (named && ts.isIdentifier(named)) name = named.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return name;
}

// Lockfiles are named, not shown: their entries follow the package change shown above them.
function changeSections(diff: string, limit = MAX_VISIBLE_DIFF_LINES) {
  const sections: string[] = [];
  const lockfiles: string[] = [];
  let shown = 0;
  let hidden = 0;
  for (const file of fileChanges(diff)) {
    if (!file.before) {
      sections.push(`New file ${code(file.path)}; see Files changed.`);
      continue;
    }
    if (LOCKFILE.test(file.path)) {
      lockfiles.push(file.path);
      continue;
    }
    const source = SCRIPT.test(file.path)
      ? ts.createSourceFile(file.path, file.after, ts.ScriptTarget.Latest, true)
      : undefined;
    for (const hunk of structuredPatch(file.path, file.path, file.before, file.after, '', '', {
      context: 2,
    }).hunks) {
      if (shown + hunk.lines.length > limit) {
        hidden++;
        continue;
      }
      shown += hunk.lines.length;
      let line = hunk.newStart;
      let firstChange = hunk.newStart;
      for (const entry of hunk.lines) {
        if (entry.startsWith('+') || entry.startsWith('-')) {
          firstChange = line;
          break;
        }
        line++;
      }
      const name = source && enclosingFunction(source, firstChange);
      sections.push(
        `${code(`${file.path}:${firstChange}`)}${name ? ` in ${code(`${name}()`)}` : ''}`,
        fenced(
          'diff',
          hunk.lines
            .filter((entry) => !entry.startsWith('\\'))
            .join('\n')
            .replace(/(\n\s*)+$/, ''),
        ),
      );
    }
  }
  if (lockfiles.length)
    sections.push(
      `Changes to ${summaryList(lockfiles.map(code))} are not shown here; see Files changed.`,
    );
  if (hidden)
    sections.push(
      `${hidden} more ${hidden === 1 ? 'change is' : 'changes are'} not shown here; see Files changed or migration.patch.`,
    );
  return sections;
}

// A Markdown link to an https page, or nothing for anything else.
// Words to lines of at most 72 columns; a longer word, such as a URL, keeps its own line.
export function wrap(text: string, indent = '') {
  const lines = [''];
  for (const word of text.split(' ')) {
    const line = lines[lines.length - 1];
    if (line.trim() && `${line} ${word}`.length > 72) lines.push(`${indent}${word}`);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines.join('\n');
}

function link(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    const text = `${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
    return `[${plainText(text)}](${parsed.href.replace(/[()\s]/g, encodeURIComponent)})`;
  } catch {
    return undefined;
  }
}

// One site per line, up to `limit`, then a count with where the rest are recorded.
function siteList(sites: string[], limit: number) {
  const visible = sites.slice(0, limit).map((site) => `- ${site}`);
  const remaining = sites.length - visible.length;
  return [
    ...visible,
    ...(remaining ? [`- and ${remaining} more; every location is in report.json.`] : []),
  ].join('\n');
}

type Validation = ValidationReport['validation'];

// Each check that did not pass: what ran, on which code, and how it ended.
// How localReceiverReads proved a read does not read a provider object, worded for the draft.
const LOCAL_PROOFS: Record<LocalProof, string> = {
  'repository-type': 'a type the repository declares',
  'literal-config': 'an object literal the repository writes',
  'generated-type': "a type generated from the repository's own schema",
  'receiver-type': 'a type that is not the changed object',
  'prisma-client': "a Prisma model the repository's schema declares",
};

function failedChecks(validation: Validation) {
  const generated = validation.generated;
  const checks: [string, Validation['baseline'], string][] = [
    [code(validation.baselineCommand.join(' ')), validation.baseline, 'original'],
    [code(validation.command.join(' ')), validation.patched, 'migrated'],
    ...(generated
      ? ([
          ['Generated stripe-mock checks', generated.baseline, 'original'],
          ['Generated stripe-mock checks', generated.patched, 'migrated'],
        ] as [string, Validation['baseline'], string][])
      : []),
  ];
  const introduced =
    validation.compareTypeErrors && validation.patched.stdout.startsWith(INTRODUCED_TYPE_ERRORS)
      ? [
          ...new Set(
            validation.patched.stdout
              .slice(INTRODUCED_TYPE_ERRORS.length)
              .split('\n\n')[0]
              .split('\n')
              .filter(Boolean),
          ),
        ]
      : [];
  const failures = checks
    .filter(([, check]) => check.status === 'failed' || check.status === 'error')
    .map(
      ([name, check, side]) =>
        `${name} ${
          check.status === 'error'
            ? `could not finish on the ${side} code (${check.error && REFIT_CHECK_STOP.test(check.error) ? plainText(check.error.replace(/\.$/, '')) : check.exitCode === null ? 'no result recorded' : `exit code ${check.exitCode}`})`
            : `failed on the ${side} code${check.exitCode === null ? '' : ` with exit code ${check.exitCode}`}`
        }`,
    );
  return `**Validation did not pass (${validation.status}).**${failures.length ? ` ${failures.join('; ')}.` : ''}${
    introduced.length
      ? ` The patch introduced ${introduced.length} type error${introduced.length === 1 ? '' : 's'}, the first: ${closingQuote(introduced[0])}`
      : ''
  }${
    validation.patched.status === 'not-run'
      ? ' Refit did not run the checks on the migrated code.'
      : ''
  }`;
}

// A compared typecheck passes on tsc's nonzero exit when no error has a file, code and message the
// original code's errors lack, so it says what the gate compared instead of that it passed.
export function existingTypeErrors(validation: {
  compareTypeErrors?: boolean;
  baseline: { exitCode: number | null; stdout: string; stderr: string };
  patched: { exitCode: number | null; stdout: string; stderr: string };
}) {
  if (
    !validation.compareTypeErrors ||
    [validation.baseline, validation.patched].every((check) => check.exitCode === 0)
  )
    return undefined;
  const before = typeErrorKeys(validation.baseline).size;
  return `reported ${before} existing type error${before === 1 ? '' : 's'} on the original code, counted by file, code and message, and ${typeErrorKeys(validation.patched).size ? 'no error with a new file, code and message' : 'no type errors'} on the migrated code`;
}

function passedChecks(validation: Validation) {
  const [original, migrated] = [validation.baselineCommand, validation.command].map((command) =>
    code(command.join(' ')),
  );
  const sameCommand = original === migrated;
  const existing = existingTypeErrors(validation);
  if (existing)
    return `${sameCommand ? migrated : `${original} on the original and ${migrated} on the migrated code`} ${existing}, in offline Docker.`;
  return sameCommand
    ? `${migrated} passed on the original and migrated code in offline Docker.`
    : `${original} passed on the original and ${migrated} on the migrated code in offline Docker.`;
}

// How much a validation shows, from what ran; Refit does not measure which lines a repository's own
// command reaches.
function evidenceStrength(validation: Validation, generated: boolean) {
  if (validation.status !== 'passed')
    return '**None.** The checks did not pass, so nothing in this patch is verified.';
  const command = validation.command.join(' ');
  if (command === NO_OP_CHECK)
    return generated
      ? `**Generated checks only.** ${code(command)} runs no code; only the generated stripe-mock checks below ran any.`
      : `**No meaningful check.** ${code(command)} runs no code and no generated check ran, so this shows only that the dependencies install and the patch applies.`;
  if (typeCheckOnly(command))
    return `**Type-checked only.** No code ran${generated ? ' except the generated stripe-mock checks below' : ''}.`;
  return `**${/^(?:npm|pnpm|yarn|bun)(?: run)? test\b/.test(command) ? "The repository's test command" : 'A configured command'}.** Refit does not measure whether it reaches the changed lines.`;
}

function addedProperties(patch: ValidationReport['patch']): AddedProperty[] {
  if (!('evidence' in patch) || !patch.evidence || typeof patch.evidence !== 'object') return [];
  const value = (patch.evidence as { addedProperties?: unknown }).addedProperties;
  return Array.isArray(value) ? (value as AddedProperty[]) : [];
}

function vendorNotes(patch: ValidationReport['patch']) {
  if (!('evidence' in patch) || !patch.evidence || typeof patch.evidence !== 'object') return [];
  const value = (patch.evidence as { documentation?: unknown }).documentation;
  return Array.isArray(value)
    ? (value as Array<{ label: string; url: string; content: string }>).filter(
        (note) => typeof note?.content === 'string',
      )
    : [];
}

function addedReads(diff: string, property: string) {
  const pattern = new RegExp(`\\.${property.replace(/[$]/g, '\\$&')}\\b`);
  return fileChanges(diff).some((file) => pattern.test(file.after) && !pattern.test(file.before));
}

// States only what Refit can verify about why a replacement field was chosen.
function replacementReasons(report: ValidationReport) {
  const { patch } = report;
  const added = addedProperties(patch);
  const notes = vendorNotes(patch);
  const renames = report.adapter.propertyRenames ?? [];
  const reasons: string[] = [];
  const replacements: string[] = [];
  for (const change of affectedFields(report.changes, report.findings)) {
    const removed = `${change.schema}.${change.property}`;
    const rename = renames.find(
      (entry) => entry.schema === change.schema && entry.removed === change.property,
    );
    const candidate =
      added.find(
        (entry) => entry.schema === change.schema && entry.property === rename?.replacement,
      ) ??
      added.find(
        (entry) => entry.schema === change.schema && addedReads(patch.diff, entry.property),
      );
    const replacement = rename?.replacement ?? candidate?.property;
    if (!replacement) continue;
    const used = `${change.schema}.${replacement}`;
    replacements.push(`${code(removed)} → ${code(used)}`);
    if (rename) {
      reasons.push(
        `An operator-configured ${replacement.includes('.') ? 'move' : 'rename'} rule maps ${code(removed)} to ${code(used)}.`,
      );
      continue;
    }
    const described =
      candidate?.description && candidate.description.includes(change.property)
        ? candidate.description
        : undefined;
    const note = notes.find(
      (entry) => entry.content.includes(change.property) && entry.content.includes(replacement),
    );
    if (described)
      reasons.push(
        `The after contract documents ${code(replacement)} as the replacement: ${closingQuote(described)}`,
      );
    else if (note) {
      const sentence =
        note.content
          .split(/(?<=[.!?])\s+|\n+/)
          .find((part) => part.includes(change.property) && part.includes(replacement)) ??
        note.content;
      reasons.push(
        `The attached vendor note (${plainText(note.label)}, ${plainText(note.url)}) says ${closingQuote(sentence)}`,
      );
    } else {
      const sameType = candidate?.type && change.type && candidate.type === change.type;
      reasons.push(
        `${code(replacement)} was added to the same response${sameType ? ` with the same type (${plainText(change.type!)})` : ''}. Nothing documents it as the replacement for ${code(change.property)}, so **confirm it carries the same meaning**.`,
      );
    }
  }
  return { reasons, replacements };
}

function testModeLines(validation: unknown) {
  const sandbox = (
    validation as {
      behaviour?: {
        sandbox?: {
          provider: string;
          standIns: { id: string; standIn: string; assumption: string }[];
          unreproducible: string[];
          newErrors: string[];
        };
      };
    }
  ).behaviour?.sandbox;
  if (!sandbox) return [];
  return [
    `- ${plainText(sandbox.provider)} Test Mode: the behaviour tests ran against Refit's own ${plainText(sandbox.provider)} test account, the original code at the before API version and the patch at the after version.`,
    ...sandbox.standIns.map(
      (item) =>
        `- Stand-in: ${code(item.id)} is your account's object, so the tests used ${plainText(item.assumption)} in its place. **Check that your ${code(item.id)} behaves the same way.**`,
    ),
    ...sandbox.unreproducible.map(
      (item) =>
        `- Not reproduced: ${plainText(item)} lives in your account, so test mode could not check it and it stays outside grade A. **Check it when you approve.**`,
    ),
    ...sandbox.newErrors.map(
      (error) => `- New ${plainText(sandbox.provider)} error on the patched side: ${code(error)}.`,
    ),
  ];
}

const EVIDENCE_LABELS = {
  'behaviour-tests': "Behaviour tests in the provider's test mode cover every changed line",
  'live-requests': "Read-only calls in the provider's test app accept every changed request",
  'request-strings': 'Only request strings changed, each proven by the change table',
  'stripe-tests': 'Tests exercise the changed code',
  'type-check': 'Type-checked only',
  'generated-check': 'Generated stripe-mock checks only',
  none: 'No meaningful check',
} as const;

export function createReviewArtifacts(
  report: ValidationReport,
  destination: 'local' | 'github' = 'local',
  integration?: string,
  reviews?: readonly ReviewReason[],
) {
  const { validation, patch } = report;
  const dependency = gated(reviews, 'dependency-preparation');
  // The checks passed on the original code; only the lockfile this patch upgrades failed to install.
  const upgradeUninstalled = Boolean(dependency) && validation.baseline.status === 'passed';
  const parameterGate = gated(reviews, 'removed-request-parameter');
  const webhookGate = gated(reviews, 'webhook-api-version');
  if (validation.patchHash !== digest(patch.diff) || patch.validation !== validation.status)
    throw new PipelineInputError(
      'Review artifacts require consistent patch and validation evidence.',
    );
  if (
    validation.status === 'passed' &&
    // A compared typecheck passes with tsc's nonzero exit when the only errors predate the patch.
    [validation.baseline, validation.patched].some(
      (check) =>
        check.status !== 'passed' || (check.exitCode !== 0 && !validation.compareTypeErrors),
    )
  )
    throw new PipelineInputError('Passing validation must include two successful check results.');

  const provider =
    report.adapter.packageName === 'stripe'
      ? 'Stripe'
      : report.provider === 'openai'
        ? 'OpenAI'
        : report.provider === 'shopify'
          ? 'Shopify'
          : report.provider;
  // Shopify runs move the pinned Admin API version after checking every traced GraphQL document.
  const shopify =
    report.provider === 'shopify'
      ? (report as unknown as { shopify: { tracedDocuments: number; deprecated: string[] } })
          .shopify
      : undefined;
  // Only removed response fields a finding reads; request renames, endpoint replacements and the
  // card rule cite their own change IDs, so they never count as reads.
  const readChanges = report.changes.filter((entry) =>
    report.findings.some((finding) => finding.changeId === entry.id),
  );
  const change = readChanges[0];
  const operationChanges = report.operationChanges ?? [];
  const endpoint = operationChanges[0];
  const requestChanges = report.requestChanges ?? [];
  // A removed payment_method_types finding with no remaining stop was migrated by the card-only rule.
  const cardFiles = new Set(
    report.findings
      .filter(
        (finding) =>
          finding.changeId.endsWith('.payment_method_types') &&
          finding.changeId.startsWith('request-parameter:') &&
          !finding.requestParameter,
      )
      .map((finding) => finding.file),
  );
  const cardRename = cardFiles.size > 0;
  // Lists other than `['card']` the patch keeps, as it writes them, and other value expressions
  // it moves unchanged, as its warnings name them.
  const listedMethods = [
    ...new Set(
      [...patch.diff.matchAll(/^\+.*allowed_payment_method_types['"]?\s*:\s*\[([^\]]*)\]/gm)]
        .map((match) => [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]))
        .filter((methods) => methods.length && methods.join() !== 'card')
        .map((methods) => methods.join(', ')),
    ),
  ];
  const movedExpressions = movedPaymentMethodExpressions(patch.warnings ?? []);
  const cardOnly = /^\+.*allowed_payment_method_types['"]?\s*:\s*\[\s*['"]card['"]\s*\]/m.test(
    patch.diff,
  );
  // Currency literals the currency rule lowercased (operation-reach.ts); no finding records them.
  const currencyEdits = ('ruleEdits' in patch && patch.ruleEdits ? patch.ruleEdits : []).filter(
    (edit) => edit.rule === CURRENCY_CODE_RULE,
  );
  const request = requestChanges[0];
  const subscriptionPolicy = report.findings.some((finding) => finding.webhook?.migration)
    ? report.adapter.stripeSubscriptionPeriods
    : undefined;
  // docs/VERSION-BUMP-PRS.md: every Stripe call traced and none uses what the target changes.
  const versionBump = 'versionBump' in patch && patch.versionBump === true;
  const description = versionBump
    ? `upgrade Stripe API to ${report.apiVersion.after}`
    : subscriptionPolicy
      ? 'preserve subscription periods after item-level billing'
      : request && requestChanges.length === 1 && !operationChanges.length && !readChanges.length
        ? `update ${request.resource}.${request.method} after ${request.removed} removal`
        : endpoint && operationChanges.length === 1 && !readChanges.length
          ? `replace retired ${endpoint.resource}.${endpoint.method} calls`
          : cardRename && !readChanges.length
            ? 'move payment_method_types to allowed_payment_method_types'
            : currencyEdits.length && !readChanges.length
              ? 'lowercase currency codes'
              : change && readChanges.length === 1
                ? provider === 'Stripe' &&
                  change.schema === 'payment_intent' &&
                  change.property === 'charges'
                  ? 'restore payment history after charges removal'
                  : `migrate removed ${change.schema}.${change.property} reads`
                : `migrate removed ${provider} API fields`;
  const versionTitle = shopify ? `upgrade Admin API to ${report.apiVersion.after}` : undefined;
  const scope = (
    integration ?? (shopify ? 'shopify' : report.adapter.packageName.split('/').pop()!)
  ).toLowerCase();
  // O2's evidence grade: what the passing checks proved about the changed files.
  const grade = 'grade' in validation ? validation.grade : undefined;
  // A passing patch graded D, which no check fully reached, publishes only as [Needs review]
  // (AGENTS.md, 2026-10-24).
  const unchecked =
    validation.status === 'passed' && (grade?.letter === 'D' || grade?.level === 'none');
  const keptProperties = validation.repair?.keptProperties ?? [];
  // Type errors a Refit-generated check found in JavaScript the repository never type-checks: they do
  // not fail validation, so the draft states each one for review (L2 master's policy, board #300).
  const advisoryTypeErrors =
    'advisoryTypeErrors' in validation && Array.isArray(validation.advisoryTypeErrors)
      ? (validation.advisoryTypeErrors as {
          file: string;
          line: number;
          code: string;
          message: string;
        }[])
      : [];
  // Webhook events both the original and the patched code handle differently in the new API
  // version (signed-events.ts): the patch did not cause it, and did not fix it.
  const unresolvedEvents =
    'signedEvents' in validation &&
    validation.signedEvents &&
    'unresolved' in validation.signedEvents
      ? (validation.signedEvents.unresolved as { id: string; error: string }[])
      : [];
  const needsReview = Boolean(
    reviews?.length ||
    patch.unresolvedFindings ||
    keptProperties.length ||
    unchecked ||
    advisoryTypeErrors.length ||
    unresolvedEvents.length,
  );
  const prefix = needsReview ? NEEDS_REVIEW_PREFIX : '';
  const full = `${prefix}fix(${scope}): ${versionTitle ?? description}`;
  const title =
    full.length <= MAX_TITLE
      ? full
      : `${prefix}fix(${scope}): migrate removed API fields`.slice(0, MAX_TITLE);
  const confirmedFindings = report.findings.filter((finding) => finding.confidence === 'confirmed');
  const affectedFiles = new Set([
    ...confirmedFindings.map((finding) => finding.file),
    ...currencyEdits.map((edit) => edit.file),
  ]);
  const usages = confirmedFindings.length + currencyEdits.length;
  const changes = summaryList(
    readChanges.map((entry) => code(`${entry.schema}.${entry.property}`)),
  );
  const { reasons, replacements } = replacementReasons(report);
  const fileCount = `${affectedFiles.size} ${affectedFiles.size === 1 ? 'file' : 'files'}`;
  const after = plainText(report.apiVersion.after ?? 'the after contract');
  // Calls that still send a removed request parameter and untraced reads (no rule edits them) are
  // counted as unresolved; each gets its own line, so the confirmed count below leaves them out.
  const parameterCalls = parameterGate?.calls ?? [];
  const untracedReads = report.findings.filter((finding) => finding.untraced).length;
  // Where the rescan of the migrated code still finds each usage; reports before 2026-10-24 only
  // stored the count.
  const sites = 'unresolvedSites' in patch ? patch.unresolvedSites : undefined;
  const unmigrated = sites?.filter(
    (site) =>
      !site.untraced && !(parameterCalls.length && site.changeId.startsWith('request-parameter:')),
  );
  // One expression can resolve to more than one removed field, as `.price` does on an invoice item
  // and a line item; it is one usage to migrate.
  const unmigratedUsages = new Map<string, NonNullable<typeof unmigrated>>();
  for (const site of unmigrated ?? []) {
    const key = `${site.file}:${site.line} ${site.expression}`;
    unmigratedUsages.set(key, [...(unmigratedUsages.get(key) ?? []), site]);
  }
  const unresolvedReads = Math.max(
    0,
    sites && unmigrated
      ? unmigratedUsages.size + patch.unresolvedFindings - sites.length
      : patch.unresolvedFindings - parameterCalls.length - untracedReads,
  );
  const remainingConfirmed = unmigrated?.filter((site) => site.confidence === 'confirmed').length;
  const usageCount = `${remainingConfirmed ? `${Math.max(0, usages - remainingConfirmed)} of ` : ''}${usages} confirmed ${usages === 1 ? 'usage' : 'usages'}`;
  const parameters = [...new Set(parameterCalls.map((call) => call.parameter))];
  const passed = validation.status === 'passed';
  const legacyPeerDeps = [validation.environment, validation.patchedEnvironment].some(
    (environment) =>
      (environment?.installation as { legacyPeerDeps?: unknown } | undefined)?.legacyPeerDeps ===
      true,
  );
  const fromBunLock = [validation.environment, validation.patchedEnvironment].some(
    (environment) => typeof environment?.bunLockHash === 'string',
  );
  const lockfileChoice = validation.environment?.lockfileChoice as LockfileChoice | undefined;
  const otherLockfiles = Object.entries(lockfileChoice?.others ?? {});
  // Lockfiles a patch that upgrades stripe leaves as committed (stripe-package-upgrade.ts).
  const unchangedLockfiles = /^diff --git "a\/package\.json"/m.test(patch.diff)
    ? otherLockfiles
        .map(([file]) => file)
        .filter((file) => !patch.diff.includes(`diff --git "a/${file}"`))
    : [];
  type ResolvedLockfile = {
    reason: string;
    before: string;
    late?: Record<string, { spec: string; published: string }>;
  };
  const resolvedLockfiles = [validation.environment, validation.patchedEnvironment]
    .map((environment) => environment?.resolvedLockfile as ResolvedLockfile | undefined)
    .filter((entry) => entry !== undefined);
  const prunedGlibcPackages = Math.max(
    0,
    ...[validation.environment, validation.patchedEnvironment].map((environment) => {
      const count = (environment?.installation as { prunedGlibcPackages?: unknown } | undefined)
        ?.prunedGlibcPackages;
      return typeof count === 'number' ? count : 0;
    }),
  );
  const commandText = (value: readonly string[]) => code(value.join(' '));
  const ai = patch.generator === 'openai';
  const model = 'model' in patch && typeof patch.model === 'string' ? patch.model : undefined;
  const periodReads = (rareCase: NonNullable<Finding['subscriptionPeriod']>['rareCase']) =>
    report.findings.filter((finding) => finding.subscriptionPeriod?.rareCase === rareCase);
  const flaggedPeriods = periodReads('flagged');
  const unconfirmed = report.findings.filter((finding) => finding.untraced);
  const typeCheckedReads = report.findings.filter((finding) => finding.typeChecked);
  const selectedPeriods = [...periodReads('item-in-code'), ...periodReads('price-policy')];
  const generated = validation.generated;
  const command = validation.command.join(' ');
  const typeChecked = /\btsc\b|\btype-?check\b/.test(command);
  // What the passing checks ran: none of the repository's code for a type check or the no-op.
  const ranCode = passed && !typeCheckOnly(command) && command !== NO_OP_CHECK;
  // A field counts as migrated in a file once fewer of its confirmed reads remain there than the
  // scan found; the rescan's lines are the migrated file's, so only the counts compare.
  const remainingIn = (path: string, changeId: string) =>
    unmigrated?.filter(
      (site) => site.file === path && site.changeId === changeId && site.confidence === 'confirmed',
    ).length ?? 0;
  const migratedFields = (path: string) => [
    ...new Set(
      confirmedFindings
        .filter((finding) => finding.file === path && !finding.untraced)
        .filter(
          (finding, _, found) =>
            found.filter((other) => other.changeId === finding.changeId).length >
            remainingIn(path, finding.changeId),
        )
        .flatMap((finding) => {
          const entry = readChanges.find((candidate) => candidate.id === finding.changeId);
          return entry ? [code(`${entry.schema}.${entry.property}`)] : [];
        }),
    ),
  ];
  const upgrade =
    'sdkUpgrade' in patch &&
    patch.sdkUpgrade &&
    typeof patch.sdkUpgrade === 'object' &&
    'to' in patch.sdkUpgrade &&
    'from' in patch.sdkUpgrade
      ? (patch.sdkUpgrade as {
          from: string;
          to: string;
          raised?: { name: string; from: string; to: string; range: string }[];
        })
      : undefined;
  const raisedPeers = summaryList(
    (upgrade?.raised ?? []).map(
      ({ name, from, to }) => `${code(name)} from ${code(from)} to ${code(to)}`,
    ),
  );
  const pinFrom = report.apiVersion.application;
  const pinTo = report.apiVersion.after;
  const movesPin = (file: FileChange) =>
    Boolean(
      pinFrom &&
      pinTo &&
      pinFrom !== pinTo &&
      file.before.includes(pinFrom) &&
      file.after.includes(pinTo) &&
      !file.before.includes(pinTo),
    );
  const pinFiles = changedFiles(patch.diff).filter(movesPin);
  // Each rule edit's provider page, with the files it changes; older reports name one page.
  const rulePages = ('sources' in patch && patch.sources) || [];
  const pagesFor = (path: string) =>
    rulePages.filter((page) => page.files.includes(path)).flatMap((page) => link(page.url) ?? []);
  const helperFiles = changedFiles(patch.diff).filter((file) => !file.before);
  // Helpers Refit wrote into the one file that calls them, in place of a generated module.
  const declares = (text: string, name: string) =>
    new RegExp(`^function ${name}\\b`, 'm').test(text);
  const inlineHelpers = (file: FileChange) =>
    file.before
      ? HELPER_NAMES.filter((name) => declares(file.after, name) && !declares(file.before, name))
      : [];
  const inlined = changedFiles(patch.diff).filter((file) => inlineHelpers(file).length);
  const keyChanges = changedFiles(patch.diff).map((file) => {
    const fields = migratedFields(file.path);
    const pages = pagesFor(file.path);
    const cited = pages.length ? ` ${plainText(provider)} documents it: ${pages.join(', ')}.` : '';
    const helpers = inlineHelpers(file);
    const usage = [
      ...(fields.length
        ? [`Migrates reads of ${summaryList(fields)} to the documented new locations.`]
        : []),
      ...(helpers.length
        ? [
            `Adds the generated helper${helpers.length === 1 ? '' : 's'} ${summaryList(helpers.map(code))} to this file, which read${helpers.length === 1 ? 's' : ''} the removed fields under either API version.`,
          ]
        : []),
      ...(cardFiles.has(file.path)
        ? [
            `Sends ${code('allowed_payment_method_types')} in place of the removed ${code('payment_method_types')}.`,
          ]
        : []),
      ...(currencyEdits.some((edit) => edit.file === file.path)
        ? [
            `Sends the currency ${summaryList([...new Set(currencyEdits.filter((edit) => edit.file === file.path).map((edit) => code(edit.replacement.slice(1, -1))))])} in lowercase, as the new ${code('currency')} format requires.`,
          ]
        : []),
    ];
    // A rule edit no sentence above names, such as a moved request, still gets one, so the
    // provider page cites that edit and not the pin move after it.
    if (pages.length && !usage.length)
      usage.push(`Updates ${plainText(provider)} requests for the new contract.`);
    const what = shopify
      ? `Moves the pinned Admin API version to ${plainText(after)}.${cited}`
      : !file.before
        ? `Adds the generated helper that reads the removed fields under either API version.${cited}`
        : [
            ...(usage.length ? [`${usage.join(' ')}${cited}`] : []),
            ...(movesPin(file)
              ? [`Moves the pinned API version from ${code(pinFrom!)} to ${code(pinTo!)}.`]
              : []),
            ...(upgrade && (/(?:^|\/)package\.json$/.test(file.path) || LOCKFILE.test(file.path))
              ? [
                  `Upgrades ${code(report.adapter.packageName)} from ${code(upgrade.from)} to ${code(upgrade.to)}${raisedPeers ? ` and raises ${raisedPeers}` : ''}.`,
                ]
              : []),
          ].join(' ') || `Updates ${plainText(provider)} API usage for the new contract.`;
    return `- ${code(file.path)}: ${what}`;
  });
  const breaking = shopify
    ? [
        `Moves the Admin API version from ${plainText(report.apiVersion.application ?? 'the pinned version')} to ${after}. ${
          shopify.tracedDocuments
            ? `${shopify.tracedDocuments} traced GraphQL ${shopify.tracedDocuments === 1 ? 'document validates' : 'documents validate'} against the ${after} schema, and no selected field is removed or changes type.`
            : "Refit found no Admin GraphQL documents in the app's own code; requests the Shopify SDK makes itself (authentication, billing) were not checked."
        }`,
      ]
    : [
        ...(versionBump
          ? [
              `None of ${plainText(provider)} API ${after}'s breaking changes reaches the traced calls (see Changed, Not Used By Traced Code).`,
            ]
          : []),
        ...(readChanges.length
          ? [`Removes response fields ${changes} in ${plainText(provider)} API ${after}.`]
          : []),
        ...replacements.map((entry) => `Replaces ${entry}.`),
        ...requestChanges.map(
          (entry) =>
            `Renames request field ${code(entry.removed)} to ${code(entry.replacement)} in ${code(`${entry.resource}.${entry.method}`)}.`,
        ),
        ...(cardRename && cardOnly
          ? [
              `Removes request field ${code('payment_method_types')}; ${code("['card']")} moves to ${code('allowed_payment_method_types')} under the owner-approved policy.`,
            ]
          : []),
        ...(currencyEdits.length
          ? [
              `Gives request ${code('currency')} fields the ${code('currency')} format, a lowercase three-letter ISO code; uppercase codes this code sends are lowercased.`,
            ]
          : []),
        ...listedMethods.map(
          (methods) =>
            `Moves ${code(`[${methods}]`)} from ${code('payment_method_types')} to ${code('allowed_payment_method_types')} with the same methods, under the owner decision of 2026-10-24 to keep listed payment methods.`,
        ),
        ...movedExpressions.map(
          (expression) =>
            `Moves ${code(expression)} from ${code('payment_method_types')} to ${code('allowed_payment_method_types')} unchanged, under the owner decision of 2026-10-24 for computed lists.`,
        ),
        ...operationChanges.map(
          (entry) =>
            // A configured replacement keeps the HTTP method; its contract signature must match.
            `Retires ${code(`${entry.resource}.${entry.method}`)} (${code(`${entry.httpMethod} ${entry.path}`)}) in favor of ${code(`${entry.replacementResource}.${entry.replacementMethod}`)} (${code(`${entry.httpMethod} ${entry.replacementPath}`)}).`,
        ),
        ...((validation.repair?.stopReason === OPEN_ENUM_REPAIR ||
          validation.repair?.openEnumRestored) &&
        !validation.repair.enumsUnchanged
          ? [
              `Restores the known values of the Stripe enums that stripe-node 22.4.0 widened with ${code('OtherString')}, using ${code('Extract<…>')} types where the upgraded types rejected this code. Runtime code is unchanged: a value Stripe adds later still reaches this code unchecked, as it did before the upgrade.`,
            ]
          : []),
        ...(validation.repair?.typeAssertions?.length
          ? [
              `Asserts the type this code expects at ${summaryList(validation.repair.typeAssertions.map((site) => code(`${site.file}:${site.line}`)))}, where the upgraded stripe-node types widened a value it assigns to a narrower type. Each file compiles to the same JavaScript as before (checked with TypeScript's ${code('transpileModule')}), so runtime behaviour is unchanged: a value outside the asserted type still reaches this code unchecked, as it did before the upgrade.`,
            ]
          : []),
        ...(typeCheckedReads.length
          ? [
              `Reads ${typeCheckedReads.length === 1 ? 'a subscription period' : `${typeCheckedReads.length} subscription periods`} at ${summaryList(typeCheckedReads.map((finding) => code(`${finding.file}:${finding.line}`)))} through the generated period helper: Refit's tracer did not reach ${typeCheckedReads.length === 1 ? 'this read' : 'these reads'}, but the upgraded stripe-node types reject ${typeCheckedReads.length === 1 ? 'it' : 'them'} on ${code('Subscription')}.`,
            ]
          : []),
      ];
  const overviewCauses = [
    ...(readChanges.length ? ['removes fields this code reads'] : []),
    ...(cardRename ||
    listedMethods.length ||
    movedExpressions.length ||
    requestChanges.some((entry) => entry.usages.length)
      ? ['removes request fields this code sends']
      : []),
    ...(operationChanges.some((entry) => entry.usages.length)
      ? ['retires endpoints this code calls']
      : []),
    ...(currencyEdits.length
      ? ['expects lowercase currency codes where this code sends uppercase ones']
      : []),
  ];
  const review = [
    ...(unchecked
      ? [
          `**No check reached all of the changed code.** ${plainText(grade!.reason)} Run the code this patch changes once before merging.`,
        ]
      : []),
    ...(advisoryTypeErrors.length
      ? [
          `**Advisory type errors.** Refit's generated type check reports ${advisoryTypeErrors.length === 1 ? 'a type error' : `${advisoryTypeErrors.length} type errors`} this patch introduces in JavaScript your build never type-checks; they did not fail validation. Check each one: ${advisoryTypeErrors
            .map(
              (error) =>
                `${code(`${error.file}:${error.line}`)} ${error.code} ${plainText(error.message)}`,
            )
            .join('; ')}.`,
        ]
      : []),
    ...(unresolvedEvents.length
      ? [
          `**Webhook events of the new API version.** Refit sent signed test events of both versions to your webhook handler, offline. The original and the patched code both handle ${unresolvedEvents.length === 1 ? 'this event' : 'these events'} differently when ${unresolvedEvents.length === 1 ? 'it arrives' : 'they arrive'} in the new version, so the handler is not ready for an endpoint on that version: ${unresolvedEvents
            .map((event) => `${code(event.id)} (${plainText(event.error)})`)
            .join('; ')}. The webhook endpoint's own version is unchanged.`,
        ]
      : []),
    ...(shopify?.deprecated ?? []).map(
      (entry) =>
        `Deprecated on ${after}, still served: ${code(entry.split(':')[0])}${plainText(entry.slice(entry.indexOf(':')))}`,
    ),
    ...reasons,
    ...UNTYPED_REQUEST_PROPERTIES.filter((entry) => keptProperties.includes(entry.property)).map(
      (entry) =>
        `**Keeps sending ${code(`${entry.parent}.${entry.property}`)} unchanged.** stripe-node 13 removed it from its types and [Stripe's API reference](${entry.reference}) no longer lists it, so Refit cannot confirm that Stripe still applies it at ${code(report.apiVersion.after ?? 'the target version')}. The patch only spreads it from its own object so the upgraded types accept it; the request is the same. Before merging, ${entry.check}`,
    ),
    ...('reviewTypeErrors' in validation && validation.reviewTypeErrors?.length
      ? [
          `**The upgraded SDK types reject these comparisons, often misspelled webhook event names that never matched.** Refit does not change event names; fix them by hand: ${summaryList([...new Set(validation.reviewTypeErrors.map((error) => code(`${error.file}:${error.line}`)))])}.`,
        ]
      : []),
    ...(cardOnly
      ? [
          `${code('allowed_payment_method_types')} filters the payment methods Stripe finds eligible instead of listing them. Before merging, confirm cards stay enabled in the Stripe Dashboard or the payment method configuration this account uses.`,
        ]
      : []),
    ...listedMethods.map((methods) => {
      const others = methods.split(', ').filter((method) => method !== 'card');
      const one = others.length === 1;
      return `Stripe now filters ${code(`[${methods}]`)} by each buyer's eligibility (country, currency, amount, device), so ${summaryList(others.map(code))} may no longer be offered to some customers. Stripe offers only payment methods the account has enabled ([dynamic payment methods](${DYNAMIC_PAYMENT_METHODS})). Before merging, confirm ${one ? 'it is' : 'they are'} enabled in the Stripe Dashboard or the payment method configuration this account uses, and ${one ? 'still appears' : 'still appear'} where you rely on ${one ? 'it' : 'them'}.`;
    }),
    ...(upgrade &&
    report.adapter.packageName === 'stripe' &&
    upgrade.from.split('.')[0] !== upgrade.to.split('.')[0]
      ? [
          `Upgrades ${code('stripe')} across major versions, ${code(upgrade.from)} to ${code(upgrade.to)}; [its changelog](${STRIPE_NODE_CHANGELOG}) lists type and behavior changes the checks may not cover.`,
        ]
      : []),
    ...(upgrade?.raised?.length
      ? [
          `Raises ${raisedPeers} with it: stripe ${code(upgrade.to)} declares ${summaryList(upgrade.raised.map(({ name, range }) => `${code(name)} ${code(range)}`))} as an optional peer, and Refit takes the lowest version in that range. Newer types can reject code that compiled before; check your own type check and editor.`,
        ]
      : []),
    ...movedExpressions.map(
      (expression) =>
        `Refit cannot read which payment methods ${code(expression)} holds at runtime. Stripe now filters them by each buyer's eligibility (country, currency, amount, device), and offers only payment methods the account has enabled ([dynamic payment methods](${DYNAMIC_PAYMENT_METHODS})). Before merging, confirm it holds only methods this call accepts in ${code('allowed_payment_method_types')}, that each one is enabled in the Stripe Dashboard or the payment method configuration this account uses, and that each one is still offered where you rely on it.`,
    ),
    ...(subscriptionPolicy
      ? [
          `Selects subscription periods from the single item priced ${code(subscriptionPolicy.priceId)}, keyed on the signed event ${code('api_version')}.`,
        ]
      : []),
    ...(selectedPeriods.length
      ? [
          `Uses the item the code already selects for items on different billing periods: ${summaryList([...new Set(selectedPeriods.map((finding) => code(finding.subscriptionPeriod!.selection ?? '')))])}.`,
        ]
      : []),
    ...(flaggedPeriods.length
      ? [
          `Subscriptions with items on different billing periods are not handled; set ${code('stripeSubscriptionPeriods')} to choose the item at ${summaryList(flaggedPeriods.map((finding) => code(`${finding.file}:${finding.line}`)))}.`,
        ]
      : []),
  ];
  // One expression can read more than one removed field; it is one site to check. The rescan's
  // lines are the migrated file's, which the draft shows; older reports have only the scan's.
  const untracedSites = [
    ...new Set(
      (sites?.filter((site) => site.untraced) ?? unconfirmed).map(
        (finding) => `${code(`${finding.file}:${finding.line}`)} reads ${code(finding.expression)}`,
      ),
    ),
  ];
  // Breaking contract changes the reach gate let through (operation-reach.ts), with their paths.
  const passingChanges = (report.specificationDiff?.changes ?? [])
    .filter(isObject)
    .filter((change) => PASSING_REACH.has(change.reach) && Number(change.level) >= 2);
  // Each kind of reach that lets a breaking change through, worded to follow a count.
  const reachCounts = (
    [
      ['unused', 'no traced code reaches'],
      ['handled', "Refit's kept rule edits handle"],
      ['compatible', 'traced code uses in a way the change does not break'],
    ] as const
  ).flatMap(([reach, text]) => {
    const count = passingChanges.filter((change) => change.reach === reach).length;
    return count ? [{ count, text }] : [];
  });
  const changeCount = `${passingChanges.length} contract change${passingChanges.length === 1 ? '' : 's'}`;
  const unusedSummary =
    reachCounts.length === 1
      ? `${changeCount} ${reachCounts[0].text}.`
      : `${changeCount} do not hold back this patch: ${reachCounts
          .map(({ count, text }) => `${count} that ${text}`)
          .join(', ')
          .replace(/, ([^,]*)$/, ' and $1')}.`;
  const unusedChanges = passingChanges.map(
    (change) =>
      `${code(`${change.operation} ${change.path}`)} ${plainText(String(change.text))}: ${plainText(String(change.reachReason))}`,
  );
  const unmigratedSites = [...unmigratedUsages.values()].map((group) => {
    const fields = new Set(
      group.flatMap((site) => {
        const entry = report.changes.find((candidate) => candidate.id === site.changeId);
        return entry ? [code(`${entry.schema}.${entry.property}`)] : [];
      }),
    );
    const [site] = group;
    return `${code(`${site.file}:${site.line}`)} ${site.changeId.startsWith('request-parameter:') ? 'sends' : 'reads'} ${code(site.expression)}${fields.size ? ` (${[...fields].join(' or ')})` : ''}`;
  });
  // The Overview counts confirmed usages; the ones left can include usages traced less certainly.
  const confirmedLeft = [...unmigratedUsages.values()].filter((group) =>
    group.some((site) => site.confidence === 'confirmed'),
  ).length;
  // Calls to changed operations that the rescan has no site for; only the run report lists them.
  const unlisted = sites ? Math.max(0, unresolvedReads - unmigratedSites.length) : 0;
  // Why a [Needs review] draft needs review opens the body; the checklist at the end has the actions.
  const usagesLeft = [
    ...(unresolvedReads
      ? [
          `${unresolvedReads} usage${unresolvedReads === 1 ? '' : 's'} of the breaking changes${sites && !unlisted && confirmedLeft !== unresolvedReads ? ` (${confirmedLeft ? `${confirmedLeft} confirmed, ${unresolvedReads - confirmedLeft}` : 'none confirmed; Refit'} traced ${confirmedLeft ? 'with less certainty' : 'them with less certainty'})` : ''} ${unresolvedReads === 1 ? 'is' : 'are'} still unmigrated: no rule changed ${unresolvedReads === 1 ? 'it' : 'them'}${passed ? `, and the checks passed without ${unresolvedReads === 1 ? 'it' : 'them'}` : ''}. ${unmigratedSites.length ? (unlisted ? `${unmigratedSites.length} ${unmigratedSites.length === 1 ? 'is' : 'are'} listed under Left Unchanged; the other ${unlisted} (${unlisted === 1 ? 'a call to a changed operation' : 'calls to changed operations'}) ${unlisted === 1 ? 'is' : 'are'} in Refit's run report.` : `${unresolvedReads === 1 ? 'It is' : 'Each is'} listed under Left Unchanged.`) : "The locations are in Refit's run report."}`,
        ]
      : []),
    ...(untracedSites.length
      ? [
          `Refit could not trace ${untracedSites.length} read${untracedSites.length === 1 ? '' : 's'} of removed field names to a ${plainText(provider)} object, so it left ${untracedSites.length === 1 ? 'it unchanged; it is' : 'them unchanged; each is'} listed under Left Unchanged.`,
        ]
      : []),
  ];
  // Provider pages that document the change, from the rule's source and attached vendor notes.
  const sourceUrls = [
    ...new Set(
      [
        ...('source' in patch && typeof patch.source === 'string' ? [patch.source] : []),
        ...rulePages.map((page) => page.url),
        ...vendorNotes(patch).map((note) => note.url),
        ...(cardRename || listedMethods.length || movedExpressions.length
          ? [PAYMENT_METHOD_TYPES_CHANGELOG]
          : []),
      ].filter((url) => link(url)),
    ),
  ];
  const sources = sourceUrls.map((url) => link(url)!);
  // Only entries that ran on both sides count; a broken generated check counts neither way. Reports
  // written before generated checks recorded a status derive it as they did then.
  const recorded: { status?: string; ran?: number } | undefined = generated;
  const legacyRan = generated ? generated.entryPoints.length - generated.notRunnable.length : 0;
  const generatedStatus =
    recorded?.status ??
    (generated?.patched.status === 'not-run'
      ? 'not-run'
      : legacyRan === 0
        ? 'not-runnable'
        : generated?.patched.status === 'passed'
          ? 'passed'
          : 'regression');
  const generatedResult = !generated
    ? ''
    : generatedStatus === 'not-run'
      ? ' Generated stripe-mock checks did not run.'
      : generatedStatus === 'unavailable'
        ? ` Generated stripe-mock checks were unavailable, so they count neither for nor against this patch: ${plainText(generated.reason ?? 'no reason recorded')}`
        : generatedStatus === 'not-runnable'
          ? ` Generated stripe-mock checks could not run any of ${generated.entryPoints.length} exported functions on their own.`
          : generatedStatus === 'regression'
            ? ` Generated stripe-mock checks failed on ${generated.regressions.length} of ${generated.entryPoints.length} exported functions.`
            : ` Generated stripe-mock checks passed on ${recorded?.ran ?? legacyRan} of ${generated.entryPoints.length} exported functions.`;
  const generatedPassed = generatedStatus === 'passed';
  const fileTotal = changedFiles(patch.diff).length;
  const stripe = provider === 'Stripe';
  const webhookReads = report.findings.some((finding) => finding.webhook);
  // Founder decision (2026-10-28): webhook reads the generated helpers migrated work under the old
  // and the new payload, so the endpoint's version is a deploy step, not a hold.
  const helperWebhooks =
    !webhookGate &&
    report.findings.some((finding) => HELPER_RULES.has(finding.webhook?.migration?.rule ?? ''));
  // Clients whose version a deployment environment variable sets (founder decision, 2026-10-28):
  // a note naming the variable, not a hold. A repository default the patch moves is listed too.
  const environmentPins = (report.apiVersion?.source?.declarations ?? []).filter(
    (declaration) => declaration.environment,
  );
  const environmentVariables = [
    ...new Set(environmentPins.map((declaration) => code(declaration.environment!))),
  ];
  // What the run did not establish, in one place, so a reviewer does not infer it from silence.
  const notVerified = [
    ranCode
      ? `Refit made no request to ${plainText(provider)}. The checks ran on this repository's code in offline Docker, so they cover only the code paths they exercise.`
      : passed
        ? `Refit made no request to ${plainText(provider)}, and ${commandText(validation.command)} runs none of this repository's code${generatedPassed ? '; only the generated stripe-mock checks called any of it' : ''}.`
        : `Refit made no request to ${plainText(provider)}, and the checks did not pass or did not run on this patch.`,
    ...(ai
      ? [
          'The AI-written lines are checked only by the commands above; read them as you would a teammate’s.',
        ]
      : []),
    ...(stripe && (pinFiles.length || webhookReads)
      ? [
          'Webhook endpoints keep the API version set in the Stripe Dashboard. This patch does not change them, so events can keep arriving in the old shape until you update them.',
        ]
      : []),
    ...(environmentPins.length
      ? [
          `The API version comes from ${summaryList(environmentVariables)} where you deploy (${summaryList(environmentPins.map((declaration) => code(`${declaration.file}:${declaration.line}`)))}), which Refit cannot read.${environmentPins.some((declaration) => declaration.value) ? ' This patch moves the default the code falls back to; a value set in the environment still overrides it.' : ''}`,
        ]
      : []),
    ...(shopify
      ? ['Requests the Shopify SDK makes on its own (authentication, billing) were not checked.']
      : []),
    ...(untracedSites.length
      ? [
          `${untracedSites.length} untraced read${untracedSites.length === 1 ? ' was' : 's were'} left unchanged; see Left Unchanged.`,
        ]
      : []),
    ...(unresolvedReads
      ? [`${unresolvedReads} usage${unresolvedReads === 1 ? ' is' : 's are'} still unmigrated.`]
      : []),
    ...(parameterCalls.length
      ? [
          `${parameterCalls.length} call${parameterCalls.length === 1 ? ' still sends' : 's still send'} a removed request parameter.`,
        ]
      : []),
  ];
  const rollback = [
    `Revert this pull request. It changes ${fileTotal} ${fileTotal === 1 ? 'file' : 'files'} and adds no database migration or environment variable.`,
    ...(pinFiles.length ? [`The revert restores the pinned API version ${code(pinFrom!)}.`] : []),
    ...(upgrade
      ? [
          `It also restores ${code(report.adapter.packageName)} ${code(upgrade.from)} in the package manifest and lockfile; reinstall dependencies after reverting.`,
        ]
      : []),
    ...(helperFiles.length
      ? [`It removes the generated ${summaryList(helperFiles.map((file) => code(file.path)))}.`]
      : []),
    ...inlined.map(
      (file) =>
        `It removes the generated ${summaryList(inlineHelpers(file).map(code))} from ${code(file.path)}.`,
    ),
    `Refit changed nothing outside this repository${stripe ? ': no Stripe Dashboard, webhook endpoint or account setting' : ''}.`,
  ];
  const checklist = [
    ...(versionBump
      ? [
          "Check each webhook endpoint's API version in the Stripe Dashboard (Developers > Webhooks). Endpoints have their own version, which this pull request does not change.",
        ]
      : []),
    `Read each change under Code Changes${sources.length ? ' against the provider page linked in Overview' : ''}.`,
    ...(dependency
      ? [
          upgradeUninstalled
            ? 'Install the upgraded dependencies and run your checks: Refit could not run them on this patch.'
            : 'Install dependencies and run your checks: Refit could not run any.',
        ]
      : []),
    ...(parameterGate
      ? ['Change or remove each call under Removed request parameters left for you.']
      : []),
    ...(webhookGate
      ? [
          `Set the webhook endpoint API version to ${code(webhookGate.targetVersion)} when you deploy, or confirm it already is.`,
        ]
      : []),
    ...(helperWebhooks && !versionBump && report.apiVersion?.after
      ? [
          `Set each webhook endpoint's API version to ${code(report.apiVersion.after)} when you deploy. The generated helpers read the old and the new payload, so the handlers work before and after.`,
        ]
      : []),
    ...(environmentPins.length && report.apiVersion?.after
      ? [
          `Set ${summaryList(environmentVariables)} to ${code(report.apiVersion.after)} in every environment you deploy to, or confirm ${environmentVariables.length === 1 ? 'it is' : 'they are'} already.`,
        ]
      : []),
    ...(reviews ?? [])
      .filter((entry) => !CHECKLISTED_GATES.has(entry.gate))
      .map((entry) => entry.check),
    ...(cardOnly ? ['Confirm cards stay enabled in the Stripe Dashboard.'] : []),
    ...listedMethods.map(
      (methods) => `Confirm ${code(`[${methods}]`)} are still offered where you rely on them.`,
    ),
    ...movedExpressions.map(
      (expression) => `Confirm the runtime values of ${code(expression)} (see Key Changes).`,
    ),
    ...(untracedSites.length ? ['Check each read under Left Unchanged.'] : []),
    ...(unresolvedReads
      ? [
          `Migrate the ${unresolvedReads} usage${unresolvedReads === 1 ? '' : 's'} Refit left unmigrated${unmigratedSites.length ? ' (see Left Unchanged)' : ''}.`,
        ]
      : []),
    ...(flaggedPeriods.length
      ? ['Choose the subscription item for mixed billing periods (see Key Changes).']
      : []),
    ...(selectedPeriods.length
      ? [
          'Confirm the selected item is the one whose period this code needs when items bill on different periods (see Key Changes).',
        ]
      : []),
    ...(ranCode
      ? [
          `Confirm ${commandText(validation.command)} exercises the code this patch changes, or add a test that does.`,
        ]
      : passed
        ? [
            `Run the code this patch changes, or add a test that does: ${commandText(validation.command)} does not run it.`,
          ]
        : dependency
          ? []
          : validation.baseline.status !== 'passed'
            ? [
                `Make ${commandText(validation.baselineCommand)} pass on the original code, or configure a check that does, then run Refit again.`,
              ]
            : [
                `Fix what ${commandText(validation.command)} reports on the migrated code (see Automated Verification Gates).`,
              ]),
  ];
  const tracedCalls = versionBump ? report.sdkCalls.length : 0;
  const overview = versionBump
    ? `Refit traced ${tracedCalls} ${plainText(provider)} call${tracedCalls === 1 ? '' : 's'} in this code, and none uses anything ${plainText(provider)} API ${after} changes. ${pinFiles.length ? `This patch moves every ${code('apiVersion')} pin to ${after}${upgrade ? ` and upgrades ${code(report.adapter.packageName)} from ${code(upgrade.from)} to ${code(upgrade.to)} in the package manifest and lockfile` : ''}.` : `No client sets ${code('apiVersion')}, so the installed ${code(report.adapter.packageName)} decides the version: this patch upgrades it${upgrade ? ` from ${code(upgrade.from)} to ${code(upgrade.to)}` : ''} in the package manifest and lockfile, which sends ${after}.`}${passed ? ' The checks passed before and after the change.' : ''}`
    : shopify
      ? `This app pins Shopify Admin API ${plainText(report.apiVersion.application ?? 'an older version')}. A deterministic Refit rule moves it to ${after} after checking every traced GraphQL document against the ${after} schema.`
      : `${plainText(provider)} API ${after} ${overviewCauses.length ? overviewCauses.join(' and ') : 'changes API usage this code relies on'}. ${
          patch.diff
            ? `${ai ? `AI${model ? ` (${code(model)})` : ''}, checked by Refit,` : 'A deterministic Refit rule'} migrates ${usageCount} in ${fileCount}.`
            : `No Refit rule changes the ${usageCount} in ${fileCount}, so this patch changes no files.`
        }`;
  const checks = passed
    ? passedChecks(validation)
    : dependency
      ? upgradeUninstalled
        ? `${commandText(validation.baselineCommand)} passed on the original code. **Not run on this patch: installing its upgraded lockfile failed (${code(dependency.failure.reason)}); this patch is untested.**`
        : `**Not run: dependency preparation failed (${code(dependency.failure.reason)}); this patch is untested.**`
      : failedChecks(validation);
  const aiLines = gated(reviews, 'ai-patch') ? aiWrittenLines(patch, Boolean(upgrade)) : [];
  const explanations = ('explanations' in patch && patch.explanations) || [];
  const policies = validation.repair?.policies ?? [];
  // Every reason this draft needs review, each with what to check and where (owner decision 1).
  const reasonList = (siteLimit: number) =>
    (reviews ?? []).map((entry) => {
      const sites = [
        ...(('sites' in entry && entry.sites) || []).map(
          (site) =>
            `${code(site.line ? `${site.file}:${site.line}` : site.file)}${site.detail ? ` ${code(site.detail)}` : ''}`,
        ),
        ...(('changes' in entry && entry.changes) || []).map(plainText),
        ...(entry.gate === 'ai-patch'
          ? [
              ...(aiLines.length ? aiLines : ['None: every changed line comes from a Refit rule.']),
              // What the AI resolved on top of the rules' patch (owner decisions 1 and 8).
              ...(validation.coverageAi?.resolved ?? []).map(
                (site) => `Resolved by AI: ${code(site.file)} ${code(site.expression)}`,
              ),
            ]
          : []),
      ];
      return [
        `- ${entry.reason} **Check:** ${entry.check}`,
        ...(sites.length ? [siteList(sites, siteLimit).replace(/^/gm, '  ')] : []),
      ].join('\n');
    });
  const render = (diffLimit: number, siteLimit: number, shortened?: string) =>
    [
      ...(reviews?.length
        ? [
            '## Why this needs review',
            `Refit opened this draft for review instead of stopping (owner decision 1). **Don't merge until you have checked each item.**${aiLines.length ? ' The AI-written lines are listed with the AI item.' : ''}`,
            reasonList(siteLimit).join('\n'),
          ]
        : []),
      // Founder decision (2026-10-28): each edit of an AI repair where a policy used to stop.
      ...(explanations.length
        ? [
            '## What the AI changed and why',
            `The patch broke the build, and AI repaired it where Refit used to stop for review (founder decision, 2026-10-28). **Check each edit and its source before merging.**${policies.length ? ` Without that decision, Refit would have stopped here: ${policies.map(plainText).join(' ')}` : ''}`,
            explanations
              .map(
                (note) =>
                  `- ${code(`${note.file}:${note.line}`)} Build error: ${code(note.error.length > MAX_QUOTE ? `${note.error.slice(0, MAX_QUOTE)}...` : note.error)} Change: ${plainText(note.why)} Source: ${/^https:\/\/\S+$/.test(note.source) ? note.source : '**none: no documentation page backs this edit.**'}`,
              )
              .join('\n'),
          ]
        : []),
      ...(dependency
        ? [
            '## Untested: checks did not run',
            upgradeUninstalled
              ? `**Refit did not run any checks on this patch.** ${commandText(validation.baselineCommand)} passed on the original code, but ${dependency.failure.reason === OTHER_DEPENDENCY_FAILURE.reason ? 'Refit could not install the upgraded lockfile this patch writes in its sandbox' : `the upgraded lockfile this patch writes could not be installed because ${plainText(dependency.failure.summary)}`}, so the patched code was not built or tested. Nothing in this patch is verified.`
              : `**Refit did not run any checks on this patch.** Preparing the repository's dependencies failed because ${plainText(dependency.failure.summary)}, so neither the original nor the patched code was built or tested. Nothing in this patch is verified.`,
            `> ${plainText(dependency.failure.message.length > MAX_QUOTE ? `${dependency.failure.message.slice(0, MAX_QUOTE)}...` : dependency.failure.message)}`,
            // A stop names what Refit could not do, never a task (founder decision, 2026-10-28).
            `**What Refit could not do:** ${dependency.failure.action}`,
          ]
        : []),
      ...(parameterGate
        ? [
            '## Removed request parameters left for you',
            `**Don't merge until you change the calls below.** ${plainText(provider)} API ${code(parameterGate.targetVersion)} no longer accepts ${summaryList(parameters.map(code))}, and this patch still sends ${parameterCalls.length === 1 ? 'it' : 'them'}, so ${parameterCalls.length === 1 ? 'this request fails' : 'these requests fail'} after the upgrade. Refit didn't change ${parameterCalls.length === 1 ? 'it' : 'them'}: dropping or replacing a request parameter changes what the request does, so that's your decision.`,
            ...parameters.map(
              (parameter) =>
                REMOVED_PARAMETER_NOTES[parameter] ??
                `No reviewed replacement for ${code(parameter)} exists. Check the ${plainText(provider)} changelog for ${code(parameterGate.targetVersion)}, then remove or replace it.`,
            ),
            siteList(
              parameterCalls.map(
                (call) =>
                  `${code(`${call.file}:${call.line}`)}: ${code(call.call)} sends ${code(call.parameter)}`,
              ),
              Math.max(siteLimit, 1),
            ),
          ]
        : []),
      ...(webhookGate
        ? [
            '## Webhook API version not verified',
            `This patch changes webhook handlers. Stripe sends webhooks in the API version set on the webhook endpoint in the Stripe dashboard, which Refit can't see from code. Before merging, check the endpoint's API version in Dashboard > Developers > Webhooks and confirm it matches ${code(webhookGate.targetVersion)}, or update it when you deploy.`,
            siteList(
              // One read can break more than one field change; list its site once.
              [
                ...new Set(
                  webhookGate.handlers.map(
                    (handler) =>
                      `${code(`${handler.file}:${handler.line}`)}${handler.eventTypes.length ? ` (${handler.eventTypes.map(code).join(', ')})` : ''}`,
                  ),
                ),
              ],
              Math.max(siteLimit, 1),
            ),
          ]
        : []),
      ...(usagesLeft.length
        ? [
            '## Usages left for you',
            `**Don't merge until you have migrated or checked each usage Refit left.** ${usagesLeft.join(' ')}`,
          ]
        : []),
      '## Overview',
      ...(versionBump
        ? [
            overview,
            '## Traced Stripe Calls',
            siteList(
              report.sdkCalls.map(
                (call) =>
                  `${code(`${call.file}:${call.line}`)} ${code(`${call.resource}.${call.method}`)}`,
              ),
              Math.max(siteLimit, 1),
            ),
          ]
        : [
            shopify
              ? overview
              : `${overview}${sources.length ? ` ${plainText(provider)} documents the change: ${sources.join(', ')}.` : ''}`,
          ]),
      '## API Impact & Spec Changes',
      [
        `- Breaking Changes: ${breaking.join(' ') || 'Recorded in the technical evidence.'}`,
        '- Database Migrations: None.',
        '- Environment Variables: None.',
      ].join('\n'),
      '## Key Changes',
      [...keyChanges, ...review.map((entry) => `- Review: ${entry}`)].join('\n'),
      '## Code Changes',
      ...changeSections(patch.diff, diffLimit),
      ...(shortened
        ? [
            `This description is shortened to stay under ${MAX_BODY_CHARACTERS.toLocaleString('en-US')} characters (${shortened}); migration.patch and report.json have everything.`,
          ]
        : []),
      '## Automated Verification Gates',
      [
        // The measured grade, when validation recorded one, replaces the command-based strength.
        grade
          ? `- Evidence Grade: **${grade.letter ? `${grade.letter}, ` : ''}${EVIDENCE_LABELS[grade.level]}.** ${plainText(grade.reason)}`
          : `- Evidence Strength: ${evidenceStrength(validation, generatedPassed)}`,
        `- Test Suite Output: ${checks}${generatedResult}`,
        // Owner decision D2a: the type check stood in for tests the repository does not have.
        ...(validation.coverageAi?.gate?.typeCheckOnly
          ? [
              '- Validated by type check, no tests: every contract change the AI patch handles is visible to the type check against the target stripe-node, which shows no new error in the TypeScript files it changed.',
            ]
          : []),
        // Founder decision (2026-10-28): untraced reads proven not to read a Stripe object.
        ...(validation.localReads?.length
          ? [
              `- Untraced Reads Cleared: Refit proved these reads of removed field names do not read a ${plainText(provider)} object, so they were left unchanged and do not hold the draft for review: ${summaryList(
                [
                  ...new Set(
                    validation.localReads.map(
                      (site) =>
                        `${code(`${site.file}:${site.line}`)} reads ${code(site.expression)} (${LOCAL_PROOFS[site.proof]})`,
                    ),
                  ),
                ],
              )}.`,
            ]
          : []),
        // Founder decision (2026-10-28): a repair that ended on a repeated proposal says why.
        ...(validation.repair?.stopReason === 'repeated-proposal' && validation.repair.error
          ? [`- AI Repair: ${plainText(validation.repair.error)}`]
          : []),
        // Stripe test mode: what Refit stood in for in its own account, and what it could not.
        ...testModeLines(validation),
        ...(legacyPeerDeps
          ? [
              `- Dependency Installation: \`npm ci\` rejected the ${resolvedLockfiles.length ? 'resolved' : 'committed'} lockfile's peer dependencies, so Refit installed the same lockfile with \`--legacy-peer-deps\`. Check that your own install uses the same setting.`,
            ]
          : []),
        ...(fromBunLock
          ? [
              '- Dependency Installation: Refit translated the committed `bun.lock` into an npm lockfile with the same packages, versions, paths and integrity hashes, and installed it with `npm ci`; Bun itself did not run.',
            ]
          : []),
        ...(lockfileChoice
          ? [
              `- Dependency Installation: the repository commits ${[lockfileChoice.lockfile, ...otherLockfiles.map(([file]) => file)].map(code).join(' and ')}. Refit installed ${code(lockfileChoice.lockfile)}, ${lockfileChoice.because}, and did not read ${otherLockfiles.length === 1 ? 'the other' : 'the others'}${otherLockfiles.every(([, note]) => note === 'not read') ? '.' : `: ${otherLockfiles.map(([, note]) => plainText(note)).join(' ')}`}${unchangedLockfiles.length ? ` This patch upgrades stripe in ${code(lockfileChoice.lockfile)} only and leaves ${unchangedLockfiles.map(code).join(' and ')} as committed, still locking the older stripe.` : ''} Delete the lockfile your package manager does not use.`,
            ]
          : []),
        ...(resolvedLockfiles.length
          ? [
              `- Dependency Installation: the checks ran against a \`package-lock.json\` Refit resolved, not one the repository commits (${{ 'no-lockfile': 'it commits none', 'lockfile-out-of-sync': 'the committed one is out of sync with `package.json`', 'lockfile-integrity': 'the committed one has entries without integrity hashes' }[resolvedLockfiles[0].reason] ?? resolvedLockfiles[0].reason}). npm resolved it with lifecycle scripts off from registry.npmjs.org as of ${resolvedLockfiles[0].before}, the last commit date${[...new Set(resolvedLockfiles.flatMap((entry) => Object.entries(entry.late ?? {}).map(([name, pin]) => `${code(`${name}@${pin.spec}`)} as of ${pin.published}`)))].map((pin, index) => `${index ? ', ' : '; '}${pin}`).join('')}, and installed it with \`npm ci\`. It is not part of this pull request; commit your own lockfile and rerun your checks.`,
            ]
          : []),
        ...(prunedGlibcPackages
          ? [
              `- Dependency Installation: after the verified \`npm ci\`, Refit removed ${prunedGlibcPackages} installed native package${prunedGlibcPackages === 1 ? '' : 's'} declared for glibc only, which cannot load on the Alpine (musl) image. The lockfile is unchanged.`,
            ]
          : []),
        `- Linter & Static Analysis: ${typeChecked ? 'TypeScript type check is the test command above; ' : 'Not run; '}${shopify ? `Refit rescanned the migrated code and every runtime Admin API pin is on ${after}.` : `Refit rescanned the migrated code and ${unresolvedReads} usage${unresolvedReads === 1 ? ' of the breaking changes remains' : 's of the breaking changes remain'}${parameterCalls.length ? `, plus ${parameterCalls.length} call${parameterCalls.length === 1 ? '' : 's'} sending a removed request parameter` : ''}${untracedSites.length ? `, plus ${untracedSites.length} untraced read${untracedSites.length === 1 ? '' : 's'} of removed field names` : ''}.`}`,
        '- Security Scans: Not run.',
      ].join('\n'),
      ...(unmigratedSites.length || untracedSites.length ? ['## Left Unchanged'] : []),
      ...(unmigratedSites.length
        ? [
            `Refit traced these usages to ${plainText(provider)} objects but no rule changed them, so the migrated code still uses what the upgrade removes. Migrate each one before merging:`,
            siteList(unmigratedSites, siteLimit),
          ]
        : []),
      ...(untracedSites.length
        ? [
            `Refit could not trace these reads of removed field names to a ${plainText(provider)} object, so it did not change them. Check each one: a read of a ${plainText(provider)} object here breaks after the upgrade.`,
            siteList(untracedSites, siteLimit),
          ]
        : []),
      ...(unusedChanges.length
        ? [
            '## Changed, Not Used By Traced Code',
            unusedSummary,
            // Collapsed: a full comparison can list dozens, which would bury the sections below.
            `<details>\n<summary>Show the ${unusedChanges.length === 1 ? 'change' : `${unusedChanges.length} changes`}</summary>`,
            'The target contract changes these parts in a breaking way. No traced call sends them and no read of them was found, a kept rule edit rewrites them, or reading them is unaffected, so they do not hold back this change. Each line gives the reason.',
            siteList(unusedChanges, siteLimit),
            '</details>',
          ]
        : []),
      '## Not Verified',
      notVerified.map((entry) => `- ${entry}`).join('\n'),
      '## Rollback',
      rollback.map((entry) => `- ${entry}`).join('\n'),
      '## Reviewer Checklist',
      checklist.map((entry) => `- [ ] ${entry}`).join('\n'),
      '## Related Telemetry',
      [
        '- Closes Issue: None.',
        `- Linked Sentry/Linear ID: N/A. Refit run ${code(report.runId.slice(0, 12))}${integration ? `, integration ${code(integration)}` : ''}.`,
        ...(destination === 'local'
          ? [
              '- Publication: Local review artifact; Refit has not pushed a branch or opened a pull request.',
            ]
          : []),
      ].join('\n'),
      ...(integration ? [`${INTEGRATION_MARKER}${integration} -->`] : []),
      `${MIGRATION_MARKER}${migrationIdentity(report, validation.revision, integration)} -->`,
      `<!-- refit-evidence "runId": "${report.runId}", "patchHash": "${validation.patchHash}", "refit": "${REFIT_VERSION}" -->`,
    ].join('\n\n') + '\n';
  // Shorter diffs first, then shorter site lists, until the body fits.
  const tiers: [number, number, string?][] = [
    [MAX_VISIBLE_DIFF_LINES, MAX_LISTED_SITES],
    [40, MAX_LISTED_SITES, 'code changes cut to 40 lines'],
    [20, 10, 'code changes cut to 20 lines and site lists to 10'],
    [0, 3, 'code changes and most site lists left out'],
  ];
  const body =
    tiers
      .map(([diffLimit, siteLimit, shortened]) => render(diffLimit, siteLimit, shortened))
      .find((text) => text.length <= MAX_BODY_CHARACTERS) ??
    render(0, 0, 'code changes and site lists left out');
  // The commit explains itself in `git log`: the title without its review prefix, what changed per
  // file, the checks, the provider pages and the run, as plain text wrapped at 72 columns.
  const commitMessage = `${[
    title.slice(prefix.length),
    '',
    wrap(overview.replace(/`/g, '')),
    '',
    ...keyChanges.slice(0, MAX_LISTED_SITES).map((entry) => wrap(entry.replace(/`/g, ''), '  ')),
    ...(keyChanges.length > MAX_LISTED_SITES
      ? [`- and ${keyChanges.length - MAX_LISTED_SITES} more files; see the pull request.`]
      : []),
    '',
    wrap(`Checks: ${checks.replace(/`|\*\*/g, '')}`),
    ...(needsReview
      ? ['', wrap('Needs review: the pull request lists what to check before merging.')]
      : []),
    ...(sourceUrls.length ? ['', ...sourceUrls.map((url) => `Source: ${url}`)] : []),
    '',
    `Refit-Run: ${report.runId.slice(0, 12)}`,
    ...(integration ? [`Refit-Integration: ${integration}`] : []),
  ].join('\n')}\n`;
  const files = {
    'report.json': `${JSON.stringify(reviews?.length ? { ...report, waivedGates: reviews } : report, null, 2)}\n`,
    'migration.patch': patch.diff,
    'pull-request.md': body,
  };
  const manifest = {
    formatVersion: 1,
    kind: 'refit-review-bundle',
    ...(integration ? { integration } : {}),
    ...(reviews?.length ? { waivedGates: reviews.map((entry) => entry.gate) } : {}),
    runId: report.runId,
    revision: validation.revision,
    title,
    validationStatus: validation.status,
    reviewRequired: true,
    published: false,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: digest(content),
      bytes: Buffer.byteLength(content),
    })),
  };
  return { files, manifest, commitMessage };
}

export async function writeReviewBundle(directory: string, report: ValidationReport) {
  const { files, manifest } = createReviewArtifacts(report);
  const root = resolve(directory);
  await mkdir(root, { mode: 0o700 });
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(root, name), content, { flag: 'wx', mode: 0o600 });
    // The manifest is written last so interrupted bundles have no completion marker.
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { directory: root, manifest };
}
