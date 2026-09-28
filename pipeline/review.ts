import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { validateMigration } from './validation.ts';

type ValidationReport = Awaited<ReturnType<typeof validateMigration>>;

function jsonBlock(value: unknown) {
  const content = JSON.stringify(value, null, 2);
  const runs = content.match(/`+/g) ?? [];
  const fence = '`'.repeat(runs.reduce((width, run) => Math.max(width, run.length + 1), 3));
  return `${fence}json\n${content}\n${fence}`;
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

  const title = `Migrate affected ${report.provider} API usage`;
  const summary =
    validation.status === 'passed'
      ? 'The configured baseline and patched checks passed. Human review of migration semantics is still required.'
      : `Validation did not pass (${validation.status}). Resolve the recorded failure or stale input before treating this migration as validated.`;
  const body =
    [
      `# ${title}`,
      'The supplied API specifications remove fields read by the scanned code under the recorded SDK mapping.',
      destination === 'local'
        ? 'Inspect migration.patch for the exact proposed changes.'
        : 'Inspect the Files changed tab for the exact proposed changes.',
      jsonBlock({ generator: patch.generator, summary: patch.summary }),
      summary,
      `Proposed edits: ${patch.edits}. Unresolved detected findings: ${patch.unresolvedFindings}. Zero unresolved findings does not prove complete API or code coverage.`,
      '## Validation',
      jsonBlock({
        status: validation.status,
        revision: validation.revision,
        image: validation.image,
        command: validation.command,
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
      '## Evidence',
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
      '## AI assessment (advisory)',
      jsonBlock(report.assessment),
      '## Review requirements',
      'Confirm adapter mappings, API-version applicability and intended pagination, expansion, timing and error behavior. Review any added network requests, and inspect the diff and logs for sensitive content before sharing.',
      jsonBlock({ warnings: [...report.warnings, ...patch.warnings], coverage: report.coverage }),
      destination === 'local'
        ? 'This is a local review artifact. Refit has not pushed a branch, opened a pull request, or approved publication.'
        : 'Refit created this draft for human review. Passing checks do not prove migration correctness.',
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
