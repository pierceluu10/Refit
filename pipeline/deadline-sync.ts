import {
  daysUntil,
  STALE_CHECK_DAYS,
  type DeadlineEntry,
  type DeadlineRegistry,
} from './deadline-registry.ts';
import { PipelineInputError } from './types.ts';

// Anthropic's model deprecations page, served as Markdown with the `.md` suffix.
export const ANTHROPIC_DEPRECATIONS =
  'https://platform.claude.com/docs/en/about-claude/model-deprecations';
// OpenAI's deprecations page, served as Markdown with the `.md` suffix.
export const OPENAI_DEPRECATIONS = 'https://developers.openai.com/api/docs/deprecations';
// The Gemini API's deprecations page, served as Markdown with the `.md.txt` suffix.
export const GEMINI_DEPRECATIONS = 'https://ai.google.dev/gemini-api/docs/deprecations';
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
const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;
const CODE = /`([^`]+)`/g;
const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;
// A model ID that is a plain word, such as `ada` or `davinci`. Refit matches registry models as
// quoted strings anywhere in a repository, and these also name unrelated things.
const PLAIN_WORD = /^[a-z]+$/;

export type SyncProvider = 'anthropic' | 'openai' | 'gemini';

export interface Retirement {
  date: string;
  model: string;
  // The models the page recommends instead, in its order.
  replacements: string[];
  // The page's recommendation when it is more than a list of models, such as a required setting.
  note: string | null;
}

// A row of a deprecation table that names no model Refit can match, with why.
export interface SkippedRow {
  date: string | null;
  text: string;
  reason: string;
}

export interface DeprecationPage {
  rows: Retirement[];
  skipped: SkippedRow[];
}

interface Table {
  header: string[];
  // The date of the announcement heading the table sits under, such as `### 2026-10-14: …`.
  announced: string;
  rows: { line: string; cells: string[] }[];
}

// "November 30, 2026", "Apr 1, 2027" or "2026-09-24", with any Unicode hyphen.
function isoDate(text: string) {
  const value = text.trim().replace(/[‐-–]/g, '-');
  const named = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  const month = named
    ? MONTHS.findIndex((name) => name === named[1] || name.slice(0, 3) === named[1])
    : -1;
  const date =
    named && month >= 0
      ? `${named[3]}-${String(month + 1).padStart(2, '0')}-${named[2].padStart(2, '0')}`
      : /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? value
        : undefined;
  const time = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
  return date && !Number.isNaN(time) && new Date(time).toISOString().startsWith(date)
    ? date
    : undefined;
}

// A table row's cells. `\|` is a pipe inside a cell.
function cells(line: string) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

function tables(markdown: string): Table[] {
  const found: Table[] = [];
  const lines = markdown.split('\n');
  let announced = '';
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6}) (.*)$/.exec(lines[index]);
    if (heading && heading[1].length <= 3)
      announced = /^(\d{4}-\d{2}-\d{2}):/.exec(heading[2])?.[1] ?? '';
    if (!lines[index].trim().startsWith('|') || !SEPARATOR.test(lines[index + 1]?.trim() ?? ''))
      continue;
    const table: Table = {
      header: cells(lines[index]).map((cell) => cell.replace(/^\*\*(.*)\*\*$/, '$1')),
      announced,
      rows: [],
    };
    for (index += 2; index < lines.length && lines[index].trim().startsWith('|'); index += 1)
      table.rows.push({ line: lines[index].trim(), cells: cells(lines[index]) });
    // The line after the table may be a heading.
    index -= 1;
    found.push(table);
  }
  return found;
}

const sameHeader = (header: string[], expected: string[]) =>
  header.length === expected.length && header.every((cell, index) => cell === expected[index]);

const codes = (cell: string) => [...cell.matchAll(CODE)].map((match) => match[1]);

// The cell's shape with every code span written as `M`, such as `M | M, M`.
const shape = (cell: string) => cell.replace(CODE, 'M');

// Markdown links become their text, and code spans plain text.
const plain = (cell: string) => cell.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replaceAll('`', '');

// The replacement cell: a list of models (`a`, `a or b`, `a, b, or c`), nothing (`---` or empty),
// or anything else, kept as a note so it is never applied as a model.
function recommendation(cell: string): Pick<Retirement, 'replacements' | 'note'> {
  const models = codes(cell);
  if (!cell || /^-+$/.test(cell)) return { replacements: [], note: null };
  if (models.every((model) => MODEL_ID.test(model)) && /^M(?:(?:, or|,| or) M)*$/.test(shape(cell)))
    return { replacements: models, note: null };
  return {
    replacements: models.filter((model) => MODEL_ID.test(model)),
    note: plain(cell).replace(/\.$/, ''),
  };
}

function unrecognized(provider: string, line: string) {
  return new PipelineInputError(`Unrecognized row in ${provider}'s deprecation table: ${line}`);
}

function skip(skipped: SkippedRow[], row: SkippedRow) {
  if (!skipped.some((item) => JSON.stringify(item) === JSON.stringify(row))) skipped.push(row);
}

// Every row of the deprecation history tables: a retirement date, a deprecated model and its
// recommended replacement, each model in backticks. Other tables on the page are ignored. A table
// whose rows do not parse fails the whole read, so a changed page format is noticed, not skipped.
export function parseAnthropicDeprecations(markdown: string): DeprecationPage {
  const rows: Retirement[] = [];
  for (const table of tables(markdown)) {
    if (!sameHeader(table.header, ['Retirement date', 'Deprecated model', 'Recommended replacement']))
      continue;
    for (const { line, cells: row } of table.rows) {
      const date = isoDate(row[0] ?? '');
      const model = /^`([a-z0-9][a-z0-9.-]*)`$/.exec(row[1] ?? '')?.[1];
      const replacement = /^`([a-z0-9][a-z0-9.-]*)`$/.exec(row[2] ?? '')?.[1];
      if (row.length !== 3 || !date || !model || !replacement)
        throw unrecognized('Anthropic', line);
      rows.push({ date, model, replacements: [replacement], note: null });
    }
  }
  if (!rows.length)
    throw new PipelineInputError("No deprecation table found on Anthropic's deprecations page.");
  return { rows, skipped: [] };
}

const OPENAI_MODEL_HEADERS = [
  'Model / system',
  'Model family / snapshot',
  'Model snapshot',
  'Deprecated model',
  'Legacy model',
  'System',
];
const OPENAI_REPLACEMENT_HEADERS = [
  'Recommended replacement',
  'Substitute model',
  'Recommended replacement base model',
];

// The models an OpenAI model cell names, or why it names none. Undefined for any other cell.
function openAiModels(cell: string): string[] | { reason: string } | undefined {
  const named = codes(cell);
  const form = shape(cell);
  if (!named.length)
    return /^(?:[A-Z][\w ]* API|OpenAI-Beta: [\w=]+)$/.test(cell)
      ? { reason: 'an API or request header, not a model' }
      : undefined;
  if (form === 'M' && /^\/?v1\//.test(named[0])) return { reason: 'an endpoint, not a model' };
  if (form === 'M' && named[0].startsWith('ft-'))
    return { reason: 'the fine-tuned models of a base model, whose IDs start with ft:' };
  if (form === 'New fine-tuning training on M')
    return { reason: 'new fine-tuning training only; the model is not shut down' };
  if (!named.every((model) => MODEL_ID.test(model))) return undefined;
  // A snapshot and its aliases (`a` | `b`, `c`), a display name around them (GPT-4o (`a`, `b`)),
  // or aliases that point to a snapshot.
  return /^M(?: \| M(?:, M)*)?$/.test(form) ||
    /^[A-Z][^()`|]* \(M(?:, M)*\)$/.test(form) ||
    /^M \(including M(?:, M)*,? and M, which point to this snapshot\)$/.test(form)
    ? named
    : undefined;
}

// Every shutdown table on OpenAI's page: a shutdown date, the models (a snapshot and its aliases)
// and a recommended replacement, with any price columns between them ignored. Timeline tables
// (`Date | Update`) are product notices without a model. A row for an API, endpoint, header,
// fine-tuning, a plain word, or a date given only as "at earliest" is skipped with its reason.
// A model listed by several announcements takes the most recent one's row. Any other table or row
// fails the whole read, so a changed page format is noticed, not skipped.
export function parseOpenAiDeprecations(markdown: string): DeprecationPage {
  const latest = new Map<string, Retirement & { announced: string }>();
  const skipped: SkippedRow[] = [];
  // "At earliest" rows, skipped unless another announcement gives the model a firm date.
  const tentative: { models: string[]; row: SkippedRow }[] = [];
  for (const table of tables(markdown)) {
    if (sameHeader(table.header, ['Date', 'Update'])) continue;
    const { header } = table;
    if (
      header.length < 3 ||
      header[0] !== 'Shutdown date' ||
      !OPENAI_MODEL_HEADERS.includes(header[1]) ||
      !OPENAI_REPLACEMENT_HEADERS.includes(header.at(-1)!)
    )
      throw new PipelineInputError(
        `Unrecognized table on OpenAI's deprecations page: | ${header.join(' | ')} |`,
      );
    for (const { line, cells: row } of table.rows) {
      if (row.length !== header.length) throw unrecognized('OpenAI', line);
      const date = isoDate(row[0]);
      const earliest = /^at earliest (.+)$/.exec(row[0]);
      if (!date && earliest && isoDate(earliest[1])) {
        tentative.push({
          models: codes(row[1]),
          row: { date: null, text: plain(row[1]), reason: 'no firm shutdown date' },
        });
        continue;
      }
      const models = openAiModels(row[1]);
      if (!date || !models) throw unrecognized('OpenAI', line);
      if (!Array.isArray(models)) {
        skip(skipped, { date, text: plain(row[1]), reason: models.reason });
        continue;
      }
      for (const model of models) {
        if (PLAIN_WORD.test(model)) {
          skip(skipped, {
            date,
            text: model,
            reason: 'a plain word that, as a quoted string, also names unrelated things',
          });
          continue;
        }
        const retirement = {
          date,
          model,
          ...recommendation(row.at(-1)!),
          announced: table.announced,
        };
        const seen = latest.get(model);
        if (
          seen?.announced === retirement.announced &&
          JSON.stringify(seen) !== JSON.stringify(retirement)
        )
          throw new PipelineInputError(
            `OpenAI's deprecations page lists ${model} twice under one announcement with a different date or replacement.`,
          );
        if (!seen || retirement.announced > seen.announced) latest.set(model, retirement);
      }
    }
  }
  if (!latest.size)
    throw new PipelineInputError("No deprecation table found on OpenAI's deprecations page.");
  for (const { models, row } of tentative)
    if (!models.every((model) => latest.has(model))) skip(skipped, row);
  return {
    rows: [...latest.values()].map(({ date, model, replacements, note }) => ({
      date,
      model,
      replacements,
      note,
    })),
    skipped,
  };
}

const GEMINI_HEADER = ['Release date', 'Shutdown date', 'Recommended replacement'];

// Every model table on the Gemini API's page: a model, its release date, its earliest shutdown
// date and a recommended replacement. Rows without a shutdown date, or whose endpoint stays up and
// routes to another model (N/A), retire nothing. Group labels such as "Preview models" are skipped,
// and managed agents are listed as skipped. Any other table or row fails the whole read.
export function parseGeminiDeprecations(markdown: string): DeprecationPage {
  const rows: Retirement[] = [];
  const skipped: SkippedRow[] = [];
  for (const table of tables(markdown)) {
    const agents = sameHeader(table.header, ['Agent', ...GEMINI_HEADER]);
    if (!agents && !sameHeader(table.header, ['Model', ...GEMINI_HEADER]))
      throw new PipelineInputError(
        `Unrecognized table on the Gemini API's deprecations page: | ${table.header.join(' | ')} |`,
      );
    for (const { line, cells: row } of table.rows) {
      if (row.length !== 4) throw unrecognized('the Gemini API', line);
      const [name, , shutdown, replacement] = row;
      if (!codes(name).length && row.slice(1).every((cell) => !cell)) continue;
      const model = /^`([a-z0-9][a-z0-9.-]*)`$/.exec(name)?.[1];
      if (!model) throw unrecognized('the Gemini API', line);
      if (shutdown === 'No shutdown date announced' || shutdown === 'N/A') continue;
      const date = isoDate(shutdown);
      if (!date) throw unrecognized('the Gemini API', line);
      if (agents) skip(skipped, { date, text: model, reason: 'a managed agent, not a model' });
      else rows.push({ date, model, ...recommendation(replacement) });
    }
  }
  if (!rows.length)
    throw new PipelineInputError(
      "No deprecation table found on the Gemini API's deprecations page.",
    );
  return { rows, skipped };
}

export interface DeprecationSource {
  provider: SyncProvider;
  name: string;
  // The page registry entries cite.
  page: string;
  // Where the page is served as Markdown.
  markdown: string;
  parse: (markdown: string) => DeprecationPage;
  entryId: (date: string, model: string) => string;
  summary: (models: string[]) => string;
}

// A registry ID from a group's date and first model, such as `openai-2026-10-23-gpt-4-1-nano`.
const registryId = (provider: string, date: string, model: string) =>
  `${provider}-${date}-${model}`.replace(/[^a-z0-9-]/g, '-');

export const DEPRECATION_SOURCES: Record<SyncProvider, DeprecationSource> = {
  anthropic: {
    provider: 'anthropic',
    name: 'Anthropic',
    page: ANTHROPIC_DEPRECATIONS,
    markdown: `${ANTHROPIC_DEPRECATIONS}.md`,
    parse: parseAnthropicDeprecations,
    // Without the snapshot date, such as `anthropic-2026-11-30-claude-sonnet-4-5`.
    entryId: (date, model) =>
      registryId('anthropic', date, model.replace(/-\d{8}$/, '').replace(/\.0$/, '')),
    summary: (models) =>
      `Anthropic retires ${models.join(', ')} on the Claude API; requests to a retired model fail.`,
  },
  openai: {
    provider: 'openai',
    name: 'OpenAI',
    page: OPENAI_DEPRECATIONS,
    markdown: `${OPENAI_DEPRECATIONS}.md`,
    parse: parseOpenAiDeprecations,
    entryId: (date, model) => registryId('openai', date, model),
    summary: (models) =>
      `OpenAI shuts down ${models.join(', ')} on the API; requests to a shut-down model fail.`,
  },
  gemini: {
    provider: 'gemini',
    name: 'Gemini API',
    page: GEMINI_DEPRECATIONS,
    markdown: `${GEMINI_DEPRECATIONS}.md.txt`,
    parse: parseGeminiDeprecations,
    entryId: (date, model) => registryId('gemini', date, model),
    summary: (models) =>
      `Google shuts down ${models.join(', ')} on the Gemini API on this date at the earliest; requests to a shut-down model fail.`,
  },
};

export interface DeadlineSync {
  registry: DeadlineRegistry;
  added: string[];
  changed: string[];
  // Unchanged entries the page still confirms whose `checkedAt` had gone stale; it is now today.
  rechecked: string[];
  // Registry entries the page no longer lists. They are kept, never deleted automatically.
  missing: string[];
}

// Merges the page's retirements into one provider's model entries, one entry per shutdown date and
// recommendation. An entry whose date, replacement and page models are unchanged is kept as it is,
// including aliases a person added from another page; its `checkedAt` moves to today only once it
// is stale. New or changed entries get today's `checkedAt`. The registry names a replacement only
// when the page recommends exactly one model with nothing beside it; when the page offers several,
// a replacement a person chose among them is kept. Other providers, and SDK entries, are untouched.
export function syncDeadlines(
  registry: DeadlineRegistry,
  source: DeprecationSource,
  rows: Retirement[],
  today: string,
): DeadlineSync {
  const groups = new Map<string, Retirement[]>();
  for (const row of rows) {
    const key = [row.date, row.replacements.join(' '), row.note ?? ''].join('\t');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const existing = registry.deadlines.filter(
    (entry) => entry.provider === source.provider && entry.kind === 'model',
  );
  const now = new Date(`${today}T00:00:00Z`);
  const added: string[] = [];
  const changed: string[] = [];
  const rechecked: string[] = [];
  const updated = new Map<string, DeadlineEntry>();
  const appended: DeadlineEntry[] = [];
  const matched = new Set<string>();
  for (const group of groups.values()) {
    const { date, replacements, note } = group[0];
    const models = [...new Set(group.map((row) => row.model))];
    // The entry that already lists one of these models, so a moved date updates it in place.
    const previous = existing.find((entry) =>
      models.some((model) => entry.versions.includes(model)),
    );
    // One entry's models now on different dates or replacements: merging either group into it
    // would move the other's models too, so a person splits the entry.
    if (previous && matched.has(previous.id))
      throw new PipelineInputError(
        `${source.name}'s page splits registry entry ${previous.id} across retirement dates or replacements; update it by hand.`,
      );
    if (previous) matched.add(previous.id);
    const replacement =
      replacements.length === 1 && !note
        ? replacements[0]
        : !note && previous?.replacement && replacements.includes(previous.replacement)
          ? previous.replacement
          : null;
    if (
      previous &&
      previous.date === date &&
      previous.replacement === replacement &&
      models.every((model) => previous.versions.includes(model))
    ) {
      if (-daysUntil(previous.checkedAt, now) > STALE_CHECK_DAYS) {
        rechecked.push(previous.id);
        updated.set(previous.id, { ...previous, checkedAt: today });
      }
      continue;
    }
    const recommended =
      replacement === null && (note || replacements.length)
        ? ` The page recommends: ${note ?? replacements.join(' or ')}.`
        : '';
    const id = previous?.id ?? source.entryId(date, models[0]);
    const entry: DeadlineEntry = {
      id,
      provider: source.provider,
      kind: 'model',
      versions: [...new Set([...models, ...(previous?.versions ?? [])])],
      date,
      summary: `${source.summary(models)}${recommended}`,
      replacement,
      source: source.page,
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
    rechecked,
    missing,
  };
}
