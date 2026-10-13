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
const MAX_SUMMARY_ITEMS = 3;
const MAX_PROPOSAL_CHARACTERS = 180;

export function terminalText(value: string) {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ');
}

function summaryList(values: string[]) {
  const visible = values.slice(0, MAX_SUMMARY_ITEMS);
  const remaining = values.length - visible.length;
  return `${visible.join(', ')}${remaining ? `, and ${remaining} more` : ''}`;
}

function proposalText(value: string) {
  const text = terminalText(value);
  return text.length > MAX_PROPOSAL_CHARACTERS
    ? `${text.slice(0, MAX_PROPOSAL_CHARACTERS - 1)}…`
    : text;
}

export async function renderWorkflowResult(result: Result) {
  const readArtifact = async (name: string) =>
    result.manifest.files.some((file) => file.path === name)
      ? parseObject(await readFile(join(result.directory, name), 'utf8'), name)
      : undefined;
  const report = (await readArtifact('report.json')) ?? (await readArtifact('scan.json'));
  const publication = await readArtifact('publication.json');
  const rows: string[] = [];
  if (report && typeof report.provider === 'string' && Array.isArray(report.changes)) {
    const changes = report.changes
      .filter(
        (change): change is Record<string, unknown> =>
          isObject(change) &&
          typeof change.schema === 'string' &&
          typeof change.property === 'string',
      )
      .map((change) => terminalText(`${change.schema}.${change.property}`));
    if (changes.length) {
      const provider =
        report.provider === 'stripe'
          ? 'Stripe'
          : report.provider === 'openai'
            ? 'OpenAI'
            : terminalText(report.provider);
      rows.push(`API change  ${provider} removes ${summaryList(changes)}`);
    }
  }
  if (report && isObject(report.apiVersion)) {
    const version = report.apiVersion;
    const application = typeof version.application === 'string' ? version.application : 'unknown';
    const before = typeof version.before === 'string' ? version.before : 'unknown';
    const after = typeof version.after === 'string' ? version.after : 'unknown';
    rows.push(
      `API version Current: ${application}; before contract: ${before}; after contract: ${after}`,
    );
  }
  if (report && Array.isArray(report.findings)) {
    const confirmed = report.findings.filter(
      (finding) => isObject(finding) && finding.confidence === 'confirmed',
    );
    const files = new Set(confirmed.map((finding) => (finding as Record<string, unknown>).file));
    rows.push(
      `Found       ${confirmed.length} confirmed ${confirmed.length === 1 ? 'usage' : 'usages'} in ${files.size} ${files.size === 1 ? 'file' : 'files'}`,
    );
  }
  if (
    report &&
    isObject(report.patch) &&
    report.patch.status === 'proposed' &&
    typeof report.patch.generator === 'string' &&
    result.manifest.status !== 'existing-pr'
  )
    rows.push(
      `Generated   ${report.patch.generator === 'openai' ? 'AI' : 'Deterministic'} migration`,
    );
  if (
    report &&
    isObject(report.patch) &&
    report.patch.status === 'proposed' &&
    typeof report.patch.summary === 'string'
  )
    rows.push(`Proposal    ${proposalText(report.patch.summary)}`);
  if (report && Array.isArray(report.publicationFiles)) {
    const files = [
      ...new Set(
        report.publicationFiles
          .filter(
            (file): file is Record<string, unknown> =>
              isObject(file) && typeof file.path === 'string',
          )
          .map((file) => terminalText(file.path as string)),
      ),
    ];
    if (files.length) rows.push(`Files       ${files.length} changed: ${summaryList(files)}`);
  }
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
    if (isObject(validation.environment))
      rows.push(
        `Dependencies ${validation.environment.reused ? 'Verified cache reused' : 'Prepared from npm lockfile'}; checks offline`,
      );
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
    rows.push(
      `${result.manifest.status === 'existing-pr' ? 'Author      ' : 'Published   '}${terminalText(String(publisher))}`,
    );
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
