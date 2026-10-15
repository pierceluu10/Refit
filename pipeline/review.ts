import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import { digest, type AddedProperty } from './specifications.ts';
import { affectedFields } from './report-fields.ts';
import { PipelineInputError } from './types.ts';
import type { validateMigration } from './validation.ts';
import { INTEGRATION_MARKER, migrationIdentity } from './migration-identity.ts';

type ValidationReport = Awaited<ReturnType<typeof validateMigration>>;
const MAX_SUMMARY_ITEMS = 5;
// Longer diffs stay readable in the Files changed tab and migration.patch.
const MAX_VISIBLE_DIFF_LINES = 80;
const MAX_QUOTE = 300;

function jsonBlock(value: unknown) {
  const content = JSON.stringify(value, null, 2);
  const runs = content.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((width, run) => Math.max(width, run.length + 1), 3));
  return `${fence}json\n${content}\n${fence}`;
}

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

function apiVersionSummary(report: ValidationReport) {
  const { application, before, after, applicability } = report.apiVersion;
  const current = plainText(application ?? 'unknown');
  const baseline = plainText(before ?? 'unknown');
  const proposed = plainText(after ?? 'unknown');
  if (applicability === 'matches-before')
    return `Application pin ${current} matches the before contract ${baseline}; proposed contract ${proposed}.`;
  if (applicability === 'matches-after')
    return `Application pin ${current} already matches the after contract ${proposed}, not the before contract ${baseline}.`;
  if (applicability === 'matches-neither')
    return `Application pin ${current} matches neither the before contract ${baseline} nor the after contract ${proposed}.`;
  if (applicability === 'conflicts-with-code' || report.apiVersion.policy === 'source-verified')
    return plainText(report.apiVersion.reason);
  return `Applicability is unknown; current pin ${current}, before contract ${baseline}, after contract ${proposed}.`;
}

function fenced(language: string, content: string) {
  const runs = content.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((width, run) => Math.max(width, run.length + 1), 3));
  return `${fence}${language}\n${content}\n${fence}`;
}

function quote(value: string) {
  const text = value.replace(/\s+/g, ' ').trim();
  return `> ${plainText(text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text)}`;
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
  const rows: string[] = [];
  const reasons: string[] = [];
  const checks: string[] = [];
  const replacements: string[] = [];
  for (const change of affectedFields(report.changes, report.findings)) {
    const removed = `${change.schema}.${change.property}`;
    const where = report.specificationDiff?.changes.find(
      (entry) =>
        'removedProperty' in entry &&
        entry.removedProperty === change.property &&
        entry.responseSchema === change.schema,
    );
    const location =
      where && 'path' in where && where.path
        ? `${code(`${where.operation ?? ''} ${where.path}`.trim())} response`
        : 'response';
    rows.push(`| Removed | ${code(removed)} | ${plainText(change.type ?? '—')} | ${location} |`);
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
    rows.push(
      `| Added | ${code(used)} | ${plainText(candidate?.type ?? change.type ?? '—')} | same response |`,
    );
    if (rename) {
      reasons.push(
        `**Why ${code(replacement)}:** an operator-configured ${replacement.includes('.') ? 'move' : 'rename'} rule in the provider adapter maps ${code(removed)} to ${code(used)}.`,
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
        `**Why ${code(replacement)}:** the after contract documents it as the replacement:`,
        quote(described),
      );
    else if (note) {
      const sentence =
        note.content
          .split(/(?<=[.!?])\s+|\n+/)
          .find((part) => part.includes(change.property) && part.includes(replacement)) ??
        note.content;
      reasons.push(
        `**Why ${code(replacement)}:** the attached vendor note (${plainText(note.label)}, ${plainText(note.url)}) says:`,
        quote(sentence),
      );
    } else {
      const sameType = candidate?.type && change.type && candidate.type === change.type;
      reasons.push(
        `**Why ${code(replacement)}:** it was added to the same response${sameType ? ` with the same type (${plainText(change.type!)})` : ''}. ⚠️ The contract does not document it as a replacement and no vendor note was attached, so **confirm it carries the same meaning**.`,
      );
      checks.push(
        `- [ ] ${code(replacement)} carries the same meaning as ${code(change.property)} for your use`,
      );
    }
  }
  return { rows, reasons, checks, replacements };
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
    [validation.baseline, validation.patched].some(
      (check) => check.status !== 'passed' || check.exitCode !== 0,
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
  const changedFiles = [...new Set(report.publicationFiles.map((file) => file.path))];
  const changedFilesSummary = changedFiles.length
    ? summaryList(changedFiles.map(code))
    : 'See the Files changed tab for the proposed edits.';
  const { rows, reasons, checks, replacements } = replacementReasons(report);
  const usageCount = `${confirmedFindings.length} confirmed ${confirmedFindings.length === 1 ? 'usage' : 'usages'}`;
  const fileCount = `${affectedFiles.size} ${affectedFiles.size === 1 ? 'file' : 'files'}`;
  const after = plainText(report.apiVersion.after ?? 'the after contract');
  const passed = validation.status === 'passed';
  const short = (hash: string) => code(`${hash.slice(0, 12)}…`);
  const source = (side: 'before' | 'after') => {
    const provenance = report.provenance?.[side] as { url?: unknown } | null | undefined;
    return typeof provenance?.url === 'string' ? ` from ${plainText(provenance.url)}` : '';
  };
  const commandText = (value: readonly string[]) => code(value.join(' '));
  const ai = patch.generator === 'openai';
  const model = 'model' in patch && typeof patch.model === 'string' ? patch.model : undefined;
  const stripeReview =
    report.provider === 'stripe' || operationChanges.length > 0 || requestChanges.length > 0;
  const body =
    [
      '## Summary',
      ...(integration
        ? [`**Integration:** ${code(integration)}. This draft covers this integration only.`]
        : []),
      `The ${plainText(provider)} API contract ${report.apiVersion.after ? `${after} ` : ''}removes ${changeSummary}. Refit updated ${usageCount} across ${fileCount}${replacements.length ? ` (${summaryList(replacements)})` : ''}: ${changedFilesSummary}.`,
      passed
        ? 'Your configured checks passed on the original and the migrated code. Human review of migration semantics is still required.'
        : `**Validation did not pass (${validation.status}).** Resolve the recorded failure or stale input before treating this migration as validated.`,
      '## Why: the provider change',
      ...(rows.length
        ? [['| | Field | Type | Where |', '|---|---|---|---|', ...rows].join('\n')]
        : []),
      ...reasons,
      ...(subscriptionPolicy
        ? [
            `**Subscription item policy:** select exactly one item whose price ID is ${code(subscriptionPolicy.priceId)}. Item order does not determine entitlement. Missing or duplicate matches and incomplete lists use the existing missing-period error.`,
            `**Incoming event versions:** the patch checks signed ${code('event.api_version')} at runtime. ${code(subscriptionPolicy.beforeApiVersion)} retains legacy subscription periods; ${code(subscriptionPolicy.afterApiVersion)} reads the matched item's periods. Other versions are rejected. The outgoing SDK version does not establish the incoming version.`,
          ]
        : []),
      ...(requestChanges.length
        ? [
            `**Request fields:** ${summaryList(requestChanges.map((entry) => `${code(`${entry.resource}.${entry.method}`)} argument ${entry.argumentIndex}: ${code(entry.removed)} → ${code(entry.replacement)} (${code(`${entry.httpMethod} ${entry.path}`)})`))}. Argument values and other call options are preserved; review SDK serialization and business meaning.`,
          ]
        : []),
      ...(operationChanges.length
        ? [
            `**Configured replacements:** ${summaryList(operationChanges.map((entry) => `${code(`${entry.resource}.${entry.method}`)} → ${code(`${entry.replacementResource}.${entry.replacementMethod}`)} (${code(`${entry.httpMethod} ${entry.replacementPath}`)})`))}. Refit preserves the call arguments; review the SDK mapping and business meaning.`,
          ]
        : []),
      `**Contracts:** before ${short(report.snapshots.before)}${source('before')}, after ${short(report.snapshots.after)}${source('after')}.`,
      `**API version:** ${apiVersionSummary(report)}`,
      `**SDK version declarations:** ${plainText(report.apiVersion.source.reason)} Policy: ${code(report.apiVersion.policy)}.`,
      '## What changed',
      ...changeSections(patch.diff),
      '## Validation',
      [
        '| Check | Code | Command | Result |',
        '|---|---|---|---|',
        `| Baseline | original | ${commandText(validation.baselineCommand)} | ${validation.baseline.status === 'passed' ? '✅' : '❌'} ${validation.baseline.status} |`,
        `| Migration | patched | ${commandText(validation.command)} | ${validation.patched.status === 'passed' ? '✅' : '❌'} ${validation.patched.status} |`,
        ...(validation.generated
          ? [
              `| Generated, ${report.apiVersion.before} mock | original | ${validation.generated.entryPoints.length} exported functions | ${validation.generated.baseline.status === 'passed' ? '✅' : '❌'} ${validation.generated.baseline.status} |`,
              `| Generated, ${report.apiVersion.after} mock | patched | ${validation.generated.entryPoints.length} exported functions | ${validation.generated.patched.status === 'passed' ? '✅' : '❌'} ${validation.generated.patched.status} |`,
            ]
          : []),
      ].join('\n'),
      ...(validation.generated
        ? [
            `Generated checks called ${summaryList(validation.generated.entryPoints.map((entry) => code(`${entry.file}#${entry.name}`)))} with placeholder IDs against stripe-mock serving each version's published contract and fixtures, offline. ${validation.generated.notRunnable.length} could not run in isolation on the original code and were excluded; ${validation.generated.regressions.length} that ran on the original failed after the migration. ${validation.generated.uncoveredFindings} confirmed usages were not inside a callable exported function. Placeholder data checks response shapes, not business behavior.`,
          ]
        : []),
      `Both checks ran in restricted Docker containers with external networking disabled (image ${short(validation.image.replace(/^sha256:/, ''))}); these are not GitHub Actions checks. Patch attempts: **${validation.attempts.length}**; AI repairs: **${validation.repair.requested}**; remaining reads of removed fields: **${patch.unresolvedFindings}**.`,
      passed
        ? '**This shows** the migrated code passes your configured checks. **It does not show** that replacement fields carry the same meaning or that the checks cover every code path.'
        : 'Inspect the failing check output in the local validation report before changing the patch.',
      '## How this patch was made',
      ai
        ? `Proposed by AI${model ? ` (${code(model)})` : ''}, then checked by Refit before validation: edits are limited to confirmed usages, no pre-existing response field was substituted for a removed one, and the patched code was rescanned.`
        : 'Generated by a deterministic Refit migration rule; no AI was used.',
      `${ai ? "**Model's note:**" : '**Rule:**'} ${plainText(patch.summary)}`,
      '## Before merging',
      [
        ...checks,
        `- [ ] Your application will run against API version ${after}`,
        ...(stripeReview
          ? ['- [ ] Review added requests, pagination, empty-state behavior and error handling']
          : []),
        '- [ ] The checks above exercise the code paths you rely on',
      ].join('\n'),
      destination === 'local'
        ? 'Inspect migration.patch. This is a local review artifact; Refit has not pushed a branch or opened a pull request.'
        : 'Inspect Files changed. Refit opens a draft for review and never merges it automatically.',
      '<details>\n<summary>Technical evidence and exact check commands</summary>\n',
      jsonBlock({
        status: validation.status,
        revision: validation.revision,
        image: validation.image,
        ...(validation.environment ? { environment: validation.environment } : {}),
        command: validation.command,
        baselineCommand: validation.baselineCommand,
        baseline: { status: validation.baseline.status, exitCode: validation.baseline.exitCode },
        patched: { status: validation.patched.status, exitCode: validation.patched.exitCode },
        repair: validation.repair,
        attempts: validation.attempts.map((attempt) => ({
          number: attempt.number,
          patchHash: attempt.patchHash,
          status: attempt.check.status,
          exitCode: attempt.check.exitCode,
          responseId: attempt.responseId,
        })),
      }),
      destination === 'local'
        ? 'Full stdout, stderr and execution errors are preserved in report.json. The exact proposed change is in migration.patch.'
        : 'Full check logs remain in the local validation report; they are not uploaded to GitHub.',
      '### Recorded inputs',
      jsonBlock(
        report.specificationDiff ?? {
          engine: 'direct-properties',
          changes: report.changes,
          coverage: report.coverage.specification,
        },
      ),
      jsonBlock({
        runId: report.runId,
        snapshots: report.snapshots,
        provenance: report.provenance,
        archiveHash: validation.archiveHash,
        patchHash: validation.patchHash,
        dependencies: report.repository.dependencies,
        lockfiles: report.repository.lockfiles,
        findings: report.findings,
        ...(operationChanges.length ? { operationChanges } : {}),
        ...(requestChanges.length ? { requestChanges } : {}),
      }),
      ...(report.assessment.status === 'not-requested'
        ? []
        : ['### Advisory AI assessment', jsonBlock(report.assessment)]),
      jsonBlock({ warnings: [...report.warnings, ...patch.warnings], coverage: report.coverage }),
      '\n</details>',
      ...(integration ? [`${INTEGRATION_MARKER}${integration} -->`] : []),
      `<!-- refit-migration:${migrationIdentity(report, validation.revision, integration)} -->`,
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
