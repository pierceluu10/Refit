import { isObject, parseObject } from './specifications.ts';
import { COMPRESSED_SUFFIX, readEvidence } from './state-files.ts';
import type { runWorkflow } from './workflow.ts';
import { affectedFields } from './report-fields.ts';

type Result = Awaited<ReturnType<typeof runWorkflow>>;

const TITLES: Record<Result['manifest']['status'], string> = {
  'needs-review': 'Refit needs review',
  'validation-failed': 'Migration validation failed',
  validated: 'Migration validated',
  'version-bump': 'API version bump validated',
  'draft-created': 'Draft PR ready',
  'draft-updated': 'Draft PR updated',
  'draft-closed': 'Draft PR closed',
  'existing-pr': 'Existing PR found',
  'up-to-date': 'Up to date',
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

function renderReportRows(report: Record<string, unknown> | undefined, existingPr = false) {
  const rows: string[] = [];
  if (report && typeof report.provider === 'string' && Array.isArray(report.changes)) {
    const fields = report.changes.filter(
      (change): change is Record<string, unknown> =>
        isObject(change) &&
        typeof change.schema === 'string' &&
        typeof change.property === 'string',
    );
    const changes = affectedFields(
      fields,
      Array.isArray(report.findings) ? report.findings.filter(isObject) : [],
    ).map((change) => terminalText(`${change.schema}.${change.property}`));
    if (changes.length) {
      const provider =
        report.provider === 'stripe' ||
        (isObject(report.adapter) && report.adapter.packageName === 'stripe')
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
      `API version Current: ${terminalText(application)}; before contract: ${terminalText(before)}; after contract: ${terminalText(after)}`,
    );
  }
  if (report && Array.isArray(report.operationChanges)) {
    for (const change of report.operationChanges.slice(0, MAX_SUMMARY_ITEMS)) {
      if (
        !isObject(change) ||
        ![
          'httpMethod',
          'path',
          'replacementPath',
          'resource',
          'method',
          'replacementResource',
          'replacementMethod',
        ].every((key) => typeof change[key] === 'string')
      )
        continue;
      rows.push(
        `API change  ${terminalText(`${change.httpMethod} ${change.path} → ${change.httpMethod} ${change.replacementPath}`)}`,
      );
      rows.push(
        `SDK mapping ${terminalText(`${change.resource}.${change.method} → ${change.replacementResource}.${change.replacementMethod}`)} (${change.supported ? 'configured contract match' : 'requires review'})`,
      );
    }
  }
  if (report && Array.isArray(report.requestChanges)) {
    for (const change of report.requestChanges.slice(0, MAX_SUMMARY_ITEMS)) {
      if (
        !isObject(change) ||
        !['resource', 'method', 'removed', 'replacement'].every(
          (key) => typeof change[key] === 'string',
        )
      )
        continue;
      rows.push(
        `Request     ${terminalText(`${change.resource}.${change.method} argument[${change.argumentIndex}]: ${change.removed} → ${change.replacement}`)} (${change.supported ? 'configured contract match' : 'requires review'})`,
      );
    }
  }
  if (report && Array.isArray(report.operationImpacts)) {
    const impacts = report.operationImpacts.filter(
      (impact): impact is Record<string, unknown> =>
        isObject(impact) &&
        typeof impact.operationId === 'string' &&
        typeof impact.path === 'string' &&
        typeof impact.httpMethod === 'string' &&
        Array.isArray(impact.usages),
    );
    const usageCount = impacts.reduce(
      (count, impact) => count + (impact.usages as unknown[]).length,
      0,
    );
    const changeCount = impacts.reduce(
      (count, impact) =>
        count +
        (Array.isArray(impact.changes)
          ? impact.changes.length
          : typeof impact.text === 'string' && impact.text
            ? 1
            : 0),
      0,
    );
    if (impacts.length) {
      rows.push(
        `Impact      ${changeCount} breaking API ${changeCount === 1 ? 'change' : 'changes'} across ${impacts.length} ${impacts.length === 1 ? 'operation' : 'operations'} map to ${usageCount} SDK ${usageCount === 1 ? 'call site' : 'call sites'}`,
      );
      for (const impact of impacts.slice(0, MAX_SUMMARY_ITEMS)) {
        const locations = (impact.usages as unknown[])
          .filter(
            (usage): usage is Record<string, unknown> =>
              isObject(usage) && typeof usage.file === 'string' && typeof usage.line === 'number',
          )
          .map((usage) => terminalText(`${usage.file}:${usage.line}`));
        rows.push(
          `API call    ${terminalText(`${impact.httpMethod} ${impact.path} (${impact.operationId})`)}${locations.length ? ` at ${summaryList(locations)}` : ''}`,
        );
        const changes = Array.isArray(impact.changes) ? impact.changes : [];
        for (const change of changes.slice(0, MAX_SUMMARY_ITEMS)) {
          if (!isObject(change) || typeof change.id !== 'string' || typeof change.text !== 'string')
            continue;
          rows.push(`API change  ${terminalText(`[${change.id}] ${change.text}`)}`);
        }
        if (!changes.length && typeof impact.text === 'string' && impact.text)
          rows.push(`API change  ${terminalText(impact.text)}`);
      }
    }
  }
  if (report && Array.isArray(report.findings)) {
    const webhookReads = report.findings.filter(
      (finding) => isObject(finding) && isObject(finding.webhook),
    );
    if (webhookReads.length) {
      const policy =
        isObject(report.adapter) && isObject(report.adapter.stripeSubscriptionPeriods)
          ? report.adapter.stripeSubscriptionPeriods
          : undefined;
      const configured = Boolean(
        policy &&
        webhookReads.every(
          (finding) =>
            isObject(finding) && isObject(finding.webhook) && isObject(finding.webhook.migration),
        ),
      );
      rows.push(
        `Webhooks    ${webhookReads.length} affected payload ${webhookReads.length === 1 ? 'read' : 'reads'}; ${configured ? 'proposed policy checks signed event versions at runtime' : 'incoming API version requires review'}`,
      );
      if (configured && typeof policy?.priceId === 'string')
        rows.push(
          `Item policy Exactly one match for price ${terminalText(policy.priceId)}; incomplete lists require review`,
        );
      const types = [
        ...new Set(
          webhookReads.flatMap((finding) => {
            const details = (finding as Record<string, unknown>).webhook;
            return isObject(details) && Array.isArray(details.eventTypes)
              ? details.eventTypes
                  .filter((name): name is string => typeof name === 'string')
                  .map(terminalText)
              : [];
          }),
        ),
      ];
      rows.push(`Events      ${types.length ? summaryList(types) : 'Type could not be verified'}`);
    }
    const confirmed = report.findings.filter(
      (finding) => isObject(finding) && finding.confidence === 'confirmed',
    );
    const files = new Set(confirmed.map((finding) => (finding as Record<string, unknown>).file));
    if (
      confirmed.length ||
      !Array.isArray(report.operationImpacts) ||
      !report.operationImpacts.length
    )
      rows.push(
        `Found       ${confirmed.length} confirmed ${confirmed.length === 1 ? 'usage' : 'usages'} in ${files.size} ${files.size === 1 ? 'file' : 'files'}`,
      );
    // Where each removed request parameter is still sent, so the person knows what to change.
    const removed = confirmed.flatMap((finding) => {
      const { requestParameter, file, line } = finding as Record<string, unknown>;
      return isObject(requestParameter) && typeof requestParameter.parameter === 'string'
        ? [`${requestParameter.parameter} is still sent at ${String(file)}:${Number(line)}`]
        : [];
    });
    for (const site of removed.slice(0, MAX_SUMMARY_ITEMS))
      rows.push(`Removed     ${terminalText(site)}`);
    if (removed.length > MAX_SUMMARY_ITEMS)
      rows.push(`            and ${removed.length - MAX_SUMMARY_ITEMS} more in the evidence`);
    const review = report.findings.filter(
      (finding) => isObject(finding) && finding.confidence === 'review',
    );
    if (review.length) {
      const sources = [
        ...new Set(
          review.flatMap((finding) => {
            const file = (finding as Record<string, unknown>).file;
            return typeof file === 'string' ? [terminalText(file)] : [];
          }),
        ),
      ];
      rows.push(
        `Review      ${review.length} ${review.length === 1 ? 'finding requires' : 'findings require'} review in ${sources.length} ${sources.length === 1 ? 'file' : 'files'}`,
      );
      if (sources.length) rows.push(`Sources     ${summaryList(sources)}`);
    }
  }
  if (report && isObject(report.shopify) && Array.isArray(report.shopify.restCalls)) {
    const calls = report.shopify.restCalls.filter(
      (call): call is Record<string, unknown> =>
        isObject(call) && typeof call.file === 'string' && typeof call.line === 'number',
    );
    if (calls.length)
      rows.push(
        `REST        ${calls.length} REST Admin ${calls.length === 1 ? 'call' : 'calls'} for review, not migrated: ${summaryList(
          calls.map((call) =>
            terminalText(
              `${[call.method, call.path ?? call.resource].filter((value) => typeof value === 'string').join(' ') || 'call'} at ${call.file}:${call.line}`,
            ),
          ),
        )}`,
      );
  }
  if (
    report &&
    isObject(report.patch) &&
    report.patch.status === 'proposed' &&
    typeof report.patch.generator === 'string' &&
    !existingPr
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
        `Dependencies ${validation.environment.reused ? 'Verified cache reused' : `Prepared from ${typeof validation.environment.manager === 'string' ? validation.environment.manager : 'npm'} lockfile`}; checks offline${
          typeof validation.environment.platformPackages !== 'number'
            ? ''
            : validation.environment.platformPackageMode === 'install'
              ? `; ${validation.environment.platformPackages} platform-specific packages installed without checksums (REFIT_YARN_PLATFORM_PACKAGES=install)`
              : `; ${validation.environment.platformPackages} platform-specific packages without checksums not installed`
        }`,
      );
    const runtime = validation.runtime;
    if (isObject(runtime) && typeof runtime.image === 'string')
      rows.push(
        `Runtime     ${terminalText(runtime.image)}${typeof runtime.nodeVersion === 'string' ? ` (Node.js ${terminalText(runtime.nodeVersion)})` : ''}${
          Array.isArray(runtime.declarations) && runtime.declarations.length
            ? `. ${terminalText(String(runtime.reason))}`
            : ''
        }`,
      );
    if (isObject(validation.baseline) && isObject(validation.patched))
      rows.push(
        `Checks      Original: ${validation.baseline.status}; proposed: ${validation.patched.status}`,
      );
    if (
      isObject(validation.generated) &&
      isObject(validation.generated.baseline) &&
      isObject(validation.generated.patched)
    )
      rows.push(
        `Generated   stripe-mock${typeof validation.generated.status === 'string' ? ` ${validation.generated.status}` : ''}: original ${validation.generated.baseline.status}; proposed ${validation.generated.patched.status}; ${Array.isArray(validation.generated.entryPoints) ? validation.generated.entryPoints.length : 0} functions (${Array.isArray(validation.generated.notRunnable) ? validation.generated.notRunnable.length : 0} not runnable alone), ${String(validation.generated.uncoveredFindings)} usages uncovered${typeof validation.generated.reason === 'string' ? `. ${terminalText(validation.generated.reason)}` : ''}`,
      );
    if (Array.isArray(validation.attempts) && isObject(validation.repair))
      rows.push(
        `Attempts    ${validation.attempts.length} tested; ${validation.repair.requested} AI repairs`,
      );
  }
  return rows;
}

export function renderScanResult(value: unknown) {
  const report = isObject(value) ? value : undefined;
  return [
    'Refit scan',
    '',
    ...renderReportRows(report),
    '',
    'Scan only: repository files unchanged; checks have not run.',
    ...(report && typeof report.nextAction === 'string' ? [terminalText(report.nextAction)] : []),
  ].join('\n');
}

export async function renderWorkflowResult(result: Result) {
  const readArtifact = async (name: string) => {
    const text = result.manifest.files.some(
      (file) => file.path === name || file.path === `${name}${COMPRESSED_SUFFIX}`,
    )
      ? await readEvidence(result.directory, name)
      : undefined;
    return text === undefined ? undefined : parseObject(text, name);
  };
  const report = (await readArtifact('report.json')) ?? (await readArtifact('scan.json'));
  const publication = await readArtifact('publication.json');
  const rows = renderReportRows(report, result.manifest.status === 'existing-pr');
  if (result.manifest.integration)
    rows.unshift(`Integration ${terminalText(result.manifest.integration)}`);
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
