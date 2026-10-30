import { AGENT_CATALOG } from './agent-catalog.ts';
import { agentStatus, type AgentStatus, type ReportedExposure } from './deadline-exposure.ts';
import { applyDeadlineIgnores, type DeadlineIgnore } from './deadline-ignores.ts';
import { reportOnly, type DeadlineRegistry } from './deadline-registry.ts';
import { isEmbeddingModel } from './model-alerts.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const DEFAULT_LEAD_DAYS = [90, 30, 7];
const MAX_LEAD_DAYS = 365;
const MAX_LEAD_TIMES = 6;
const TITLE_VERSIONS = 3;

export type DeadlineRequest = (
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) => Promise<unknown>;

// "90,30,7" → [90, 30, 7]: whole days before a deadline at which an alert opens or updates.
export function parseLeadDays(value: string) {
  const days = value.split(',').map((item) => Number(item.trim()));
  if (
    !days.length ||
    days.length > MAX_LEAD_TIMES ||
    days.some((day) => !Number.isInteger(day) || day < 1 || day > MAX_LEAD_DAYS) ||
    new Set(days).size !== days.length
  )
    throw new PipelineInputError(
      `Deadline lead times must be 1–${MAX_LEAD_TIMES} unique whole days from 1 to ${MAX_LEAD_DAYS}, such as 90,30,7.`,
    );
  return days.sort((a, b) => b - a);
}

// The tightest lead time a deadline has reached: 0 once the date arrives, null before the
// earliest lead time.
export function alertStage(days: number, leadDays: readonly number[]) {
  if (days <= 0) return 0;
  const reached = leadDays.filter((lead) => days <= lead);
  return reached.length ? Math.min(...reached) : null;
}

// An alert is due when the deadline reaches a tighter stage than the last one sent. Crossing
// several lead times between polls sends one alert at the tightest.
export function alertDue(stage: number | null, previous: number | null | undefined) {
  return stage !== null && (previous === null || previous === undefined || stage < previous);
}

// The exposures to alert about now: not report-only, not accepted by an active ignore, and at a
// tighter lead time than the last alert `sent` for that deadline. An invalid ignore file should pass no entries, so a
// broken exception can never silence an alert.
export function dueDeadlineAlerts<Exposure extends ReportedExposure>(options: {
  exposures: Exposure[];
  ignores: DeadlineIgnore[];
  registry: DeadlineRegistry;
  now: Date;
  leadDays: readonly number[];
  sent: (deadline: string) => number | null | undefined;
}) {
  const { decisions } = applyDeadlineIgnores(
    options.exposures,
    options.ignores,
    new Set(options.registry.deadlines.map((entry) => entry.id)),
    options.now,
  );
  return options.exposures
    .filter(
      (exposure) =>
        !reportOnly(exposure.deadline) && !decisions.get(exposure.deadline.id)?.ignoredBy.length,
    )
    .map((exposure) => ({ exposure, stage: alertStage(exposure.days, options.leadDays) }))
    .filter((alert): alert is { exposure: Exposure; stage: number } =>
      alertDue(alert.stage, options.sent(alert.exposure.deadline.id)),
    );
}

function providerName(provider: string) {
  return AGENT_CATALOG.find((agent) => agent.id === provider)?.name ?? provider;
}

function code(value: string) {
  return `\`${value.replaceAll('`', "'")}\``;
}

export function deadlineMarker(id: string) {
  return `<!-- refit-deadline:${id} -->`;
}

function subject(exposure: ReportedExposure) {
  const { deadline } = exposure;
  const matched = [...new Set(exposure.evidence.map((item) => item.version))];
  const versions = matched.length ? matched : deadline.versions;
  const listed = versions.slice(0, TITLE_VERSIONS).join(', ');
  const extra =
    versions.length > TITLE_VERSIONS ? ` and ${versions.length - TITLE_VERSIONS} more` : '';
  if (deadline.kind === 'model')
    return `${versions.length === 1 ? 'model' : 'models'} ${listed}${extra}`;
  if (deadline.kind === 'sdk')
    return `${versions.length === 1 ? 'package' : 'packages'} ${listed}${extra}`;
  if (deadline.kind === 'method')
    return `${versions.length === 1 ? 'method' : 'methods'} ${listed}${extra}`;
  if (deadline.kind === 'endpoint')
    return `${versions.length === 1 ? 'endpoint' : 'endpoints'} ${listed}${extra}`;
  if (deadline.kind === 'field')
    return `GraphQL ${versions.length === 1 ? 'field' : 'fields'} ${listed}${extra}`;
  if (deadline.kind === 'feature') return `use of ${listed}${extra}`;
  if (deadline.provider === 'meta-graph') return `Graph API ${listed}`;
  if (deadline.provider === 'github') return `REST API version ${listed}`;
  return `API version ${listed}`;
}

export function timing(days: number) {
  if (days > 1) return `${days} days left`;
  if (days === 1) return '1 day left';
  if (days === 0) return 'today';
  return `passed ${-days} day${days === -1 ? '' : 's'} ago`;
}

export function deadlineTitle(exposure: ReportedExposure) {
  return `${providerName(exposure.deadline.provider)} ${subject(exposure)} ${exposure.days < 0 ? 'passed its' : 'reaches its'} sunset on ${exposure.deadline.date}`;
}

// What happens next. A configured integration runs the normal migration with every gate; an alert
// itself never edits code, starts a worker or publishes a pull request.
// Embedding models are never swapped automatically (item 7): the vectors already stored are only
// comparable with vectors from the same model.
export const EMBEDDING_NOTE =
  '**This is an embedding model, so moving is a data migration.** Vectors from a different embedding model are not comparable with the ones this model already stored, so changing only the model ID would silently break search and similarity over existing data. Re-embed every stored vector with the new model and rebuild the index (the dimension can change) before switching queries over. Refit cannot run or check that from the code, so it never changes this model automatically.';

export function migrationNote(provider: string, status: AgentStatus) {
  const name = providerName(provider);
  if (status.state === 'configured')
    return `Refit's ${status.integration ? `${code(status.integration)} integration` : 'configured integration'} covers ${name}. When ${name} publishes this change in the API contract Refit monitors, that integration's normal migration run handles it, with the same approval check, offline validation and draft pull request gates. See \`refit serve\` status for its result.`;
  if (status.state === 'available')
    return `Refit has ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} agent. Add it with \`refit agents --add ${provider}\`, save reviewed contracts, then approve the configuration with \`refit enroll\`. Migrations then run through the normal approval, validation and draft pull request gates.`;
  return `Refit has no ${name} agent yet, so this alert cannot start a migration. Plan the upgrade with the provider's guide.`;
}

export function deadlineBody(options: {
  exposure: ReportedExposure;
  repository: string;
  revision: string | null;
  status: AgentStatus;
  leadDays: readonly number[];
}) {
  const { exposure, repository, revision } = options;
  const { deadline } = exposure;
  const link = (file: string, line: number) =>
    revision
      ? `[${code(`${file}:${line}`)}](https://github.com/${repository}/blob/${revision}/${file.split('/').map(encodeURIComponent).join('/')}#L${line})`
      : code(`${file}:${line}`);
  return [
    deadlineMarker(deadline.id),
    `**${deadline.summary}**`,
    '',
    '| | |',
    '|---|---|',
    `| Deadline | ${deadline.date} (${timing(exposure.days)}) |`,
    ...(deadline.replacement ? [`| Replacement | ${code(deadline.replacement)} |`] : []),
    `| Source | [${new URL(deadline.source!).hostname}](${deadline.source}), checked ${deadline.checkedAt} |`,
    '',
    '### Where this repository depends on it',
    '',
    ...exposure.evidence.map(
      (item) => `- ${link(item.file, item.line)}${item.text ? `: ${code(item.text)}` : ''}`,
    ),
    ...(exposure.more ? [`- …and ${exposure.more} more matches.`] : []),
    ...nonLiveNote(exposure),
    '',
    '### Migration',
    '',
    ...(deadline.kind === 'model' && deadline.versions.some(isEmbeddingModel)
      ? [EMBEDDING_NOTE, '']
      : []),
    migrationNote(deadline.provider, options.status),
    '',
    `Refit updates this issue ${options.leadDays.join(', ')} days before the deadline and when it passes. It never changes code from an alert.`,
  ].join('\n');
}

// Matches outside live code never open or update an alert; the issue only counts them.
function nonLiveNote(exposure: ReportedExposure) {
  const counts = new Map<string, number>();
  for (const item of exposure.nonLive) counts.set(item.use, (counts.get(item.use) ?? 0) + 1);
  const total = exposure.nonLive.length + exposure.nonLiveMore;
  if (!total) return [];
  const uses = [...counts].map(([use, count]) => `${count} ${use}`).join(', ');
  return [
    '',
    `Not counted: ${total} ${total === 1 ? 'match' : 'matches'} outside live code (${uses}${exposure.nonLiveMore ? `, ${exposure.nonLiveMore} more` : ''}), such as model lists, tests, examples, comments and tokenizer calls. \`refit deadlines\` lists them.`,
  ];
}

export function deadlineComment(exposure: ReportedExposure) {
  return exposure.days <= 0
    ? `The ${exposure.deadline.date} deadline has ${exposure.days === 0 ? 'arrived' : 'passed'} and this repository still depends on it. Refit refreshed the evidence above.`
    : `${timing(exposure.days)} until ${exposure.deadline.date}. Refit refreshed the evidence above.`;
}

// Opens the issue for a repository and deadline, or updates the one Refit opened before and adds a
// comment so watchers are notified. A closed issue stays closed.
export async function syncDeadlineIssue(options: {
  request: DeadlineRequest;
  repository: string;
  issue: number | null;
  title: string;
  body: string;
  comment: string;
}) {
  if (options.issue === null) {
    const created = await options.request('POST', `/repos/${options.repository}/issues`, {
      title: options.title,
      body: options.body,
    });
    if (!isObject(created) || !Number.isSafeInteger(created.number) || Number(created.number) <= 0)
      throw new PipelineInputError('GitHub did not return the created issue number.');
    return { issue: Number(created.number), action: 'opened' as const };
  }
  await options.request('PATCH', `/repos/${options.repository}/issues/${options.issue}`, {
    title: options.title,
    body: options.body,
  });
  await options.request('POST', `/repos/${options.repository}/issues/${options.issue}/comments`, {
    body: options.comment,
  });
  return { issue: options.issue, action: 'updated' as const };
}

// Opens or updates the issue for one exposure with its current evidence and migration note.
export function syncDeadlineAlert(options: {
  request: DeadlineRequest;
  repository: string;
  issue: number | null;
  exposure: ReportedExposure;
  revision: string | null;
  integrations: Parameters<typeof agentStatus>[1];
  leadDays: readonly number[];
}) {
  const { exposure, repository } = options;
  return syncDeadlineIssue({
    request: options.request,
    repository,
    issue: options.issue,
    title: deadlineTitle(exposure),
    body: deadlineBody({
      exposure,
      repository,
      revision: options.revision,
      status: agentStatus(exposure.deadline.provider, options.integrations),
      leadDays: options.leadDays,
    }),
    comment: deadlineComment(exposure),
  });
}
