import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { validateMigration } from './validation.ts';
import { migrationIdentity } from './migration-identity.ts';

type ValidationReport = Awaited<ReturnType<typeof validateMigration>>;
const MAX_SUMMARY_ITEMS = 5;

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
  return `Applicability is unknown; current pin ${current}, before contract ${baseline}, after contract ${proposed}.`;
}

export function createReviewArtifacts(
  report: ValidationReport,
  destination: 'local' | 'github' = 'local',
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
    report.provider === 'stripe'
      ? 'Stripe'
      : report.provider === 'openai'
        ? 'OpenAI'
        : report.provider;
  const change = report.changes[0];
  const title =
    change && report.changes.length === 1
      ? provider === 'Stripe' && change.schema === 'payment_intent' && change.property === 'charges'
        ? 'Fix Stripe payment history after PaymentIntent.charges removal'
        : `Fix ${provider} usage after ${change.schema}.${change.property} removal`
      : `Migrate affected ${provider} API usage`;
  const confirmedFindings = report.findings.filter((finding) => finding.confidence === 'confirmed');
  const affectedFiles = new Set(confirmedFindings.map((finding) => finding.file));
  const changes = summaryList(
    report.changes.map((entry) => code(`${entry.schema}.${entry.property}`)),
  );
  const changeSummary = changes || 'the API fields recorded in the technical evidence';
  const changedFiles = [...new Set(report.publicationFiles.map((file) => file.path))];
  const changedFilesSummary = changedFiles.length
    ? summaryList(changedFiles.map(code))
    : 'See the Files changed tab for the proposed edits.';
  const summary =
    validation.status === 'passed'
      ? 'The configured baseline and patched checks passed. Human review of migration semantics is still required.'
      : `Validation did not pass (${validation.status}). Resolve the recorded failure or stale input before treating this migration as validated.`;
  const body =
    [
      '## What changed',
      `The supplied ${plainText(provider)} API contract removes ${changeSummary}. Refit found ${confirmedFindings.length} confirmed ${confirmedFindings.length === 1 ? 'usage' : 'usages'} across ${affectedFiles.size} ${affectedFiles.size === 1 ? 'file' : 'files'}.`,
      `**API version:** ${apiVersionSummary(report)}`,
      `**${patch.generator === 'openai' ? 'AI proposal' : 'Migration'}:** ${plainText(patch.summary)}`,
      `**Files changed:** ${changedFilesSummary}`,
      '## Checks',
      `- Baseline: **${validation.baseline.status}**\n- Proposed changes: **${validation.patched.status}**\n- Patch attempts: **${validation.attempts.length}**; AI repairs: **${validation.repair.requested}**\n- Remaining findings: **${patch.unresolvedFindings}**`,
      summary,
      `Baseline and patched application checks ran locally in restricted Docker containers with external networking disabled; these are not GitHub Actions checks. ${patch.generator === 'openai' ? 'Refit used AI to propose the patch.' : 'Refit used a deterministic migration rule.'}`,
      '## Review before merging',
      'Confirm the intended API version, then review added requests, pagination, empty-state behavior and error handling. Passing these checks does not establish complete API or code coverage.',
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
      }),
      ...(report.assessment.status === 'not-requested'
        ? []
        : ['### Advisory AI assessment', jsonBlock(report.assessment)]),
      jsonBlock({ warnings: [...report.warnings, ...patch.warnings], coverage: report.coverage }),
      '\n</details>',
      `<!-- refit-migration:${migrationIdentity(report, validation.revision)} -->`,
    ].join('\n\n') + '\n';
  const files = {
    'report.json': `${JSON.stringify(report, null, 2)}\n`,
    'migration.patch': patch.diff,
    'pull-request.md': body,
  };
  const manifest = {
    formatVersion: 1,
    kind: 'refit-review-bundle',
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
