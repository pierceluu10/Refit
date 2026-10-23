import { AGENT_CATALOG } from './agent-catalog.ts';
import { alertStage, DEFAULT_LEAD_DAYS, timing } from './deadline-alerts.ts';
import { agentStatus } from './deadline-exposure.ts';
import { applyDeadlineIgnores } from './deadline-ignores.ts';
import { daysUntil, type DeadlineRegistry } from './deadline-registry.ts';
import type { Inventory, InventoryEvidence, InventoryExposure } from './inventory.ts';
import { MODEL_CALLS } from './model-retirements.ts';
import { digest } from './specifications.ts';
import { IGNORE_PATHS_FILE, OUTSIDE_APPLICATION_CODE } from './workspace-attribution.ts';

export const REPORT_FORMAT_VERSION = 1;
export const REPORT_MARKER = '<!-- refit-report -->';
// GitHub rejects issue bodies over 65,536 characters; the markdown never exceeds this.
export const REPORT_CHARACTER_BUDGET = 60_000;
// Markdown lists at most this many entries per section, and evidence lines per entry. The JSON
// form keeps everything the inventory has.
const LISTED = 50;
const LISTED_EVIDENCE = 5;
const LISTED_CALLS = 10;
const LISTED_PACKAGES = 10;
// A live deadline this close, or past, makes moving off it the next step.
const URGENT_DAYS = 30;

export type Capability = 'migrate' | 'model-fixes' | 'report-only';

export interface Report {
  formatVersion: typeof REPORT_FORMAT_VERSION;
  repository: string;
  revision: string | null;
  // The UTC day days left were counted from.
  date: string;
  integrations: {
    provider: string;
    name: string;
    packages: { file: string; name: string; declared: string; locked: string | null }[];
    // Whether a `.refit.json` integration covers it, and that integration's name when it has one.
    configured: boolean;
    integration: string | null;
    capability: Capability;
    apiVersions: { file: string; line: number; value: string | null }[];
  }[];
  deadlines: {
    id: string;
    provider: string;
    kind: string;
    versions: string[];
    date: string;
    days: number;
    summary: string;
    replacement: string | null;
    source: string | null;
    evidence: { file: string; line: number }[];
    more: number;
    // Accepted by an active entry in the committed ignore file.
    ignored: boolean;
  }[];
  // Deadlines named only outside live code (tests, comments, catalogs, tokenizers, checks).
  mentions: string[];
  // Counted live matches on docs, example, test-fixture and build-output paths, with the reason
  // (owner decision 22): labelled, not excluded.
  outside: { id: string; file: string; line: number; version: string; reason: string }[];
  // Matches on paths the repository opts out in IGNORE_PATHS_FILE, with its reason: never counted.
  ignoredPaths: { id: string; file: string; line: number; version: string; reason: string }[];
  models: {
    model: string | null;
    provider: string;
    calls: { file: string; line: number; call: string; test: boolean }[];
  }[];
  // Hostnames of providers Refit has neither an agent nor registry deadlines for.
  untracked: {
    provider: string;
    name: string;
    hosts: { hostname: string; file: string; line: number }[];
  }[];
  next: string;
}

// A code span that shows `value` exactly: its fence is longer than any backtick run inside.
function code(value: string) {
  const fence = '`'.repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return fence.length > 1 ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
}

// What Refit can do for a provider: run migrations through an agent (configured or addable),
// propose model replacements, or only report.
function capability(provider: string, integrations: Inventory['integrations']): Capability {
  if (agentStatus(provider, integrations).state !== 'none') return 'migrate';
  return provider in MODEL_CALLS ? 'model-fixes' : 'report-only';
}

function configured(provider: string, integrations: Inventory['integrations']) {
  const status = agentStatus(provider, integrations);
  return status.state === 'configured'
    ? { configured: true, integration: status.integration }
    : { configured: false, integration: null };
}

// Model and SDK replacements are identifiers; API-version ones are prose, such as "A newer Graph
// API version".
const replacement = (kind: string, value: string) =>
  kind === 'api-version' ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : code(value);

function nextStep(report: Omit<Report, 'next'>) {
  const live = report.deadlines.filter((deadline) => !deadline.ignored);
  // An SDK's end of support does not stop its requests, so a model or API version that is past or
  // close to its sunset comes first.
  const soonest =
    live.find((deadline) => deadline.kind !== 'sdk' && deadline.days <= URGENT_DAYS) ?? live[0];
  if (soonest) {
    const subject = soonest.versions.map(code).join(', ');
    const when =
      soonest.days < 0
        ? `Move off ${subject} now: its sunset was ${soonest.date} (${timing(soonest.days)}).`
        : `${soonest.days <= URGENT_DAYS ? 'Move' : 'Plan to move'} off ${subject} before ${soonest.date} (${timing(soonest.days)}).`;
    const fixes =
      soonest.kind === 'model' && soonest.provider in MODEL_CALLS
        ? '; `refit deadlines --propose-model-fixes` proposes it where the model is a literal in a traced call'
        : '';
    const others = live.filter(
      (deadline) => deadline !== soonest && deadline.days <= URGENT_DAYS,
    ).length;
    return `${when}${soonest.replacement ? ` Replacement: ${replacement(soonest.kind, soonest.replacement)}${fixes}.` : ''}${
      others
        ? ` ${others} more ${others === 1 ? 'deadline is' : 'deadlines are'} past due or within ${URGENT_DAYS} days; see Deadlines.`
        : ''
    }`;
  }
  const addable = report.integrations.find(
    (integration) => integration.capability === 'migrate' && !integration.configured,
  );
  if (addable)
    return `Add the ${addable.name} agent with \`refit agents --add ${addable.provider}\` and approve the repository, so Refit can propose migrations for its breaking changes.`;
  if (report.integrations.some((integration) => integration.configured))
    return 'Nothing to do now. Configured integrations handle breaking changes through the usual approval, validation and draft pull request gates.';
  if (report.integrations.length)
    return 'Nothing to do now. Refit keeps watching these providers for deadlines.';
  return 'Nothing to do. Refit found no provider SDK or API it knows in this repository.';
}

// Builds the report from an inventory only. Days left are counted from `now`, so a stored
// inventory reports the same as a fresh scan of the same commit on the same day.
export function buildReport(options: {
  inventory: Inventory;
  registry: DeadlineRegistry;
  repository: string;
  revision: string | null;
  now: Date;
}): Report {
  const { inventory, registry, now } = options;
  const exposures = inventory.deadlines.exposures
    .map((exposure) => ({ ...exposure, days: daysUntil(exposure.deadline.date, now) }))
    .sort((a, b) => a.days - b.days || a.deadline.id.localeCompare(b.deadline.id));
  const { decisions } = applyDeadlineIgnores(
    exposures,
    inventory.ignores.error ? [] : inventory.ignores.entries,
    new Set(registry.deadlines.map((entry) => entry.id)),
    now,
  );
  const tracked = (provider: string) =>
    AGENT_CATALOG.some((agent) => agent.id === provider && agent.adapter) ||
    registry.deadlines.some((entry) => entry.provider === provider);
  const groups = new Map<string, Report['models'][number]>();
  for (const call of inventory.models) {
    const key = `${call.provider}\0${call.model ?? ''}`;
    const group = groups.get(key) ?? { model: call.model, provider: call.provider, calls: [] };
    group.calls.push({ file: call.file, line: call.line, call: call.call, test: call.test });
    groups.set(key, group);
  }
  const report: Omit<Report, 'next'> = {
    formatVersion: REPORT_FORMAT_VERSION,
    repository: options.repository,
    revision: options.revision,
    date: now.toISOString().slice(0, 10),
    integrations: inventory.providers.map((provider) => ({
      provider: provider.id,
      name: provider.name,
      packages: provider.packages.map((item) => ({
        file: item.file,
        name: item.name,
        declared: item.version,
        locked: item.locked,
      })),
      ...configured(provider.id, inventory.integrations),
      capability: capability(provider.id, inventory.integrations),
      apiVersions: inventory.apiVersions
        .filter((pin) => pin.provider === provider.id)
        .map((pin) => ({ file: pin.file, line: pin.line, value: pin.value })),
    })),
    deadlines: exposures.map((exposure) => ({
      id: exposure.deadline.id,
      provider: exposure.deadline.provider,
      kind: exposure.deadline.kind,
      versions: [...new Set(exposure.evidence.map((item) => item.version))],
      date: exposure.deadline.date,
      days: exposure.days,
      summary: exposure.deadline.summary,
      replacement: exposure.deadline.replacement,
      source: exposure.deadline.source,
      evidence: exposure.evidence.map((item) => ({ file: item.file, line: item.line })),
      more: exposure.more,
      ignored: Boolean(decisions.get(exposure.deadline.id)?.ignoredBy.length),
    })),
    mentions: inventory.deadlines.mentions.map((mention) => mention.deadline.id).sort(),
    outside: placed(
      exposures,
      (exposure) => exposure.evidence,
      (item) => (item.excluded && OUTSIDE_APPLICATION_CODE.has(item.excluded) ? item.excluded : ''),
    ),
    ignoredPaths: placed(
      [...inventory.deadlines.exposures, ...inventory.deadlines.mentions],
      (exposure) => exposure.ignoredPaths ?? [],
      (item) => item.ignoreReason ?? '',
    ),
    models: [...groups.values()].sort(
      (a, b) =>
        Number(a.model === null) - Number(b.model === null) ||
        (a.model ?? '').localeCompare(b.model ?? '') ||
        a.provider.localeCompare(b.provider),
    ),
    untracked: inventory.providers
      .filter((provider) => provider.hostnames.length && !tracked(provider.id))
      .map((provider) => ({
        provider: provider.id,
        name: provider.name,
        hosts: provider.hostnames.map((item) => ({
          hostname: item.hostname,
          file: item.file,
          line: item.line,
        })),
      })),
  };
  return { ...report, next: nextStep(report) };
}

// Each match a list of exposures picks, with the reason `reason` gives; matches with no reason are
// left out. Sorted by place.
function placed(
  exposures: InventoryExposure[],
  matches: (exposure: InventoryExposure) => InventoryEvidence[],
  reason: (item: InventoryEvidence) => string,
) {
  return exposures
    .flatMap((exposure) =>
      matches(exposure).map((item) => ({
        id: exposure.deadline.id,
        file: item.file,
        line: item.line,
        version: item.version,
        reason: reason(item),
      })),
    )
    .filter((item) => item.reason)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
}

function capabilityText(integration: Report['integrations'][number]) {
  if (integration.capability === 'model-fixes') return 'Proposes model replacements';
  if (integration.capability === 'report-only') return 'Reports only';
  if (!integration.configured) return 'Agent available: migrates breaking changes once added';
  return `Migrates breaking changes, configured${integration.integration ? ` as ${code(integration.integration)}` : ''}`;
}

function listed<T>(
  items: T[],
  limit: number,
  render: (item: T) => string[],
  noun: string,
  indent = '',
) {
  return [
    ...items.slice(0, limit).flatMap(render),
    ...(items.length > limit ? [`${indent}- …and ${items.length - limit} more ${noun}.`] : []),
  ];
}

function integrationLines(report: Report) {
  if (!report.integrations.length) return ['None found.'];
  const rows = report.integrations.slice(0, LISTED).flatMap((integration) => {
    const refit = capabilityText(integration);
    if (!integration.packages.length)
      return [`| ${integration.name} | API hosts only |  |  | ${refit} |`];
    return [
      ...integration.packages
        .slice(0, LISTED_PACKAGES)
        .map(
          (item) =>
            `| ${integration.name} | ${code(item.name)} in ${code(item.file)} | ${code(item.declared.replaceAll('|', '\\|'))} | ${item.locked ? code(item.locked) : ''} | ${refit} |`,
        ),
      ...(integration.packages.length > LISTED_PACKAGES
        ? [
            `| ${integration.name} | …and ${integration.packages.length - LISTED_PACKAGES} more package files |  |  |  |`,
          ]
        : []),
    ];
  });
  const pins = report.integrations.flatMap((integration) => {
    if (!integration.apiVersions.length) return [];
    const values = [...new Set(integration.apiVersions.flatMap((pin) => pin.value ?? []))];
    const computed = integration.apiVersions.filter((pin) => pin.value === null).length;
    return [
      `${integration.name} API versions pinned in code: ${[...values.map(code), ...(computed ? [`${computed} computed`] : [])].join(', ')}.`,
    ];
  });
  return [
    '| Provider | Package | Declared | Locked | Refit |',
    '|---|---|---|---|---|',
    ...rows,
    ...(report.integrations.length > LISTED
      ? ['', `…and ${report.integrations.length - LISTED} more providers.`]
      : []),
    ...(pins.length ? ['', ...pins] : []),
  ];
}

function deadlineLines(report: Report) {
  if (!report.deadlines.length) return ['No live code depends on a deadline in the registry.'];
  return listed(
    report.deadlines,
    LISTED,
    (deadline) => [
      `- **${deadline.date}** (${timing(deadline.days)}): ${deadline.summary}${
        deadline.replacement
          ? ` Replacement: ${replacement(deadline.kind, deadline.replacement)}.`
          : ''
      }${deadline.ignored ? ' Accepted by the committed ignore file.' : ''}${deadline.source ? ` [Source](${deadline.source})` : ''}`,
      ...listed(
        deadline.evidence,
        LISTED_EVIDENCE,
        (item) => [`  - ${code(`${item.file}:${item.line}`)}`],
        'lines',
        '  ',
      ),
      ...(deadline.more ? [`  - …and ${deadline.more} more matches.`] : []),
    ],
    'deadlines',
  );
}

function modelLines(report: Report) {
  if (!report.models.length) return ['No OpenAI or Anthropic text-generation calls traced.'];
  return listed(
    report.models,
    LISTED,
    (group) => [
      `- ${group.model ? code(group.model) : 'Computed model'} (${group.provider}, ${group.calls.length} ${group.calls.length === 1 ? 'call' : 'calls'})`,
      ...listed(
        group.calls,
        LISTED_CALLS,
        (call) => [
          `  - ${code(`${call.file}:${call.line}`)} ${code(call.call)}${call.test ? ' (test)' : ''}`,
        ],
        'calls',
        '  ',
      ),
    ],
    'models',
  );
}

// The markdown form, at most REPORT_CHARACTER_BUDGET characters. Long sections are cut with a note
// saying how many entries are left out; the JSON form keeps them all.
export function renderReport(report: Report) {
  const text = [
    REPORT_MARKER,
    `# What ${code(report.repository)} depends on`,
    '',
    `Counted on ${report.date}${report.revision ? ` at commit ${code(report.revision.slice(0, 12))}` : ''}, from files only: Refit ran no code and contacted no provider.`,
    '',
    '## Next step',
    '',
    report.next,
    '',
    '## Integrations',
    '',
    ...integrationLines(report),
    '',
    '## Deadlines',
    '',
    ...deadlineLines(report),
    ...(report.mentions.length
      ? [
          '',
          `Named only outside live code (tests, comments, catalogs): ${report.mentions.slice(0, LISTED).map(code).join(', ')}${report.mentions.length > LISTED ? `, and ${report.mentions.length - LISTED} more` : ''}.`,
        ]
      : []),
    ...(report.outside.length
      ? [
          '',
          'Counted, outside application code (docs / example / test fixture / build output). These paths are often deployed, so they count:',
          '',
          ...listed(
            report.outside,
            LISTED,
            (item) => [
              `- ${code(`${item.file}:${item.line}`)} (${item.reason}): ${code(item.version)} for ${code(item.id)}`,
            ],
            'matches',
          ),
        ]
      : []),
    ...(report.ignoredPaths.length
      ? [
          '',
          `Ignored by repository config (${code(IGNORE_PATHS_FILE)}, not counted):`,
          '',
          ...listed(
            report.ignoredPaths,
            LISTED,
            (item) => [
              `- ${code(`${item.file}:${item.line}`)} (${item.reason}): ${code(item.version)} for ${code(item.id)}`,
            ],
            'matches',
          ),
        ]
      : []),
    '',
    '## AI model calls',
    '',
    ...modelLines(report),
    '',
    '## Hosts Refit does not track',
    '',
    ...(report.untracked.length
      ? listed(
          report.untracked,
          LISTED,
          (provider) => [
            `- ${provider.name}: ${provider.hosts
              .slice(0, LISTED_EVIDENCE)
              .map((host) => `${code(host.hostname)} at ${code(`${host.file}:${host.line}`)}`)
              .join(
                ', ',
              )}${provider.hosts.length > LISTED_EVIDENCE ? `, and ${provider.hosts.length - LISTED_EVIDENCE} more` : ''}`,
          ],
          'providers',
        )
      : ['None.']),
  ].join('\n');
  if (text.length <= REPORT_CHARACTER_BUDGET) return text;
  const note = `\n\n_Truncated to ${REPORT_CHARACTER_BUDGET.toLocaleString('en-US')} characters. Run \`refit report --format json\` for everything._`;
  const kept = text.slice(0, REPORT_CHARACTER_BUDGET - note.length);
  return `${kept.slice(0, kept.lastIndexOf('\n'))}${note}`;
}

// Changes when what the report says changes, not every day or push: days left count only through
// the alert stage they are in, so it changes when a deadline crosses 90, 30 or 7 days or arrives.
// The date and next step (which repeat days left), the revision and line numbers are left out, so
// a push that only moves code does not rewrite the issue and notify its watchers.
export function reportDigest(report: Report) {
  return digest(
    JSON.stringify(
      {
        ...report,
        date: null,
        next: null,
        revision: null,
        deadlines: report.deadlines.map((deadline) => ({
          ...deadline,
          days: alertStage(deadline.days, DEFAULT_LEAD_DAYS),
        })),
      },
      (key, value) => (key === 'line' ? undefined : value),
    ),
  );
}
