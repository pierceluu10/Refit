// package_lookup: a package's versions, deprecations and release notes from npm or PyPI, plus the
// GitHub releases or CHANGELOG of its repository. It reports what the registries say; whether a
// release matters to the repo is the agent's call.

import type { AgentTool } from '../../shared/types.ts';
import { fetchPage, type NetworkOptions } from './fetch.ts';
import { pageToText, splitEntries, type Entry, type PageStore } from './pages.ts';
import { rank } from './text.ts';
import { defineTool, num, str } from './tool.ts';
import {
  compareVersions,
  isPrerelease,
  majorOf,
  parseVersion,
  versionFromTag,
} from './versions.ts';

export type Ecosystem = 'npm' | 'pypi';

export type PackageVersion = {
  version: string;
  date?: string;
  deprecated?: string;
  yanked?: string;
  prerelease: boolean;
};

export type PackageInfo = {
  ecosystem: Ecosystem;
  name: string;
  page: string;
  latest?: string;
  summary?: string;
  repository?: string;
  /** Subfolder of a monorepo that holds the package, when the registry says. */
  directory?: string;
  changelogUrls: string[];
  versions: PackageVersion[];
  /** A deprecation of the whole package (npm: the latest version's message; PyPI: inactive). */
  packageNote?: string;
  runtime?: string;
};

export type ReleaseNote = {
  version: string;
  date?: string;
  title: string;
  url?: string;
  text: string;
};

export type ReleaseNotes = { source: string; notes: ReleaseNote[]; tried: string[] };

const REGISTRY_TIMEOUT_MS = 30_000;

/** "git+https://github.com/o/r.git", "github:o/r" or "https://github.com/o/r/tree/main/x" -> https://github.com/o/r */
export function githubRepo(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
  if (shorthand && !url.includes('://')) {
    return `https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/, '')}`;
  }
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

/** A github.com blob link to its raw.githubusercontent.com form, so the text can be read. */
export function rawGithubUrl(url: string): string {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/(.+)$/.exec(url);
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : url;
}

type NpmPackument = {
  name?: string;
  description?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<
    string,
    { deprecated?: string; engines?: Record<string, string>; repository?: unknown }
  >;
  time?: Record<string, string>;
  repository?: { url?: string; directory?: string } | string;
  homepage?: string;
};

export function npmInfo(name: string, json: NpmPackument): PackageInfo {
  const latest = json['dist-tags']?.latest;
  const repo = typeof json.repository === 'string' ? { url: json.repository } : json.repository;
  const versions = Object.entries(json.versions ?? {}).map(([version, meta]) => ({
    version,
    date: json.time?.[version]?.slice(0, 10),
    deprecated:
      typeof meta?.deprecated === 'string' && meta.deprecated ? meta.deprecated : undefined,
    prerelease: isPrerelease(version),
  }));
  const repository = githubRepo(repo?.url) ?? githubRepo(json.homepage);
  const latestMeta = latest ? json.versions?.[latest] : undefined;
  const engines = latestMeta?.engines
    ? Object.entries(latestMeta.engines)
        .map(([engine, range]) => `${engine} ${range}`)
        .join(', ')
    : undefined;
  return {
    ecosystem: 'npm',
    name,
    page: `https://www.npmjs.com/package/${name}`,
    latest,
    summary: json.description,
    repository,
    directory: repo?.directory,
    changelogUrls: latest ? [`https://cdn.jsdelivr.net/npm/${name}@${latest}/CHANGELOG.md`] : [],
    versions,
    packageNote: latestMeta?.deprecated
      ? `the latest version is deprecated: ${latestMeta.deprecated}`
      : undefined,
    runtime: engines ? `latest needs ${engines}` : undefined,
  };
}

type PypiJson = {
  info?: {
    name?: string;
    version?: string;
    summary?: string;
    home_page?: string | null;
    project_urls?: Record<string, string> | null;
    requires_python?: string | null;
    classifiers?: string[];
    yanked?: boolean;
    yanked_reason?: string | null;
  };
  releases?: Record<
    string,
    {
      upload_time_iso_8601?: string;
      upload_time?: string;
      yanked?: boolean;
      yanked_reason?: string | null;
    }[]
  >;
};

export function pypiInfo(name: string, json: PypiJson): PackageInfo {
  const info = json.info ?? {};
  const urls = Object.entries(info.project_urls ?? {});
  const repository =
    urls.map(([, url]) => githubRepo(url)).find(Boolean) ?? githubRepo(info.home_page ?? undefined);
  const changelogUrls = urls
    .filter(([label, url]) =>
      /change|release|history|news|what'?s new|upgrad|migrat/i.test(`${label} ${url}`),
    )
    .map(([, url]) => rawGithubUrl(url));
  const versions = Object.entries(json.releases ?? {}).map(([version, files]) => {
    const first = files[0];
    const yanked = files.length > 0 && files.every((file) => file.yanked);
    return {
      version,
      date: (first?.upload_time_iso_8601 ?? first?.upload_time)?.slice(0, 10),
      yanked: yanked ? first?.yanked_reason || 'yanked (no reason given)' : undefined,
      prerelease: isPrerelease(version),
    };
  });
  const inactive = (info.classifiers ?? []).find((c) =>
    /Development Status :: 7 - Inactive/.test(c),
  );
  return {
    ecosystem: 'pypi',
    name: info.name ?? name,
    page: `https://pypi.org/project/${info.name ?? name}/`,
    latest: info.version,
    summary: info.summary,
    repository,
    changelogUrls,
    versions,
    packageNote: inactive ? `classified "${inactive}"` : undefined,
    runtime: info.requires_python ? `latest needs Python ${info.requires_python}` : undefined,
  };
}

export async function fetchPackage(
  ecosystem: Ecosystem,
  name: string,
  network: NetworkOptions,
): Promise<{ info?: PackageInfo; error?: string }> {
  const url =
    ecosystem === 'npm'
      ? `https://registry.npmjs.org/${name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`
      : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  const page = await fetchPage(url, {
    ...network,
    timeoutMs: network.timeoutMs ?? REGISTRY_TIMEOUT_MS,
    headers: { accept: 'application/json' },
  });
  if (!page.ok) {
    return { error: page.status === 404 ? `not found on ${ecosystem}` : `${url}: ${page.error}` };
  }
  try {
    const json = JSON.parse(page.text) as NpmPackument & PypiJson;
    return { info: ecosystem === 'npm' ? npmInfo(name, json) : pypiInfo(name, json) };
  } catch {
    return { error: `${url} did not return JSON` };
  }
}

function inRange(version: string, from?: string, to?: string): boolean {
  if (from && compareVersions(version, from) <= 0) return false;
  if (to && compareVersions(version, to) > 0) return false;
  return true;
}

function notesFromEntries(entries: Entry[], url: string): ReleaseNote[] {
  return entries
    .filter((entry) => entry.version)
    .map((entry) => ({
      version: entry.version as string,
      date: entry.date,
      title: entry.heading,
      url,
      text: entry.text,
    }));
}

type Release = {
  tag_name?: string;
  name?: string | null;
  published_at?: string | null;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
};

/**
 * Release notes for versions after `from` up to `to`: GitHub releases first, then the package's
 * CHANGELOG, then the releases feed. Each source tried is listed, so the agent can read more.
 */
export async function releaseNotes(
  info: PackageInfo,
  range: { from?: string; to?: string },
  network: NetworkOptions,
  store?: PageStore,
): Promise<ReleaseNotes> {
  const tried: string[] = [];
  const keep = (notes: ReleaseNote[]) =>
    notes.filter((note) => inRange(note.version, range.from, range.to));
  const repo = info.repository;
  const ownTags = (notes: ReleaseNote[], tags: string[]) => {
    // A monorepo tags each package ("sdk-v1.4.0", "vertex-sdk-v1.1.1"): keep the tags whose prefix
    // is this package's name, else the plain "v1.2.3" tags, else every release.
    const names = [info.name.toLowerCase(), info.name.replace(/^@[^/]+\//, '').toLowerCase()];
    const prefixes = tags.map((tag) =>
      tag
        .toLowerCase()
        .replace(/v?\d+\.\d+.*$/, '')
        .replace(/[-_@/]+$/, ''),
    );
    const named = notes.filter((_, i) => names.includes(prefixes[i]));
    if (named.length) return named;
    const plain = notes.filter((_, i) => prefixes[i] === '');
    return plain.length ? plain : notes;
  };

  if (repo) {
    const api = repo.replace('https://github.com/', 'https://api.github.com/repos/');
    const url = `${api}/releases?per_page=100`;
    tried.push(url);
    const page = await fetchPage(url, {
      ...network,
      headers: { accept: 'application/vnd.github+json' },
    });
    if (page.ok) {
      try {
        const releases = (JSON.parse(page.text) as Release[]).filter((r) => !r.draft);
        const withVersions = releases
          .map((release) => ({ release, version: versionFromTag(release.tag_name ?? '') }))
          .filter((item): item is { release: Release; version: string } => !!item.version);
        const notes = withVersions.map(({ release, version }) => ({
          version,
          date: release.published_at?.slice(0, 10),
          title: release.name || release.tag_name || version,
          url: release.html_url,
          text: (release.body ?? '').trim(),
        }));
        const mine = ownTags(
          notes,
          withVersions.map(({ release }) => release.tag_name ?? ''),
        );
        const kept = keep(mine);
        // Releases list newest first, 100 a page: an older pin may sit before the first page.
        if (kept.length || mine.length) {
          return { source: `GitHub releases of ${repo}`, notes: kept, tried };
        }
      } catch {
        // Not a releases list; try the changelog.
      }
    }
  }

  const changelogs = [...info.changelogUrls];
  if (repo)
    changelogs.push(
      `${repo.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/HEAD/CHANGELOG.md`,
    );
  for (const url of changelogs) {
    tried.push(url);
    const page = await fetchPage(url, network);
    if (!page.ok) continue;
    const text = pageToText(page.text, page.contentType, page.url);
    store?.add({ url: page.url, title: `${info.name} changelog`, text, origin: 'fetched now' });
    const notes = notesFromEntries(splitEntries(text), page.url);
    if (notes.length) return { source: `changelog ${page.url}`, notes: keep(notes), tried };
  }

  if (repo) {
    const url = `${repo}/releases.atom`;
    tried.push(url);
    const page = await fetchPage(url, network);
    if (page.ok) {
      const text = pageToText(page.text, 'application/atom+xml', url);
      const notes = notesFromEntries(splitEntries(text), url);
      if (notes.length) {
        return {
          source: `GitHub releases feed of ${repo} (latest entries only)`,
          notes: keep(notes),
          tried,
        };
      }
    }
  }
  return { source: 'none found', notes: [], tried };
}

function majorsReport(info: PackageInfo): string[] {
  const majors = new Map<number, PackageVersion[]>();
  for (const v of info.versions) {
    const major = parseVersion(v.version)?.major;
    if (major === undefined || v.prerelease) continue;
    majors.set(major, [...(majors.get(major) ?? []), v]);
  }
  return [...majors.entries()]
    .sort(([a], [b]) => b - a)
    .slice(0, 8)
    .map(([major, list]) => {
      const sorted = [...list].sort((a, b) => compareVersions(a.version, b.version));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const deprecated = sorted.filter((v) => v.deprecated).length;
      const yanked = sorted.filter((v) => v.yanked).length;
      const flags = [
        deprecated ? `${deprecated === sorted.length ? 'all' : deprecated} deprecated` : '',
        yanked ? `${yanked} yanked` : '',
      ].filter(Boolean);
      return `- ${major}.x: ${first.version}${first.date ? ` (${first.date})` : ''} to ${last.version}${last.date ? ` (${last.date})` : ''}, ${sorted.length} release(s)${flags.length ? `; ${flags.join(', ')}` : ''}`;
    });
}

function deprecationReport(info: PackageInfo, pinned?: string): string[] {
  const out: string[] = [];
  if (info.packageNote) out.push(`Package: ${info.packageNote}`);
  const messages = new Map<string, string[]>();
  for (const v of info.versions) {
    const note = v.deprecated ?? (v.yanked ? `yanked: ${v.yanked}` : undefined);
    if (note) messages.set(note, [...(messages.get(note) ?? []), v.version]);
  }
  const pinnedVersion = pinned ? parseVersion(pinned) : undefined;
  if (pinnedVersion) {
    const exact = info.versions.find((v) => compareVersions(v.version, pinned as string) === 0);
    const note = exact?.deprecated ?? (exact?.yanked ? `yanked: ${exact.yanked}` : undefined);
    if (note) out.push(`The pinned version ${exact?.version} is marked: ${note}`);
  }
  const groups = [...messages.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  for (const [note, versions] of groups) {
    const sorted = [...versions].sort(compareVersions);
    const span =
      sorted.length > 1
        ? `${sorted[0]} .. ${sorted[sorted.length - 1]} (${sorted.length})`
        : sorted[0];
    out.push(`- ${span}: ${note.length > 300 ? `${note.slice(0, 300)}...` : note}`);
  }
  return out;
}

export type PackageLookupInput = {
  name: string;
  ecosystem?: Ecosystem;
  version?: string;
  target?: string;
  query?: string;
  limit?: number;
  notes?: boolean;
};

function formatNotes(
  notes: ReleaseNote[],
  input: { query?: string; limit: number; from?: string },
): string[] {
  let chosen = [...notes].sort((a, b) => compareVersions(b.version, a.version));
  const fromMajor = majorOf(input.from);
  // Under semver a major release may break things, and so may any 0.x minor release.
  const isMajor = (note: ReleaseNote) => {
    const v = parseVersion(note.version);
    if (!v || v.patch !== 0 || v.pre) return false;
    if (v.major === 0) return v.minor > 0;
    return v.minor === 0 && (fromMajor === undefined || v.major > fromMajor);
  };
  if (input.query) {
    const ranked = rank(input.query, chosen, (n) => `${n.title} ${n.text}`).map((r) => r.item);
    chosen = ranked.length ? ranked : chosen;
  }
  // Major releases carry the breaking changes, so they are kept first when the list is cut.
  const majors = chosen.filter(isMajor);
  const rest = chosen.filter((n) => !isMajor(n));
  const picked = [...majors, ...rest].slice(0, input.limit);
  const order = new Map(chosen.map((n, i) => [n, i]));
  picked.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return picked.map((note) => {
    const body =
      note.text.length > 1500
        ? `${note.text.slice(0, 1500)}\n[cut; read the rest at the link]`
        : note.text;
    const label = !isMajor(note)
      ? ''
      : parseVersion(note.version)?.major === 0
        ? ' [0.x minor: may break]'
        : ' [major]';
    return `## ${note.version}${note.date ? ` (${note.date})` : ''}${label}${note.url ? ` ${note.url}` : ''}\n${body || '(no notes text)'}`;
  });
}

export async function packageReport(
  input: PackageLookupInput,
  network: NetworkOptions,
  store?: PageStore,
): Promise<string> {
  const ecosystems: Ecosystem[] = input.ecosystem
    ? [input.ecosystem]
    : input.name.startsWith('@')
      ? ['npm']
      : ['npm', 'pypi'];
  const found: PackageInfo[] = [];
  const misses: string[] = [];
  for (const ecosystem of ecosystems) {
    const { info, error } = await fetchPackage(ecosystem, input.name, network);
    if (info) found.push(info);
    else misses.push(`${ecosystem}: ${error}`);
  }
  if (!found.length) {
    return [
      `No registry data for "${input.name}" (${misses.join('; ')}).`,
      'Check the exact package name in the manifest or lockfile, or pass "ecosystem". For other registries read the package page with fetch_url, or its changelog with fetch_changelog.',
    ].join('\n');
  }
  const out: string[] = [];
  if (found.length > 1) {
    out.push(
      `"${input.name}" exists on ${found.map((f) => f.ecosystem).join(' and ')}; showing ${found[0].ecosystem}. Pass "ecosystem" to pick.`,
    );
  }
  const info = found[0];
  const latestDate = info.versions.find((v) => v.version === info.latest)?.date;
  out.push(`${info.ecosystem} package ${info.name}: ${info.page}`);
  if (info.summary) out.push(info.summary.trim());
  out.push(
    `Latest: ${info.latest ?? 'unknown'}${latestDate ? ` (${latestDate})` : ''}. ${info.versions.length} versions published.${info.runtime ? ` The ${info.runtime}.` : ''}`,
  );
  if (info.repository) {
    out.push(
      `Repository: ${info.repository}${info.directory ? ` (folder ${info.directory})` : ''}`,
    );
  }
  const target = input.target ?? info.latest;
  const pinMajor = majorOf(input.version);
  const targetMajor = majorOf(target);
  if (input.version) {
    const behind =
      pinMajor !== undefined && targetMajor !== undefined ? targetMajor - pinMajor : undefined;
    out.push(
      `Pinned: ${input.version} (major ${pinMajor ?? '?'}); target ${target ?? '?'} (major ${targetMajor ?? '?'})${behind && behind > 0 ? `: ${behind} major version(s) to cross` : behind === 0 ? ': same major' : ''}.`,
    );
  }
  out.push('Majors, newest first:', ...majorsReport(info));
  const deprecations = deprecationReport(info, input.version);
  out.push(
    deprecations.length
      ? 'Deprecated or yanked:'
      : 'Deprecated or yanked: none recorded by the registry.',
  );
  out.push(...deprecations);

  if (input.notes !== false) {
    const from = input.version ? parseVersion(input.version) : undefined;
    const fromVersion = from
      ? `${from.major}.${from.minor}.${from.patch}${from.pre ? `-${from.pre}` : ''}`
      : undefined;
    const { source, notes, tried } = await releaseNotes(
      info,
      { from: fromVersion, to: target },
      network,
      store,
    );
    const limit = input.limit ?? 8;
    if (notes.length) {
      out.push(
        `\nRelease notes${fromVersion ? ` after ${fromVersion}` : ''}${target ? ` up to ${target}` : ''}, from ${source} (${notes.length} entries; showing up to ${limit}, majors first):`,
      );
      out.push(...formatNotes(notes, { query: input.query, limit, from: fromVersion }));
    } else {
      out.push(
        `\nNo release notes in range from ${source}. Tried: ${tried.join(', ') || 'nothing (no repository link)'}.`,
      );
    }
    if (tried.length) out.push(`Sources tried: ${tried.join(', ')}`);
  }
  out.push(
    "Registry data is current; release notes are the maintainers' words. Confirm a breaking change against the code and the migration guide before editing.",
  );
  return out.join('\n');
}

export function createPackageLookupTool(
  options: NetworkOptions & { store?: PageStore; packages?: string[] } = {},
): AgentTool {
  const { store, packages, ...network } = options;
  const known = packages?.length
    ? ` Packages the inventory saw for this provider: ${packages.join(', ')}.`
    : '';
  return defineTool({
    name: 'package_lookup',
    description: `Look up an SDK or library on npm or PyPI: latest version, each major line with dates, deprecated and yanked versions, the runtime the latest needs, and the release notes between the version the repo pins and the target (GitHub releases or the CHANGELOG, majors first). Informational.${known}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Package name, e.g. "stripe", "@anthropic-ai/sdk", "google-genai".',
        },
        ecosystem: {
          type: 'string',
          enum: ['npm', 'pypi'],
          description: 'Registry. Tries npm then PyPI when omitted.',
        },
        version: {
          type: 'string',
          description:
            'The version or range the repo pins, e.g. "^4.2.0" or "==1.30.1" (the lockfile has the exact one).',
        },
        target: { type: 'string', description: 'Version to move to. Defaults to the latest.' },
        query: {
          type: 'string',
          description: 'Rank release notes by these words, e.g. a method or option name.',
        },
        limit: { type: 'number', description: 'Release-note entries to show (default 8).' },
      },
      required: ['name'],
    },
    run: async (input) => {
      const name = str(input, 'name') ?? str(input, 'package') ?? str(input, 'query');
      if (!name)
        return 'Pass "name": the package as the manifest names it, e.g. "openai" or "@scope/sdk".';
      const ecosystemRaw = str(input, 'ecosystem')?.toLowerCase();
      const ecosystem: Ecosystem | undefined =
        ecosystemRaw === 'npm'
          ? 'npm'
          : ecosystemRaw && /pypi|pip|python/.test(ecosystemRaw)
            ? 'pypi'
            : undefined;
      return packageReport(
        {
          name: name.trim(),
          ecosystem,
          version: str(input, 'version'),
          target: str(input, 'target'),
          query: str(input, 'name') ? str(input, 'query') : undefined,
          limit: num(input, 'limit'),
        },
        network,
        store,
      );
    },
  });
}
