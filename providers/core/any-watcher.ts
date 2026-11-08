// Watches any provider the inventory finds, not only the ones with a folder in providers/. The agent
// finds the provider's changelog, deprecation and release-note pages from the inventory's hints, the
// package registries and the web, reads them with the page tools, and writes ProviderChange[] with
// exact source quotes. A provider folder, when one exists, is a head start: its prompt, knowledge and
// starting pages. Code only fetches, checks quotes and output shape, and never decides relevance.

import type { ProviderChange, ProviderHints, WatchProvider } from '../../shared/types.ts';
import type { LoopTool } from './agent.ts';
import { httpFetcher, type FetchedPage } from './fetch.ts';
import { budgetFromEnv, type ServerTool } from './model.ts';
import {
  githubRepo,
  packageName,
  registryClient,
  releaseNotesFor,
  renderPackage,
  type NotesResult,
  type PackageInfo,
  type PackageRegistry,
} from './packages.ts';
import { PageReader } from './page-tools.ts';
import { anyWatchSystemPrompt, anyWatchUserPrompt } from './prompt.ts';
import {
  folderHints,
  listProviderIds,
  loadProvider,
  mergeHints,
  PROVIDERS_DIR,
} from './folders.ts';
import type { LoadedProvider, ProviderSource, WatchReport } from './types.ts';
import {
  NO_SUBMISSION,
  WatchFailedError,
  runWatchAgent,
  slug,
  type ChangeShape,
  type WatchDeps,
} from './watcher.ts';

export type WebSearchOption = { type?: string; maxUses?: number };

/** What a watcher for more than API providers adds to a read: its own brief, feeds and change shape. */
export type WatchExtension<C> = {
  /** Replaces the API watcher's system prompt. */
  system?: (input: { name: string; prompt: string; webSearch: boolean }) => string;
  /** Added to the task. */
  task?: string;
  /** More starting pages. */
  sources?: ProviderSource[];
  /** Feeds read before the agent starts, listed among the sources, so quotes from them check. */
  pages?: FetchedPage[];
  shape?: ChangeShape<C>;
};

export type AnyWatchDeps<C = ProviderChange> = WatchDeps & {
  /** npm and PyPI lookups; tests and replays pass saved ones. */
  registry?: PackageRegistry;
  /** Where provider folders live, for the head start. */
  root?: string;
  /** Anthropic's server-side web search. On unless false. */
  webSearch?: false | WebSearchOption;
  /** Packages looked up before the agent starts; the agent can look up more itself. */
  maxPackages?: number;
  onReport?: (report: AnyWatchReport<C>) => void;
  extend?: WatchExtension<C>;
  /** Called with the pages the run read, so a caller can save them as fixtures. */
  onPages?: (reader: PageReader) => void;
};

export type AnyWatchReport<C = ProviderChange> = WatchReport<C> & {
  /** The provider's display name: the folder's name, or the provider id as the inventory wrote it. */
  name: string;
  hints: ProviderHints;
  /** The provider folder used as a head start, if any. */
  folder?: string;
  /** What the registries said about each package, as the agent saw it. */
  packages: PackageInfo[];
  startingPages: string[];
  /** What could not be read: failed registry lookups and pages. */
  errors: string[];
};

// Three searches a call: enough to find a provider's pages, and a small part of a call's worst case.
/** The issue for a read where no page loaded and nothing was found: an empty list that proves nothing. */
export const NOTHING_READ = 'no page could be read, so finding no changes proves nothing';

export const DEFAULT_WEB_SEARCH: Required<WebSearchOption> = {
  type: 'web_search_20250305',
  maxUses: 3,
};

const SKIP_LLMS_HOSTS =
  /(^|\.)(github\.com|githubusercontent\.com|npmjs\.com|npmjs\.org|pypi\.org)$/;

/** "google-gemini" reads as "Google Gemini"; anything else (a host, mixed case) stays as written. */
export function displayName(provider: string): string {
  const trimmed = provider.trim();
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(trimmed)
    ? trimmed
        .split('-')
        .map((word) => word[0].toUpperCase() + word.slice(1))
        .join(' ')
    : trimmed;
}

/** The folder for a provider id, when providers/ has one. */
function folderFor(id: string, root: string): LoadedProvider | undefined {
  let ids: string[];
  try {
    ids = listProviderIds(root);
  } catch {
    return undefined; // no providers/ to look in
  }
  // A folder that exists but does not load (bad JSON, wrong id) fails the read, rather than
  // being watched without its pages, prompt and knowledge.
  return ids.includes(id) ? loadProvider(id, root) : undefined;
}

function httpsUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    if (parsed.protocol !== 'https:') return undefined;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

class Sources {
  readonly list: ProviderSource[] = [];
  private readonly urls = new Set<string>();
  private readonly ids = new Set<string>();
  add(source: ProviderSource): void {
    if (this.urls.has(source.url)) return;
    let id = slug(source.id).slice(0, 60);
    for (let n = 2; this.ids.has(id); n++) id = `${slug(source.id).slice(0, 56)}-${n}`;
    this.urls.add(source.url);
    this.ids.add(id);
    this.list.push({ ...source, id });
  }
}

const registryPage = (info: PackageInfo): FetchedPage => ({
  url: info.registryUrl,
  status: 200,
  ok: true,
  fetchedAt: `${info.readAt}T00:00:00.000Z`,
  contentType: 'text/plain',
  // Registry facts only: release-notes excerpts are checked against the pages they came from.
  text: renderPackage(info),
});

/** Looks packages up and reads the release notes of each major, registering every page with the reader. */
async function readPackages(
  names: string[],
  registry: PackageRegistry,
  reader: PageReader,
  sources: Sources,
): Promise<{ infos: PackageInfo[]; rendered: string[]; errors: string[] }> {
  const looked = await Promise.all(
    names.map(async (pinned) => {
      const name = packageName(pinned);
      const lookup = await registry.lookup(pinned).catch((error: unknown) => ({
        name,
        found: [] as PackageInfo[],
        errors: [`${name}: ${error instanceof Error ? error.message : String(error)}`],
      }));
      const found = await Promise.all(
        lookup.found.map(async (info) => {
          const notes: NotesResult = await releaseNotesFor(info, (url, format) =>
            reader.read(url, format),
          ).catch((error: unknown) => ({
            notes: [],
            sources: [],
            missing: info.majors.slice(0, -1).map((line) => line.first),
            errors: [
              `release notes lookup failed: ${error instanceof Error ? error.message : String(error)}`,
            ],
          }));
          return { info, notes };
        }),
      );
      return { name, lookup, found };
    }),
  );
  const infos: PackageInfo[] = [];
  const rendered: string[] = [];
  const errors = looked.flatMap(({ lookup }) => lookup.errors);
  for (const { name, lookup, found } of looked) {
    for (const { info, notes } of found) {
      infos.push(info);
      const page = registryPage(info);
      reader.add(page);
      reader.shown(page.url, 0, page.text.length);
      for (const note of notes.notes)
        reader.shown(note.url, note.offset, note.offset + note.excerpt.length);
      for (const source of notes.sources) sources.add(source);
      rendered.push(renderPackage(info, notes));
    }
    // A module path (github.com/owner/repo/v2) has no registry here, but its repository has releases.
    const repo = lookup.found.length === 0 ? githubRepo(`https://${name}`) : undefined;
    if (repo) {
      sources.add({
        id: `${repo.repo}-releases`,
        kind: 'sdk-releases',
        url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`,
        format: 'github-releases',
        note: `GitHub releases of ${repo.owner}/${repo.repo} (package ${name})`,
      });
    }
    if (lookup.found.length === 0)
      rendered.push(
        `### ${name}\nNot found in npm or PyPI${lookup.errors.length ? ` (${lookup.errors.join('; ')})` : ''}.${repo ? ` It names the repository ${repo.url}; its releases are a starting page.` : ' It may live in another registry; search for its release notes.'}`,
      );
    else if (lookup.errors.length)
      rendered.push(`Lookup problems for ${name}: ${lookup.errors.join('; ')}`);
  }
  return { infos, rendered, errors };
}

function lookupTool(
  registry: PackageRegistry,
  reader: PageReader,
  sources: Sources,
  infos: PackageInfo[],
): LoopTool {
  return {
    name: 'lookup_package',
    description:
      'Look a package up in npm and PyPI: its versions by major line, deprecation, repository, and the release notes of each major. Use it for a package you find while reading, such as a replacement SDK. New pages it finds are added to list_sources.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The package name as a manifest spells it.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(input) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) return { content: 'Give a package name.', isError: true };
      // reader.sources is sources.list, so pages found here show up in list_sources.
      const { infos: found, rendered } = await readPackages([name], registry, reader, sources);
      infos.push(...found);
      return { content: rendered.join('\n\n') };
    },
  };
}

/**
 * One read of any provider: discovery, registry lookups, then the watcher
 * agent. The provider id is the inventory's (lowercased), so changes match its
 * usages. When providers/ has a folder for it, the folder's hints join the
 * given ones and its prompt, knowledge and pages are the head start.
 */
export async function runAnyWatch<C = ProviderChange>(
  provider: string,
  given: ProviderHints = {},
  since?: string,
  deps: AnyWatchDeps<C> = {},
): Promise<AnyWatchReport<C>> {
  const id = provider.trim().toLowerCase();
  const budget = deps.budget ?? budgetFromEnv();
  const folder = folderFor(id, deps.root ?? PROVIDERS_DIR);
  const hints = folder ? mergeHints(folderHints(folder), given) : given;
  const name = folder?.name ?? displayName(provider);
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const registry = deps.registry ?? registryClient();

  const sources = new Sources();
  for (const source of [...(folder?.sources ?? []), ...(deps.extend?.sources ?? [])])
    sources.add(source);
  const docs = (hints.docsUrls ?? []).map(httpsUrl).filter((url): url is string => Boolean(url));
  docs.forEach((url, i) =>
    sources.add({
      id: `docs-${i + 1}`,
      kind: 'other',
      url,
      note: 'a docs URL the codebase reader saw',
    }),
  );
  for (const host of new Set(docs.map((url) => new URL(url).hostname))) {
    if (SKIP_LLMS_HOSTS.test(host)) continue;
    sources.add({
      id: `llms-${host}`,
      kind: 'other',
      url: `https://${host}/llms.txt`,
      format: 'markdown',
      note: `index of ${host}'s pages, if the site has one`,
    });
  }

  const reader = new PageReader(deps.fetcher ?? httpFetcher(), sources.list);
  for (const page of deps.extend?.pages ?? []) reader.add(page);
  const maxPackages = deps.maxPackages ?? 8;
  const names = [...new Set((hints.packages ?? []).map((p) => p.trim()).filter(Boolean))];
  const {
    infos,
    rendered,
    errors: lookupErrors,
  } = await readPackages(names.slice(0, maxPackages), registry, reader, sources);
  if (names.length > maxPackages)
    rendered.push(
      `Not looked up yet (use lookup_package if they matter): ${names.slice(maxPackages).join(', ')}`,
    );

  const webSearch =
    deps.webSearch === false ? undefined : { ...DEFAULT_WEB_SEARCH, ...deps.webSearch };
  const serverTools: ServerTool[] | undefined = webSearch
    ? [{ type: webSearch.type, name: 'web_search', max_uses: webSearch.maxUses }]
    : undefined;

  const report = await runWatchAgent<C>(
    {
      provider: id,
      label: `watch-any:${id}`,
      reader,
      system: (withServerTools) =>
        (deps.extend?.system ?? anyWatchSystemPrompt)({
          name,
          prompt: folder?.prompt ?? '',
          webSearch: withServerTools,
        }),
      shape: deps.extend?.shape,
      prompt: `${anyWatchUserPrompt({
        name,
        since,
        today,
        budgetUsd: budget.capUsd - budget.spentUsd,
        hints,
        sources: sources.list,
        packages: rendered,
        knowledge: folder?.knowledge,
      })}${deps.extend?.task ? `\n\n${deps.extend.task}` : ''}`,
      tools: [lookupTool(registry, reader, sources, infos)],
      serverTools,
    },
    { ...deps, budget, maxTurns: deps.maxTurns ?? 20 },
  );
  deps.onPages?.(reader);
  // An empty result is only "nothing changed" if something was read: with every fetch failed it means nothing.
  const alreadyGiven = new Set([
    ...infos.map((info) => info.registryUrl),
    ...(deps.extend?.pages ?? []).map((page) => page.url),
  ]);
  const loaded = report.sourcesRead.filter((url) => !alreadyGiven.has(url));
  const issues =
    loaded.length === 0 &&
    report.changes.length === 0 &&
    !report.issues.some((issue) => issue.message === NO_SUBMISSION)
      ? [...report.issues, { message: NOTHING_READ }]
      : report.issues;
  return {
    ...report,
    issues,
    name,
    hints,
    ...(folder ? { folder: folder.id } : {}),
    packages: infos,
    startingPages: sources.list.map((source) => source.url),
    // A 404 on a page guessed along the way (a CHANGELOG.md), or on a starting page built from a
    // guessed name (endoflife.date/api/flask.json), is not a gap; on any other starting page it is.
    errors: [
      ...lookupErrors,
      ...[...reader.pages.values()]
        .filter(
          (page) =>
            !page.ok &&
            (page.status !== 404 ||
              sources.list.some((source) => source.url === page.url && !source.guess)),
        )
        .map((page) => `${page.url}: ${page.error ?? `HTTP ${page.status}`}`),
    ],
  };
}

/**
 * The entry point other folders use (O4's loop, F6's runner): a WatchProvider
 * for any provider, led by the inventory's hints. WatchProvider returns only
 * changes, so pass onReport to keep the issues, cost and log; a run that never
 * submitted throws WatchFailedError, so "no changes" is never a silent failure.
 */
export function anyProviderWatcher(
  provider: string,
  hints: ProviderHints = {},
  deps: AnyWatchDeps = {},
): WatchProvider {
  return async (since?: string) => {
    const report = await runAnyWatch(provider, hints, since, deps);
    deps.onReport?.(report);
    if (
      report.issues.some(
        (issue) => issue.message === NO_SUBMISSION || issue.message === NOTHING_READ,
      )
    ) {
      throw new WatchFailedError(report);
    }
    return report.changes;
  };
}
