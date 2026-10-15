import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import { digest, type AddedProperty } from './specifications.ts';
import { affectedFields } from './report-fields.ts';
import { PipelineInputError, type Finding } from './types.ts';
import type { validateMigration } from './validation.ts';
import { INTEGRATION_MARKER, migrationIdentity } from './migration-identity.ts';

type ValidationReport = Awaited<ReturnType<typeof validateMigration>>;
const MAX_SUMMARY_ITEMS = 5;
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
        `${code(replacement)} was added to the same response${sameType ? ` with the same type (${plainText(change.type!)})` : ''}. ⚠️ Nothing documents it as the replacement for ${code(change.property)}, so **confirm it carries the same meaning**.`,
      );
    }
  }
  return { reasons, replacements };
}

export function createReviewArtifacts(
  report: ValidationReport,
  destination: 'local' | 'github' = 'local',
  integration?: string,
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
        : report.provider;
  const relevantChanges = affectedFields(report.changes, report.findings);
  const change = relevantChanges[0];
  const operationChanges = report.operationChanges ?? [];
  const endpoint = operationChanges[0];
  const requestChanges = report.requestChanges ?? [];
  const request = requestChanges[0];
  const subscriptionPolicy = report.findings.some((finding) => finding.webhook?.migration)
    ? report.adapter.stripeSubscriptionPeriods
    : undefined;
  const migrationTitle = subscriptionPolicy
    ? 'Preserve Stripe subscription periods after item-level billing change'
    : request &&
        requestChanges.length === 1 &&
        !operationChanges.length &&
        relevantChanges.length === 1
      ? `Update ${provider} ${request.resource}.${request.method} requests after ${request.removed} removal`
      : endpoint && operationChanges.length === 1 && !relevantChanges.length
        ? `Replace retired ${provider} ${endpoint.resource}.${endpoint.method} calls`
        : change && relevantChanges.length === 1
          ? provider === 'Stripe' &&
            change.schema === 'payment_intent' &&
            change.property === 'charges'
            ? 'Fix Stripe payment history after PaymentIntent.charges removal'
            : `Fix ${provider} usage after ${change.schema}.${change.property} removal`
          : `Migrate affected ${provider} API usage`;
  const title = integration ? `[${plainText(integration)}] ${migrationTitle}` : migrationTitle;
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
  // One paragraph: what changed and why, the evidence and its limits, and what was left alone.
  const line = (label: string, parts: string[]) =>
    parts.length ? [`- **${label}:** ${parts.join(' ')}`] : [];
  const checkCommand = sameCommand
    ? `${commandText(validation.command)} passed on the original and migrated code`
    : `${commandText(validation.baselineCommand)} passed on the original, ${commandText(validation.command)} on the migrated code`;
  // Short labeled lines: what changed, why, the evidence and its limits, and what was left alone.
  const summary = [
    ...line('What', [
      `${ai ? `AI${model ? ` (${code(model)})` : ''}, checked by Refit,` : 'A deterministic Refit rule (no AI)'} updated ${usageCount} in ${fileCount}${replacements.length ? `: ${summaryList(replacements)}` : ''}.`,
      ...(integration ? [`Covers the ${code(integration)} integration only.`] : []),
    ]),
    ...line('Why', [
      `${plainText(provider)} API ${report.apiVersion.after ? `${after} ` : ''}removes ${changeSummary}.`,
      ...reasons,
    ]),
    ...line('How', [
      ...(subscriptionPolicy
        ? [
            `Subscription periods come from the one item priced ${code(subscriptionPolicy.priceId)}, by the signed event's ${code('api_version')}.`,
          ]
        : []),
      ...(selectedPeriods.length
        ? [
            `Items on different billing periods use the item the code already picks: ${summaryList([...new Set(selectedPeriods.map((finding) => code(finding.subscriptionPeriod!.selection ?? '')))])}.`,
          ]
        : []),
      ...(requestChanges.length
        ? [
            `Request fields: ${summaryList(requestChanges.map((entry) => `${code(`${entry.resource}.${entry.method}`)} ${code(entry.removed)} → ${code(entry.replacement)}`))}.`,
          ]
        : []),
      ...(operationChanges.length
        ? [
            `Calls: ${summaryList(operationChanges.map((entry) => `${code(`${entry.resource}.${entry.method}`)} → ${code(`${entry.replacementResource}.${entry.replacementMethod}`)}`))}.`,
          ]
        : []),
    ]),
    ...line(
      'Evidence',
      passed
        ? [
            `✅ ${checkCommand} (offline Docker).${generated ? (generated.patched.status === 'not-run' ? ' ➖ Generated stripe-mock checks did not run.' : ` ${generated.patched.status === 'passed' ? '✅' : '❌'} Generated stripe-mock checks ${generated.patched.status} on ${generated.entryPoints.length} exported functions.`) : ''} Not proof the new fields mean the same for your app or that every path is covered.`,
          ]
        : [`❌ **Validation did not pass (${validation.status}).**`],
    ),
    ...line('Please check', [
      ...(unconfirmed.length
        ? [
            `${unconfirmed.length} read${unconfirmed.length === 1 ? '' : 's'} of removed field names Refit could not trace to a Stripe object, left unchanged: ${summaryList([...new Set(unconfirmed.map((finding) => code(`${finding.file}:${finding.line}`)))])}.`,
          ]
        : []),
      ...(flaggedPeriods.length
        ? [
            `Subscriptions with items on different billing periods are not handled. Set ${code('stripeSubscriptionPeriods')} to choose which item counts: ${summaryList(flaggedPeriods.map((finding) => code(`${finding.file}:${finding.line}`)))}.`,
          ]
        : []),
    ]),
    ...(destination === 'local' ? ['Refit has not pushed a branch or opened a pull request.'] : []),
  ].join('\n');
  const body =
    [
      summary,
      '#### Changes',
      ...changeSections(patch.diff),
      ...(integration ? [`${INTEGRATION_MARKER}${integration} -->`] : []),
      `<!-- refit-migration:${migrationIdentity(report, validation.revision, integration)} -->`,
      `<!-- refit-evidence "runId": "${report.runId}", "patchHash": "${validation.patchHash}" -->`,
    ].join('\n\n') + '\n';
  const files = {
    'report.json': `${JSON.stringify(report, null, 2)}\n`,
    'migration.patch': patch.diff,
    'pull-request.md': body,
  };
  const manifest = {
    formatVersion: 1,
    kind: 'refit-review-bundle',
    ...(integration ? { integration } : {}),
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
