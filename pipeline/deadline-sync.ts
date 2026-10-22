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

// Google's Gemini API deprecations page (HTML). Its dates are the earliest possible shutdowns.
export const GEMINI_DEPRECATIONS = 'https://ai.google.dev/gemini-api/docs/deprecations';

// A dated shutdown with its replacement, or null when the page names none or several.
export interface ModelRetirement {
  date: string;
  model: string;
  replacement: string | null;
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

const MODEL = /^[a-z0-9][a-z0-9.@-]*$/;
// Shutdown cells that name no date. Anything else must be a date, or the read fails.
const UNDATED = /^(?:|N\/A|No shutdown date announced)$/;

function cellText(html: string) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every dated row of the model tables (Model, Release date, Shutdown date, Recommended
// replacement). Undated rows, the managed agents table and the "Preview models" separator rows
// are skipped; a row whose model or shutdown cell does not parse fails the whole read.
export function parseGeminiDeprecations(html: string): ModelRetirement[] {
  const rows: ModelRetirement[] = [];
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    const [first, ...body] = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    const header = [...(first ?? '').matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) =>
      cellText(cell[1]),
    );
    if (header.join('|') !== 'Model|Release date|Shutdown date|Recommended replacement') continue;
    for (const row of body) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
        cellText(cell[1]),
      );
      if (cells.length !== 4) continue;
      const [model, , shutdown, replacement] = cells;
      const date = isoDate(shutdown);
      if (!MODEL.test(model) || (!date && !UNDATED.test(shutdown)))
        throw new PipelineInputError(
          `Unrecognized row in Google's Gemini deprecations table: ${cells.join(' | ')}`,
        );
      if (date)
        rows.push({ date, model, replacement: MODEL.test(replacement) ? replacement : null });
    }
  }
  if (!rows.length)
    throw new PipelineInputError("No dated shutdown found on Google's Gemini deprecations page.");
  return rows;
}

interface ProviderPage {
  provider: 'anthropic' | 'gemini';
  name: string;
  source: string;
  id: (date: string, model: string) => string;
  summary: (models: string[]) => string;
}

const ANTHROPIC_PAGE: ProviderPage = {
  provider: 'anthropic',
  name: 'Anthropic',
  source: ANTHROPIC_DEPRECATIONS,
  // Its date and its first model without the snapshot date, such as
  // `anthropic-2026-11-30-claude-sonnet-4-5`.
  id: (date, model) => `anthropic-${date}-${model.replace(/-\d{8}$/, '').replace(/\.0$/, '')}`,
  summary: (models) =>
    `Anthropic retires ${models.join(', ')} on the Claude API; requests to a retired model fail.`,
};

const GEMINI_PAGE: ProviderPage = {
  provider: 'gemini',
  name: 'Google',
  source: GEMINI_DEPRECATIONS,
  id: (date, model) => `gemini-${date}-${model.replaceAll('.', '-')}`,
  summary: (models) =>
    `Google shuts down ${models.join(', ')} on the Gemini API no earlier than this date; requests to a shut-down model fail. The Vertex AI (Gemini Enterprise Agent Platform) dates differ.`,
};

export interface DeadlineSync {
  registry: DeadlineRegistry;
  added: string[];
  changed: string[];
  // Registry entries the page no longer lists. They are kept, never deleted automatically.
  missing: string[];
}

// Merges a page's retirements into the registry's model entries of its provider, one entry per retirement
// date and replacement. An entry whose date, replacement and page models are unchanged is kept as
// it is, including aliases a person added from another page and its `checkedAt`; only new or
// changed entries get today's `checkedAt`. Other providers are untouched.
export function syncAnthropicDeadlines(
  registry: DeadlineRegistry,
  rows: AnthropicRetirement[],
  today: string,
): DeadlineSync {
  return syncDeadlines(ANTHROPIC_PAGE, registry, rows, today);
}

// The same merge for Google's Gemini API page; a row without one named replacement gets null.
export function syncGeminiDeadlines(
  registry: DeadlineRegistry,
  rows: ModelRetirement[],
  today: string,
): DeadlineSync {
  return syncDeadlines(GEMINI_PAGE, registry, rows, today);
}

function syncDeadlines(
  page: ProviderPage,
  registry: DeadlineRegistry,
  rows: ModelRetirement[],
  today: string,
): DeadlineSync {
  const groups = new Map<string, ModelRetirement[]>();
  for (const row of rows) {
    const key = `${row.date}\t${row.replacement}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  // Model entries only: a provider's SDK end-of-support entries are not on its models page.
  const existing = registry.deadlines.filter(
    (entry) => entry.provider === page.provider && entry.kind === 'model',
  );
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
        `${page.name}'s page splits registry entry ${previous.id} across retirement dates or replacements; update it by hand.`,
      );
    if (previous) matched.add(previous.id);
    if (
      previous &&
      previous.date === date &&
      previous.replacement === replacement &&
      models.every((model) => previous.versions.includes(model))
    )
      continue;
    const id = previous?.id ?? page.id(date, models[0]);
    const entry: DeadlineEntry = {
      id,
      provider: page.provider,
      kind: 'model',
      versions: [...new Set([...models, ...(previous?.versions ?? [])])],
      date,
      summary: page.summary(models),
      replacement,
      source: page.source,
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
