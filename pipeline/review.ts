import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import { digest, type AddedProperty } from './specifications.ts';
import { affectedFields } from './report-fields.ts';
import { PipelineInputError, type Finding } from './types.ts';
import type { validateMigration } from './validation.ts';
import { INTEGRATION_MARKER, migrationIdentity } from './migration-identity.ts';
import type { publicationWaiver } from './publication.ts';
import { REMOVED_PARAMETER_NOTES } from './request-removals.ts';
import { OPEN_ENUM_REPAIR, UNTYPED_REQUEST_PROPERTIES } from './stripe-open-enums.ts';

type PublicationWaiver = NonNullable<ReturnType<typeof publicationWaiver>>;

type ValidationReport = Awaited<ReturnType<typeof validateMigration>>;
const MAX_SUMMARY_ITEMS = 5;
// Conventional Commits title limit from the PR template.
const MAX_TITLE = 70;
// Longer diffs stay readable in the Files changed tab and migration.patch.
const MAX_VISIBLE_DIFF_LINES = 80;
const MAX_QUOTE = 300;
// The body stays well under GitHub's 65,536-character limit and readable in one sitting; above
// this, diffs and site lists shorten in steps and the body says what it left out.
export const MAX_BODY_CHARACTERS = 16_000;
const MAX_LISTED_SITES = 25;
// Source: Stripe changelog, 2026-09-30.endive, read 2026-10-22.
const PAYMENT_METHOD_TYPES_CHANGELOG =
  'https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions';
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

function plainText(value: string) {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
}

function code(value: string) {
  const content = value.replace(/[\x00-\x1f\x7f]/g, ' ');
  const fence = '`'.repeat(
    Math.max(1, ...(content.match(/`+/g) ?? []).map((run) => run.length + 1)),
  );
  return `${fence}${content}${fence}`;
}

function summaryList(values: string[]) {
  const visible = values.slice(0, MAX_SUMMARY_ITEMS);
  const remaining = values.length - visible.length;
  return `${visible.join(', ')}${remaining ? `, and ${remaining} more` : ''}`;
}

function fenced(language: string, content: string) {
  const runs = content.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((width, run) => Math.max(width, run.length + 1), 3));
  return `${fence}${language}\n${content}\n${fence}`;
}

function quote(value: string) {
  const text = value.replace(/\s+/g, ' ').trim();
  return `“${plainText(text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text)}”`;
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

function enclosingFunction(lines: string[], index: number) {
  for (let line = index; line >= 0; line--) {
    const match = /\bfunction\s+([A-Za-z_$][\w$]*)/.exec(lines[line]);
    if (match) return match[1];
  }
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
    const afterLines = file.after.split('\n');
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
      const name = enclosingFunction(afterLines, firstChange - 1);
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
        `The after contract documents ${code(replacement)} as the replacement: ${quote(described)}.`,
      );
    else if (note) {
      const sentence =
        note.content
          .split(/(?<=[.!?])\s+|\n+/)
          .find((part) => part.includes(change.property) && part.includes(replacement)) ??
        note.content;
      reasons.push(
        `The attached vendor note (${plainText(note.label)}, ${plainText(note.url)}) says ${quote(sentence)}.`,
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

export function createReviewArtifacts(
  report: ValidationReport,
  destination: 'local' | 'github' = 'local',
  integration?: string,
  waiver?: PublicationWaiver,
) {
  const { validation, patch } = report;
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
  // Lists of card plus other methods the repository opted to keep, as the patch writes them.
  const listedMethods = [
    ...new Set(
      [...patch.diff.matchAll(/^\+.*allowed_payment_method_types['"]?\s*:\s*\[([^\]]*)\]/gm)]
        .map((match) => [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]))
        .filter((methods) => methods.length > 1)
        .map((methods) => methods.join(', ')),
    ),
  ];
  const request = requestChanges[0];
  const subscriptionPolicy = report.findings.some((finding) => finding.webhook?.migration)
    ? report.adapter.stripeSubscriptionPeriods
    : undefined;
  const description = subscriptionPolicy
    ? 'preserve subscription periods after item-level billing'
    : request && requestChanges.length === 1 && !operationChanges.length && !readChanges.length
      ? `update ${request.resource}.${request.method} after ${request.removed} removal`
      : endpoint && operationChanges.length === 1 && !readChanges.length
        ? `replace retired ${endpoint.resource}.${endpoint.method} calls`
        : cardRename && !readChanges.length
          ? 'move payment_method_types to allowed_payment_method_types'
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
  const keptProperties = validation.repair?.keptProperties ?? [];
  const needsReview = Boolean(waiver || patch.unresolvedFindings || keptProperties.length);
  const prefix = needsReview ? '[Needs review] ' : '';
  const full = `${prefix}fix(${scope}): ${versionTitle ?? description}`;
  const title =
    full.length <= MAX_TITLE
      ? full
      : `${prefix}fix(${scope}): migrate removed API fields`.slice(0, MAX_TITLE);
  const confirmedFindings = report.findings.filter((finding) => finding.confidence === 'confirmed');
  const affectedFiles = new Set(confirmedFindings.map((finding) => finding.file));
  const changes = summaryList(
    readChanges.map((entry) => code(`${entry.schema}.${entry.property}`)),
  );
  const { reasons, replacements } = replacementReasons(report);
  const usageCount = `${confirmedFindings.length} confirmed ${confirmedFindings.length === 1 ? 'usage' : 'usages'}`;
  const fileCount = `${affectedFiles.size} ${affectedFiles.size === 1 ? 'file' : 'files'}`;
  const after = plainText(report.apiVersion.after ?? 'the after contract');
  // Calls that still send a removed request parameter and untraced reads (no rule edits them) are
  // counted as unresolved; each gets its own line, so the confirmed count below leaves them out.
  const parameterCalls = waiver?.gate === 'removed-request-parameter' ? waiver.calls : [];
  const untracedReads = report.findings.filter((finding) => finding.untraced).length;
  const unresolvedReads = Math.max(
    0,
    patch.unresolvedFindings - parameterCalls.length - untracedReads,
  );
  const parameters = [...new Set(parameterCalls.map((call) => call.parameter))];
  const passed = validation.status === 'passed';
  const legacyPeerDeps = [validation.environment, validation.patchedEnvironment].some(
    (environment) =>
      (environment?.installation as { legacyPeerDeps?: unknown } | undefined)?.legacyPeerDeps ===
      true,
  );
  const commandText = (value: readonly string[]) => code(value.join(' '));
  const ai = patch.generator === 'openai';
  const model = 'model' in patch && typeof patch.model === 'string' ? patch.model : undefined;
  const periodReads = (rareCase: NonNullable<Finding['subscriptionPeriod']>['rareCase']) =>
    report.findings.filter((finding) => finding.subscriptionPeriod?.rareCase === rareCase);
  const flaggedPeriods = periodReads('flagged');
  const unconfirmed = report.findings.filter((finding) => finding.untraced);
  const selectedPeriods = [...periodReads('item-in-code'), ...periodReads('price-policy')];
  const generated = validation.generated;
  const sameCommand = validation.baselineCommand.join(' ') === validation.command.join(' ');
  const command = validation.command.join(' ');
  const typeChecked = /\btsc\b/.test(command);
  const migratedFields = (path: string) => [
    ...new Set(
      confirmedFindings
        .filter((finding) => finding.file === path && !finding.untraced)
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
      ? (patch.sdkUpgrade as { from: string; to: string })
      : undefined;
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
  const pinFiles = fileChanges(patch.diff).filter(movesPin);
  const helperFiles = fileChanges(patch.diff).filter((file) => !file.before);
  const keyChanges = fileChanges(patch.diff).map((file) => {
    const fields = migratedFields(file.path);
    const what = shopify
      ? `Moves the pinned Admin API version to ${plainText(after)}.`
      : !file.before
        ? 'Adds the generated helper that reads the removed fields under either API version.'
        : [
            ...(fields.length
              ? [`Migrates reads of ${summaryList(fields)} to the documented new locations.`]
              : []),
            ...(cardFiles.has(file.path)
              ? [
                  `Sends ${code('allowed_payment_method_types')} in place of the removed ${code('payment_method_types')}.`,
                ]
              : []),
            ...(movesPin(file)
              ? [`Moves the pinned API version from ${code(pinFrom!)} to ${code(pinTo!)}.`]
              : []),
            ...(upgrade && (/(?:^|\/)package\.json$/.test(file.path) || LOCKFILE.test(file.path))
              ? [
                  `Upgrades ${code(report.adapter.packageName)} from ${code(upgrade.from)} to ${code(upgrade.to)}.`,
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
        ...(readChanges.length
          ? [`Removes response fields ${changes} in ${plainText(provider)} API ${after}.`]
          : []),
        ...replacements.map((entry) => `Replaces ${entry}.`),
        ...requestChanges.map(
          (entry) =>
            `Renames request field ${code(entry.removed)} to ${code(entry.replacement)} in ${code(`${entry.resource}.${entry.method}`)}.`,
        ),
        ...(cardRename
          ? [
              `Removes request field ${code('payment_method_types')}; ${code("['card']")} moves to ${code('allowed_payment_method_types')} under the owner-approved policy.`,
            ]
          : []),
        ...listedMethods.map(
          (methods) =>
            `Moves ${code(`[${methods}]`)} from ${code('payment_method_types')} to ${code('allowed_payment_method_types')}, because this repository set ${code('stripePaymentMethodTypes: "keep-listed"')} in ${code('.refit.json')}.`,
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
      ];
  const overviewCauses = [
    ...(readChanges.length ? ['removes fields this code reads'] : []),
    ...(cardRename || listedMethods.length || requestChanges.some((entry) => entry.usages.length)
      ? ['removes request fields this code sends']
      : []),
    ...(operationChanges.some((entry) => entry.usages.length)
      ? ['retires endpoints this code calls']
      : []),
  ];
  const review = [
    ...(shopify?.deprecated ?? []).map(
      (entry) =>
        `Deprecated on ${after}, still served: ${code(entry.split(':')[0])}${plainText(entry.slice(entry.indexOf(':')))}`,
    ),
    ...(unresolvedReads
      ? [
          `**${unresolvedReads} confirmed usage${unresolvedReads === 1 ? '' : 's'} of the breaking changes ${unresolvedReads === 1 ? 'is' : 'are'} still unmigrated.** The checks passed without ${unresolvedReads === 1 ? 'it' : 'them'}; migrate ${unresolvedReads === 1 ? 'it' : 'them'} before merging, using the locations in Refit's run report.`,
        ]
      : []),
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
    ...(cardRename
      ? [
          `${code('allowed_payment_method_types')} filters the payment methods Stripe finds eligible instead of listing them. Before merging, confirm cards stay enabled in the Stripe Dashboard or the payment method configuration this account uses.`,
        ]
      : []),
    ...listedMethods.map(
      (methods) =>
        `Stripe now filters ${code(`[${methods}]`)} by each buyer's eligibility (country, currency, amount, device), so ${summaryList(
          methods
            .split(', ')
            .filter((method) => method !== 'card')
            .map(code),
        )} may no longer be offered to some customers. Before merging, confirm they still appear where you rely on them.`,
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
    ...(unconfirmed.length
      ? [
          `Leaves ${unconfirmed.length} untraced read${unconfirmed.length === 1 ? '' : 's'} of removed field names unchanged for manual review; each is listed under Left Unchanged.`,
        ]
      : []),
  ];
  const untracedSites = [
    ...new Set(
      unconfirmed.map(
        (finding) => `${code(`${finding.file}:${finding.line}`)} reads ${code(finding.expression)}`,
      ),
    ),
  ];
  // Provider pages that document the change, from the rule's source and attached vendor notes.
  const sourceUrls = [
    ...new Set(
      [
        ...('source' in patch && typeof patch.source === 'string' ? [patch.source] : []),
        ...vendorNotes(patch).map((note) => note.url),
        ...(cardRename || listedMethods.length ? [PAYMENT_METHOD_TYPES_CHANGELOG] : []),
      ].filter((url) => link(url)),
    ),
  ];
  const sources = sourceUrls.map((url) => link(url)!);
  // An entry that failed on the original code (missing module, unmocked service) proves nothing.
  const generatedRan = generated ? generated.entryPoints.length - generated.notRunnable.length : 0;
  const generatedResult = generated
    ? generated.patched.status === 'not-run'
      ? ' Generated stripe-mock checks did not run.'
      : generatedRan === 0
        ? ` Generated stripe-mock checks could not run any of ${generated.entryPoints.length} exported functions on their own.`
        : ` Generated stripe-mock checks ${generated.patched.status} on ${generatedRan} of ${generated.entryPoints.length} exported functions.`
    : '';
  const fileTotal = fileChanges(patch.diff).length;
  const stripe = provider === 'Stripe';
  const webhookReads = report.findings.some((finding) => finding.webhook);
  // What the run did not establish, in one place, so a reviewer does not infer it from silence.
  const notVerified = [
    passed
      ? `Refit made no request to ${plainText(provider)}. The checks ran on this repository's code in offline Docker, so they cover only the code paths they exercise.`
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
    ...(shopify
      ? ['Requests the Shopify SDK makes on its own (authentication, billing) were not checked.']
      : []),
    ...(untracedSites.length
      ? [
          `${untracedSites.length} untraced read${untracedSites.length === 1 ? ' was' : 's were'} left unchanged; see Left Unchanged.`,
        ]
      : []),
    ...(unresolvedReads
      ? [
          `${unresolvedReads} confirmed usage${unresolvedReads === 1 ? ' is' : 's are'} still unmigrated.`,
        ]
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
    `Refit changed nothing outside this repository${stripe ? ': no Stripe Dashboard, webhook endpoint or account setting' : ''}.`,
  ];
  const checklist = [
    `Read each change under Code Changes${sources.length ? ' against the provider page linked in Overview' : ''}.`,
    ...(waiver?.gate === 'dependency-preparation'
      ? ['Install dependencies and run your checks: Refit could not run any.']
      : []),
    ...(waiver?.gate === 'removed-request-parameter'
      ? ['Change or remove each call under Removed request parameters left for you.']
      : []),
    ...(waiver?.gate === 'webhook-api-version'
      ? [
          `Set the webhook endpoint API version to ${code(waiver.targetVersion)} when you deploy, or confirm it already is.`,
        ]
      : []),
    ...(cardRename ? ['Confirm cards stay enabled in the Stripe Dashboard.'] : []),
    ...listedMethods.map(
      (methods) => `Confirm ${code(`[${methods}]`)} are still offered where you rely on them.`,
    ),
    ...(untracedSites.length ? ['Check each read under Left Unchanged.'] : []),
    ...(unresolvedReads
      ? [
          `Migrate the ${unresolvedReads} confirmed usage${unresolvedReads === 1 ? '' : 's'} Refit left unmigrated.`,
        ]
      : []),
    ...(flaggedPeriods.length
      ? ['Choose the subscription item for mixed billing periods (see Key Changes).']
      : []),
    ...(passed
      ? [
          `Confirm ${commandText(validation.command)} exercises the code this patch changes, or add a test that does.`,
        ]
      : []),
  ];
  const overview = shopify
    ? `This app pins Shopify Admin API ${plainText(report.apiVersion.application ?? 'an older version')}. A deterministic Refit rule moves it to ${after} after checking every traced GraphQL document against the ${after} schema.`
    : `${plainText(provider)} API ${after} ${overviewCauses.length ? overviewCauses.join(' and ') : 'changes API usage this code relies on'}. ${ai ? `AI${model ? ` (${code(model)})` : ''}, checked by Refit,` : 'A deterministic Refit rule'} migrates ${usageCount} in ${fileCount} so the code keeps working after the upgrade.`;
  const checks = passed
    ? sameCommand
      ? `${commandText(validation.command)} passed on the original and migrated code in offline Docker.`
      : `${commandText(validation.baselineCommand)} passed on the original and ${commandText(validation.command)} on the migrated code in offline Docker.`
    : waiver?.gate === 'dependency-preparation'
      ? `**Not run: dependency preparation failed (${code(waiver.reason)}); this patch is untested.**`
      : `**Validation did not pass (${validation.status}).**`;
  const render = (diffLimit: number, siteLimit: number, shortened?: string) =>
    [
      ...(waiver?.gate === 'dependency-preparation'
        ? [
            '## Untested: checks did not run',
            `**Refit did not run any checks on this patch.** Preparing the repository's dependencies failed because ${plainText(waiver.summary)}, so neither the original nor the patched code was built or tested. Nothing in this patch is verified.`,
            `> ${plainText(waiver.message.length > MAX_QUOTE ? `${waiver.message.slice(0, MAX_QUOTE)}...` : waiver.message)}`,
            `**What to do:** ${waiver.action} Don't merge until they pass.`,
          ]
        : []),
      ...(waiver?.gate === 'removed-request-parameter'
        ? [
            '## Removed request parameters left for you',
            `**Don't merge until you change the calls below.** ${plainText(provider)} API ${code(waiver.targetVersion)} no longer accepts ${summaryList(parameters.map(code))}, and this patch still sends ${parameterCalls.length === 1 ? 'it' : 'them'}, so ${parameterCalls.length === 1 ? 'this request fails' : 'these requests fail'} after the upgrade. Refit didn't change ${parameterCalls.length === 1 ? 'it' : 'them'}: dropping or replacing a request parameter changes what the request does, so that's your decision.`,
            ...parameters.map(
              (parameter) =>
                REMOVED_PARAMETER_NOTES[parameter] ??
                `No reviewed replacement for ${code(parameter)} exists. Check the ${plainText(provider)} changelog for ${code(waiver.targetVersion)}, then remove or replace it.`,
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
      ...(waiver?.gate === 'webhook-api-version'
        ? [
            '## Webhook API version not verified',
            `This patch changes webhook handlers. Stripe sends webhooks in the API version set on the webhook endpoint in the Stripe dashboard, which Refit can't see from code. Before merging, check the endpoint's API version in Dashboard > Developers > Webhooks and confirm it matches ${code(waiver.targetVersion)}, or update it when you deploy.`,
            siteList(
              // One read can break more than one field change; list its site once.
              [
                ...new Set(
                  waiver.handlers.map(
                    (handler) =>
                      `${code(`${handler.file}:${handler.line}`)}${handler.eventTypes.length ? ` (${handler.eventTypes.map(code).join(', ')})` : ''}`,
                  ),
                ),
              ],
              Math.max(siteLimit, 1),
            ),
          ]
        : []),
      '## Overview',
      shopify
        ? overview
        : `${overview}${sources.length ? ` ${plainText(provider)} documents the change: ${sources.join(', ')}.` : ''}`,
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
        `- Test Suite Output: ${checks}${generatedResult}`,
        ...(legacyPeerDeps
          ? [
              "- Dependency Installation: `npm ci` rejected the committed lockfile's peer dependencies (ERESOLVE), so Refit installed the same lockfile with `--legacy-peer-deps`. Check that your own install uses the same setting.",
            ]
          : []),
        `- Linter & Static Analysis: ${typeChecked ? 'TypeScript type check is the test command above; ' : 'Not run; '}${shopify ? `Refit rescanned the migrated code and every runtime Admin API pin is on ${after}.` : `Refit rescanned the migrated code and ${unresolvedReads} confirmed usage${unresolvedReads === 1 ? '' : 's'} of the breaking changes remain${parameterCalls.length ? `, plus ${parameterCalls.length} call${parameterCalls.length === 1 ? '' : 's'} sending a removed request parameter` : ''}${untracedReads ? `, plus ${untracedReads} untraced read${untracedReads === 1 ? '' : 's'} of removed field names` : ''}.`}`,
        '- Security Scans: Not run.',
      ].join('\n'),
      ...(untracedSites.length
        ? [
            '## Left Unchanged',
            `Refit could not trace these reads of removed field names to a ${plainText(provider)} object, so it did not change them. Check each one: a read of a ${plainText(provider)} object here breaks after the upgrade.`,
            siteList(untracedSites, siteLimit),
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
      `<!-- refit-migration:${migrationIdentity(report, validation.revision, integration)} -->`,
      `<!-- refit-evidence "runId": "${report.runId}", "patchHash": "${validation.patchHash}" -->`,
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
    'report.json': `${JSON.stringify(waiver ? { ...report, waivedGates: [waiver] } : report, null, 2)}\n`,
    'migration.patch': patch.diff,
    'pull-request.md': body,
  };
  const manifest = {
    formatVersion: 1,
    kind: 'refit-review-bundle',
    ...(integration ? { integration } : {}),
    ...(waiver ? { waivedGates: [waiver.gate] } : {}),
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
