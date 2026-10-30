import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { daysUntil, type DeadlineEntry, type DeadlineRegistry } from './deadline-registry.ts';
import { DEPRECATION_SOURCES, syncDeadlines } from './deadline-sync.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Saved copies of the model deprecation pages the registry's AI entries come from, as the provider
// served them, so every entry can be checked against the exact text it was read from.
export const DEPRECATION_PAGES = new URL('../docs/benchmarks/deprecation-pages/', import.meta.url);
export const SOURCE_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];
// A saved page older than this many days is flagged, like a stale `checkedAt`.
export const STALE_PAGE_DAYS = 30;

export interface SavedPage {
  provider: SourceProvider;
  // A changelog that records shutdowns the deprecations page no longer lists, such as Gemini 1.5.
  role?: 'changelog';
  url: string;
  fetchedAt: string;
  sha256: string;
}

export interface SourceIndex {
  formatVersion: 1;
  pages: SavedPage[];
}

// One registry entry and the page line that names each of its models with its replacement.
export interface EntryEvidence {
  id: string;
  provider: SourceProvider;
  // The table row for each model, verbatim.
  quotes: Record<string, string>;
  // Undated aliases the page names only by their dated snapshot, such as `claude-sonnet-4-5` for
  // `claude-sonnet-4-5-20250929`: alias → the snapshot whose row proves it.
  aliases: Record<string, string>;
  // The page offers several replacements and a person chose this one; drafts say so.
  chosenAmong: string[] | null;
}

export interface SourceCheck {
  errors: string[];
  warnings: string[];
  evidence: EntryEvidence[];
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const pageFile = (provider: SourceProvider, role?: 'changelog') =>
  new URL(`${provider}${role ? `-${role}` : ''}.md`, DEPRECATION_PAGES);
// Changelogs entries may cite for models the deprecations page has dropped. Such an entry names no
// replacement (the changelog gives none), so it only ever stops or alerts.
export const SHUTDOWN_CHANGELOGS: Partial<Record<SourceProvider, string>> = {
  gemini: 'https://ai.google.dev/gemini-api/docs/changelog',
};
const INDEX = new URL('index.json', DEPRECATION_PAGES);

function parseIndex(text: string): SourceIndex {
  const value = parseObject(text, 'Deprecation page index');
  if (value.formatVersion !== 1 || !Array.isArray(value.pages))
    throw new PipelineInputError('Deprecation page index requires formatVersion: 1 and pages.');
  const pages = value.pages.map((page, index) => {
    if (
      !isObject(page) ||
      !SOURCE_PROVIDERS.includes(page.provider as SourceProvider) ||
      typeof page.url !== 'string' ||
      typeof page.fetchedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(page.fetchedAt) ||
      typeof page.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(page.sha256) ||
      (Object.hasOwn(page, 'role') && page.role !== 'changelog')
    )
      throw new PipelineInputError(`Deprecation page index entry ${index} is malformed.`);
    return page as unknown as SavedPage;
  });
  return { formatVersion: 1, pages };
}

export async function readSourceIndex(): Promise<SourceIndex> {
  try {
    return parseIndex(await readFile(INDEX, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { formatVersion: 1, pages: [] };
    throw error;
  }
}

// Saves the page a sync just read, beside the registry it writes, and records its hash.
export async function savePage(provider: SourceProvider, text: string, today: string) {
  const index = await readSourceIndex();
  const page: SavedPage = {
    provider,
    url: DEPRECATION_SOURCES[provider].download,
    fetchedAt: today,
    sha256: sha256(text),
  };
  const pages = [...index.pages.filter((item) => item.provider !== provider), page].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
  await writeFile(pageFile(provider), text);
  await writeFile(INDEX, `${JSON.stringify({ formatVersion: 1, pages }, null, 2)}\n`);
}

// The page lines that name `model` in backticks: its table rows.
const rowsNaming = (lines: string[], model: string) =>
  lines.filter((line) => line.startsWith('|') && line.includes(`\`${model}\``));

// Checks every OpenAI, Anthropic and Gemini model entry against the saved page it cites: the page
// must be unchanged since it was saved (SHA-256), re-reading it must reproduce the entry exactly
// (no entry to add or change), and every model with a replacement must sit on a table row that
// names that replacement. Nothing is fetched.
export function checkSources(
  registry: DeadlineRegistry,
  index: SourceIndex,
  pages: Partial<Record<SourceProvider, string>>,
  now: Date,
  providers: readonly SourceProvider[] = SOURCE_PROVIDERS,
  changelogs: Partial<Record<SourceProvider, string>> = {},
): SourceCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const evidence: EntryEvidence[] = [];
  for (const provider of providers) {
    const source = DEPRECATION_SOURCES[provider];
    const saved = index.pages.find((page) => page.provider === provider && !page.role);
    const text = pages[provider];
    if (!saved || text === undefined) {
      errors.push(`${source.name}: no saved deprecation page; run --sync ${provider} --write.`);
      continue;
    }
    if (sha256(text) !== saved.sha256) {
      errors.push(`${source.name}: the saved page does not match its recorded SHA-256.`);
      continue;
    }
    if (-daysUntil(saved.fetchedAt, now) > STALE_PAGE_DAYS)
      warnings.push(`${source.name}: the saved page is from ${saved.fetchedAt}; sync it again.`);
    const page = source.parse(text);
    const sync = syncDeadlines(registry, source, page.rows, saved.fetchedAt);
    for (const id of [...sync.added, ...sync.changed])
      errors.push(
        `${source.name}: the saved page does not reproduce registry entry ${id}; run --sync ${provider} --write.`,
      );
    const lines = text.split('\n').map((line) => line.trim());
    const entries = registry.deadlines.filter(
      (entry): entry is DeadlineEntry => entry.provider === provider && entry.kind === 'model',
    );
    for (const entry of entries) {
      if (entry.source && entry.source === SHUTDOWN_CHANGELOGS[provider]) {
        const quotes = changelogShutdown(index, changelogs[provider], provider, entry, errors);
        if (quotes)
          evidence.push({ id: entry.id, provider, quotes, aliases: {}, chosenAmong: null });
        continue;
      }
      if (entry.source !== source.page) {
        errors.push(`${entry.id}: cites ${entry.source}, not ${source.page}.`);
        continue;
      }
      const quotes: Record<string, string> = {};
      const aliases: Record<string, string> = {};
      let chosenAmong: string[] | null = null;
      for (const model of entry.versions) {
        const rows = rowsNaming(lines, model);
        const row = entry.replacement
          ? rows.find((line) => line.includes(`\`${entry.replacement}\``))
          : rows[0];
        const snapshot = entry.versions.find((version) =>
          new RegExp(`^${model.replace(/[.]/g, '\\.')}-\\d{8}$`).test(version),
        );
        if (!row && !rows.length && snapshot) {
          aliases[model] = snapshot;
          continue;
        }
        if (!row) {
          // A model listed in prose, not a table row, is kept only without a replacement to prove.
          if (entry.replacement || !text.includes(`\`${model}\``))
            errors.push(
              `${entry.id}: no table row on the saved ${source.name} page names ${model}${entry.replacement ? ` with ${entry.replacement}` : ''}.`,
            );
          continue;
        }
        quotes[model] = row;
        const offered = page.rows.find((item) => item.version === model)?.replacements ?? [];
        if (entry.replacement && offered.length > 1) chosenAmong = offered;
      }
      for (const [alias, snapshot] of Object.entries(aliases))
        if (!quotes[snapshot])
          errors.push(`${entry.id}: ${alias} stands for ${snapshot}, which no row proves.`);
      evidence.push({ id: entry.id, provider, quotes, aliases, chosenAmong });
    }
  }
  return { errors, warnings, evidence };
}

export async function loadSourcePages() {
  const index = await readSourceIndex();
  const pages: Partial<Record<SourceProvider, string>> = {};
  const changelogs: Partial<Record<SourceProvider, string>> = {};
  for (const page of index.pages)
    (page.role ? changelogs : pages)[page.provider] = await readFile(
      pageFile(page.provider, page.role),
      'utf8',
    );
  return { index, pages, changelogs };
}

// An entry citing a changelog: the saved changelog must match its hash, the entry must name no
// replacement (the changelog gives none), and every model must be listed in backticks within six
// lines under a line that says the models are shut down.
function changelogShutdown(
  index: SourceIndex,
  text: string | undefined,
  provider: SourceProvider,
  entry: DeadlineEntry,
  errors: string[],
): Record<string, string> | undefined {
  const saved = index.pages.find((page) => page.provider === provider && page.role === 'changelog');
  if (!saved || text === undefined)
    return void errors.push(`${entry.id}: cites the ${provider} changelog, which is not saved.`);
  if (sha256(text) !== saved.sha256)
    return void errors.push(
      `${entry.id}: the saved ${provider} changelog does not match its SHA-256.`,
    );
  if (entry.replacement !== null)
    return void errors.push(
      `${entry.id}: a changelog names no replacement, so the entry must not.`,
    );
  const lines = text.split('\n');
  const quotes: Record<string, string> = {};
  for (const model of entry.versions) {
    const at = lines.findIndex((line) => line.trim() === `- \`${model}\``);
    const window = at < 0 ? [] : lines.slice(Math.max(0, at - 6), at);
    const heading = [...window].reverse().find((line) => /now shut down/.test(line));
    if (!heading)
      errors.push(
        `${entry.id}: the saved ${provider} changelog does not list ${model} as shut down.`,
      );
    else quotes[model] = heading.trim();
  }
  return quotes;
}
