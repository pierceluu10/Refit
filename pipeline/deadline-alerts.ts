import { AGENT_CATALOG } from './agent-catalog.ts';
import type { AgentStatus, DeadlineExposure } from './deadline-exposure.ts';
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

function providerName(provider: string) {
  return AGENT_CATALOG.find((agent) => agent.id === provider)?.name ?? provider;
}

function code(value: string) {
  return `\`${value.replaceAll('`', "'")}\``;
}

export function deadlineMarker(id: string) {
  return `<!-- refit-deadline:${id} -->`;
}

function subject(exposure: DeadlineExposure) {
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
  if (deadline.provider === 'meta-graph') return `Graph API ${listed}`;
  return `API version ${listed}`;
}

export function timing(days: number) {
  if (days > 1) return `${days} days left`;
  if (days === 1) return '1 day left';
  if (days === 0) return 'today';
  return `passed ${-days} day${days === -1 ? '' : 's'} ago`;
}

export function deadlineTitle(exposure: DeadlineExposure) {
  return `${providerName(exposure.deadline.provider)} ${subject(exposure)} ${exposure.days < 0 ? 'passed its' : 'reaches its'} sunset on ${exposure.deadline.date}`;
}

// What happens next. A configured integration runs the normal migration with every gate; an alert
// itself never edits code, starts a worker or publishes a pull request.
export function migrationNote(provider: string, status: AgentStatus) {
  const name = providerName(provider);
  if (status.state === 'configured')
    return `Refit's ${status.integration ? `${code(status.integration)} integration` : 'configured integration'} covers ${name}. When ${name} publishes this change in the API contract Refit monitors, that integration's normal migration run handles it, with the same approval check, offline validation and draft pull request gates. See \`refit serve\` status for its result.`;
  if (status.state === 'available')
    return `Refit has ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} agent. Add it with \`refit agents --add ${provider}\`, save reviewed contracts, then approve the configuration with \`refit enroll\`. Migrations then run through the normal approval, validation and draft pull request gates.`;
  return `Refit has no ${name} agent yet, so this alert cannot start a migration. Plan the upgrade with the provider's guide.`;
}

export function deadlineBody(options: {
  exposure: DeadlineExposure;
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
    ...exposure.evidence.map((item) => `- ${link(item.file, item.line)}: ${code(item.text)}`),
    ...(exposure.more ? [`- …and ${exposure.more} more matches.`] : []),
    ...nonLiveNote(exposure),
    '',
    '### Migration',
    '',
    migrationNote(deadline.provider, options.status),
    '',
    `Refit updates this issue ${options.leadDays.join(', ')} days before the deadline and when it passes. It never changes code from an alert.`,
  ].join('\n');
}

// Matches outside live code never open or update an alert; the issue only counts them.
function nonLiveNote(exposure: DeadlineExposure) {
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

export function deadlineComment(exposure: DeadlineExposure) {
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
