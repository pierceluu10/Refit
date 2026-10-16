import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import { digest, type AddedProperty } from './specifications.ts';
import { affectedFields } from './report-fields.ts';
import { PipelineInputError, type Finding } from './types.ts';
import type { validateMigration } from './validation.ts';
import { INTEGRATION_MARKER, migrationIdentity } from './migration-identity.ts';
import type { webhookVersionWaiver } from './publication.ts';

type WebhookVersionWaiver = NonNullable<ReturnType<typeof webhookVersionWaiver>>;

type ValidationReport = Awaited<ReturnType<typeof validateMigration>>;
const MAX_SUMMARY_ITEMS = 5;
// Conventional Commits title limit from the PR template.
const MAX_TITLE = 70;
// Longer diffs stay readable in the Files changed tab and migration.patch.
const MAX_VISIBLE_DIFF_LINES = 80;
const MAX_QUOTE = 300;

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

function changeSections(diff: string) {
  const sections: string[] = [];
  let shown = 0;
  let hidden = 0;
  for (const file of fileChanges(diff)) {
    if (!file.before) {
      sections.push(`New file ${code(file.path)}; see Files changed.`);
      continue;
    }
    const afterLines = file.after.split('\n');
    for (const hunk of structuredPatch(file.path, file.path, file.before, file.after, '', '', {
      context: 2,
    }).hunks) {
      if (shown + hunk.lines.length > MAX_VISIBLE_DIFF_LINES) {
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
  if (hidden)
    sections.push(
      `${hidden} more ${hidden === 1 ? 'change is' : 'changes are'} not shown here; see Files changed or migration.patch.`,
    );
  return sections;
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
  webhookWaiver?: WebhookVersionWaiver,
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
  const relevantChanges = affectedFields(report.changes, report.findings);
  const change = relevantChanges[0];
  const operationChanges = report.operationChanges ?? [];
  const endpoint = operationChanges[0];
  const requestChanges = report.requestChanges ?? [];
  // A removed payment_method_types finding with no remaining stop was migrated by the card-only rule.
  const cardRename = report.findings.some(
    (finding) =>
      finding.changeId.endsWith('.payment_method_types') &&
      finding.changeId.startsWith('request-parameter:') &&
      !finding.requestParameter,
  );
  const request = requestChanges[0];
  const subscriptionPolicy = report.findings.some((finding) => finding.webhook?.migration)
    ? report.adapter.stripeSubscriptionPeriods
    : undefined;
  const description = subscriptionPolicy
    ? 'preserve subscription periods after item-level billing'
    : request &&
        requestChanges.length === 1 &&
        !operationChanges.length &&
        relevantChanges.length === 1
      ? `update ${request.resource}.${request.method} after ${request.removed} removal`
      : endpoint && operationChanges.length === 1 && !relevantChanges.length
        ? `replace retired ${endpoint.resource}.${endpoint.method} calls`
        : change && relevantChanges.length === 1
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
  const needsReview = Boolean(webhookWaiver || patch.unresolvedFindings);
  const prefix = needsReview ? '[Needs review] ' : '';
  const full = `${prefix}fix(${scope}): ${versionTitle ?? description}`;
  const title =
    full.length <= MAX_TITLE
      ? full
      : `${prefix}fix(${scope}): migrate removed API fields`.slice(0, MAX_TITLE);
  const confirmedFindings = report.findings.filter((finding) => finding.confidence === 'confirmed');
  const affectedFiles = new Set(confirmedFindings.map((finding) => finding.file));
  const changes = summaryList([
    ...relevantChanges.map((entry) => code(`${entry.schema}.${entry.property}`)),
    ...operationChanges.map((entry) => code(`${entry.httpMethod} ${entry.path}`)),
  ]);
  const changeSummary = changes || 'the API usages recorded in the technical evidence';
  const { reasons, replacements } = replacementReasons(report);
  const usageCount = `${confirmedFindings.length} confirmed ${confirmedFindings.length === 1 ? 'usage' : 'usages'}`;
  const fileCount = `${affectedFiles.size} ${affectedFiles.size === 1 ? 'file' : 'files'}`;
  const after = plainText(report.apiVersion.after ?? 'the after contract');
  const passed = validation.status === 'passed';
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
        .map((finding) => {
          const entry = report.changes.find((candidate) => candidate.id === finding.changeId);
          return code(entry ? `${entry.schema}.${entry.property}` : finding.expression);
        }),
    ),
  ];
  const keyChanges = fileChanges(patch.diff).map((file) => {
    const fields = migratedFields(file.path);
    const what = shopify
      ? `Moves the pinned Admin API version to ${plainText(after)}.`
      : !file.before
        ? 'Adds the generated helper that reads the removed fields under either API version.'
        : fields.length
          ? `Migrates reads of ${summaryList(fields)} to the documented new locations.`
          : `Updates ${plainText(provider)} API usage for the new contract.`;
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
        `Removes response fields ${changeSummary} in ${plainText(provider)} API ${after}.`,
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
        ...operationChanges.map(
          (entry) =>
            `Retires ${code(`${entry.resource}.${entry.method}`)} in favor of ${code(`${entry.replacementResource}.${entry.replacementMethod}`)}.`,
        ),
      ];
  const review = [
    ...(shopify?.deprecated ?? []).map(
      (entry) =>
        `Deprecated on ${after}, still served: ${code(entry.split(':')[0])}${plainText(entry.slice(entry.indexOf(':')))}`,
    ),
    ...(patch.unresolvedFindings
      ? [
          `**${patch.unresolvedFindings} confirmed read${patch.unresolvedFindings === 1 ? '' : 's'} of removed fields ${patch.unresolvedFindings === 1 ? 'is' : 'are'} still unmigrated.** The checks passed without ${patch.unresolvedFindings === 1 ? 'it' : 'them'}; migrate ${patch.unresolvedFindings === 1 ? 'it' : 'them'} before merging, using the locations in Refit's run report.`,
        ]
      : []),
    ...reasons,
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
          `Leaves ${unconfirmed.length} untraced read${unconfirmed.length === 1 ? '' : 's'} of removed field names unchanged for manual review: ${summaryList([...new Set(unconfirmed.map((finding) => code(`${finding.file}:${finding.line}`)))])}.`,
        ]
      : []),
  ];
  const generatedResult = generated
    ? generated.patched.status === 'not-run'
      ? ' Generated stripe-mock checks did not run.'
      : ` Generated stripe-mock checks ${generated.patched.status} on ${generated.entryPoints.length} exported functions.`
    : '';
  const body =
    [
      ...(webhookWaiver
        ? [
            '## Webhook API version not verified',
            `This patch changes webhook handlers. Stripe sends webhooks in the API version set on the webhook endpoint in the Stripe dashboard, which Refit can't see from code. Before merging, check the endpoint's API version in Dashboard > Developers > Webhooks and confirm it matches ${code(webhookWaiver.targetVersion)}, or update it when you deploy.`,
            webhookWaiver.handlers
              .map(
                (handler) =>
                  `- ${code(`${handler.file}:${handler.line}`)}${handler.eventTypes.length ? ` (${handler.eventTypes.map(code).join(', ')})` : ''}`,
              )
              .join('\n'),
          ]
        : []),
      '## Overview',
      shopify
        ? `This app pins Shopify Admin API ${plainText(report.apiVersion.application ?? 'an older version')}. A deterministic Refit rule moves it to ${after} after checking every traced GraphQL document against the ${after} schema.`
        : `${plainText(provider)} API ${after} removes fields this code reads. ${ai ? `AI${model ? ` (${code(model)})` : ''}, checked by Refit,` : 'A deterministic Refit rule'} migrates ${usageCount} in ${fileCount} so the code keeps working after the upgrade.`,
      '## API Impact & Spec Changes',
      [
        `- Breaking Changes: ${breaking.join(' ')}`,
        '- Database Migrations: None.',
        '- Environment Variables: None.',
      ].join('\n'),
      '## Key Changes',
      [...keyChanges, ...review.map((entry) => `- Review: ${entry}`)].join('\n'),
      '## Code Changes',
      ...changeSections(patch.diff),
      '## Automated Verification Gates',
      [
        `- Test Suite Output: ${
          passed
            ? sameCommand
              ? `${commandText(validation.command)} passed on the original and migrated code in offline Docker.`
              : `${commandText(validation.baselineCommand)} passed on the original and ${commandText(validation.command)} on the migrated code in offline Docker.`
            : `**Validation did not pass (${validation.status}).**`
        }${generatedResult}`,
        `- Linter & Static Analysis: ${typeChecked ? 'TypeScript type check is the test command above; ' : 'Not run; '}${shopify ? `Refit rescanned the migrated code and every runtime Admin API pin is on ${after}.` : `Refit rescanned the migrated code and ${patch.unresolvedFindings} confirmed read${patch.unresolvedFindings === 1 ? '' : 's'} of removed fields remain.`}`,
        '- Security Scans: Not run.',
      ].join('\n'),
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
  const files = {
    'report.json': `${JSON.stringify(webhookWaiver ? { ...report, waivedGates: [webhookWaiver] } : report, null, 2)}\n`,
    'migration.patch': patch.diff,
    'pull-request.md': body,
  };
  const manifest = {
    formatVersion: 1,
    kind: 'refit-review-bundle',
    ...(integration ? { integration } : {}),
    ...(webhookWaiver ? { waivedGates: [webhookWaiver.gate] } : {}),
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
  return { files, manifest };
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
