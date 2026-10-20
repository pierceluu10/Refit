import type { DeadlineEntry, DeadlineRegistry } from './deadline-registry.ts';
import { PipelineInputError } from './types.ts';

// Anthropic's model deprecations page, served as Markdown with the `.md` suffix.
export const ANTHROPIC_DEPRECATIONS =
  'https://platform.claude.com/docs/en/about-claude/model-deprecations';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface AnthropicRetirement {
  date: string;
  model: string;
  replacement: string;
}

function isoDate(text: string) {
  const match = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text.trim());
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (!match || month < 0) return undefined;
  const date = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  return new Date(`${date}T00:00:00Z`).toISOString().startsWith(date) ? date : undefined;
}

function cells(line: string) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

// Every row of the deprecation history tables: a retirement date, a deprecated model and its
// recommended replacement, each model in backticks. Other tables on the page are ignored. A table
// whose rows do not parse fails the whole read, so a changed page format is noticed, not skipped.
export function parseAnthropicDeprecations(markdown: string): AnthropicRetirement[] {
  const rows: AnthropicRetirement[] = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const header = cells(lines[index]);
    if (
      header.length !== 3 ||
      header[0] !== 'Retirement date' ||
      header[1] !== 'Deprecated model' ||
      header[2] !== 'Recommended replacement'
    )
      continue;
    for (index += 2; index < lines.length && lines[index].trim().startsWith('|'); index += 1) {
      const [date, model, replacement] = cells(lines[index]);
      const parsed = {
        date: isoDate(date ?? ''),
        model: /^`([a-z0-9][a-z0-9.-]*)`$/.exec(model ?? '')?.[1],
        replacement: /^`([a-z0-9][a-z0-9.-]*)`$/.exec(replacement ?? '')?.[1],
      };
      if (!parsed.date || !parsed.model || !parsed.replacement)
        throw new PipelineInputError(
          `Unrecognized row in Anthropic's deprecation table: ${lines[index].trim()}`,
        );
      rows.push(parsed as AnthropicRetirement);
    }
  }
  if (!rows.length)
    throw new PipelineInputError("No deprecation table found on Anthropic's deprecations page.");
  return rows;
}

// The registry ID of a group: its date and its first model without the snapshot date, such as
// `anthropic-2026-11-30-claude-sonnet-4-5`.
function entryId(date: string, model: string) {
  return `anthropic-${date}-${model.replace(/-\d{8}$/, '').replace(/\.0$/, '')}`;
}

export interface DeadlineSync {
  registry: DeadlineRegistry;
  added: string[];
  changed: string[];
  // Registry entries the page no longer lists. They are kept, never deleted automatically.
  missing: string[];
}

// Merges the page's retirements into the registry's Anthropic entries, one entry per retirement
// date and replacement. An entry whose date, replacement and page models are unchanged is kept as
// it is, including aliases a person added from another page and its `checkedAt`; only new or
// changed entries get today's `checkedAt`. Other providers are untouched.
export function syncAnthropicDeadlines(
  registry: DeadlineRegistry,
  rows: AnthropicRetirement[],
  today: string,
): DeadlineSync {
  const groups = new Map<string, AnthropicRetirement[]>();
  for (const row of rows) {
    const key = `${row.date}\t${row.replacement}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const existing = registry.deadlines.filter((entry) => entry.provider === 'anthropic');
  const added: string[] = [];
  const changed: string[] = [];
  const updated = new Map<string, DeadlineEntry>();
  const appended: DeadlineEntry[] = [];
  const matched = new Set<string>();
  for (const group of groups.values()) {
    const { date, replacement } = group[0];
    const models = [...new Set(group.map((row) => row.model))];
    // The entry that already lists one of these models, so a moved date updates it in place.
    const previous = existing.find((entry) =>
      models.some((model) => entry.versions.includes(model)),
    );
    // One entry's models now on different dates or replacements: merging either group into it
    // would move the other's models too, so a person splits the entry.
    if (previous && matched.has(previous.id))
      throw new PipelineInputError(
        `Anthropic's page splits registry entry ${previous.id} across retirement dates or replacements; update it by hand.`,
      );
    if (previous) matched.add(previous.id);
    if (
      previous &&
      previous.date === date &&
      previous.replacement === replacement &&
      models.every((model) => previous.versions.includes(model))
    )
      continue;
    const id = previous?.id ?? entryId(date, models[0]);
    const entry: DeadlineEntry = {
      id,
      provider: 'anthropic',
      kind: 'model',
      versions: [...new Set([...models, ...(previous?.versions ?? [])])],
      date,
      summary: `Anthropic retires ${models.join(', ')} on the Claude API; requests to a retired model fail.`,
      replacement,
      source: ANTHROPIC_DEPRECATIONS,
      checkedAt: today,
    };
    if (previous) {
      changed.push(id);
      updated.set(id, entry);
    } else {
      added.push(id);
      appended.push(entry);
    }
  }
  const listed = new Set(rows.map((row) => row.model));
  const missing = existing
    .filter((entry) => !entry.versions.some((version) => listed.has(version)))
    .map((entry) => entry.id);
  // Existing entries keep their place; new ones follow, by date.
  appended.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return {
    registry: {
      formatVersion: 1,
      deadlines: [
        ...registry.deadlines.map((entry) => updated.get(entry.id) ?? entry),
        ...appended,
      ],
    },
    added,
    changed,
    missing,
  };
}
