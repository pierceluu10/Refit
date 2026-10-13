import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, parseObject } from './specifications.ts';
import type { runWorkflow } from './workflow.ts';

type Result = Awaited<ReturnType<typeof runWorkflow>>;

const TITLES: Record<Result['manifest']['status'], string> = {
  'needs-review': 'Refit needs review',
  'validation-failed': 'Migration validation failed',
  validated: 'Migration validated',
  'draft-created': 'Draft PR ready',
  'existing-pr': 'Existing PR found',
  error: 'Refit could not complete this run',
};

function terminalText(value: string) {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ');
}

export async function renderWorkflowResult(result: Result) {
  const readArtifact = async (name: string) =>
    result.manifest.files.some((file) => file.path === name)
      ? parseObject(await readFile(join(result.directory, name), 'utf8'), name)
      : undefined;
  const report = (await readArtifact('report.json')) ?? (await readArtifact('scan.json'));
  const publication = await readArtifact('publication.json');
  const rows: string[] = [];
  if (report && Array.isArray(report.findings)) {
    const confirmed = report.findings.filter(
      (finding) => isObject(finding) && finding.confidence === 'confirmed',
    );
    const files = new Set(confirmed.map((finding) => (finding as Record<string, unknown>).file));
    rows.push(`Found       ${confirmed.length} confirmed usages in ${files.size} files`);
  }
  if (report && isObject(report.patch) && typeof report.patch.generator === 'string')
    rows.push(`Generated   ${terminalText(report.patch.generator)} migration`);
  if (report && isObject(report.patch) && isObject(report.patch.usage)) {
    const usage = report.patch.usage;
    rows.push(
      `AI tokens   Latest proposal: ${usage.inputTokens} input; ${usage.outputTokens} output; ${usage.cachedInputTokens} cached`,
    );
    if (isObject(report.patch.budget))
      rows.push(
        `AI budget   $${Number(report.patch.budget.spentUsd).toFixed(4)} recorded / $${Number(report.patch.budget.limitUsd).toFixed(2)} limit`,
      );
  }
  if (report && isObject(report.validation)) {
    const validation = report.validation;
    if (isObject(validation.baseline) && isObject(validation.patched))
      rows.push(
        `Checks      Original: ${validation.baseline.status}; proposed: ${validation.patched.status}`,
      );
    if (Array.isArray(validation.attempts) && isObject(validation.repair))
      rows.push(
        `Attempts    ${validation.attempts.length} tested; ${validation.repair.requested} AI repairs`,
      );
  }
  if (publication && typeof publication.url === 'string') {
    const publisher = isObject(publication.publisher)
      ? publication.publisher.login
      : 'configured GitHub account';
    rows.push(`Published   ${terminalText(String(publisher))}`);
    rows.push(`PR          ${terminalText(publication.url)}`);
  }
  return [
    TITLES[result.manifest.status],
    '',
    ...rows,
    `Evidence    ${terminalText(result.directory)}`,
    '',
    terminalText(result.manifest.reason),
    ...(result.manifest.error ? [terminalText(result.manifest.error.message)] : []),
  ].join('\n');
}
