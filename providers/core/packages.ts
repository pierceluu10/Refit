// Package registries as an input to the watcher: which major versions an SDK has, when each began,
// whether it is deprecated, and where its release notes live. These are facts handed to the agent.
// The agent reads the notes and decides which majors break callers; nothing here decides that.

import { httpJsonFetcher, type FetchedPage, type JsonFetcher } from './fetch.ts';
import type { ProviderSource } from './types.ts';

export type Ecosystem = 'npm' | 'pypi';

/** One major version line of a package, from its stable releases. */
export type MajorLine = {
  major: number;
  first: string;
  firstAt?: string;
  latest: string;
  latestAt?: string;
  releases: number;
  /** npm's deprecation message on the line's latest release, word for word. */
  deprecated?: string;
};

export type PackageInfo = {
  ecosystem: Ecosystem;
  name: string;
  /** The registry's JSON metadata for the package. */
  registryUrl: string;
  /** The package's page for people. */
  pageUrl: string;
  /** YYYY-MM-DD the registry was read. */
  readAt: string;
  description?: string;
  latest?: string;
  latestAt?: string;
  /** npm's deprecation message on the latest release, word for word. */
  deprecated?: string;
  /** PyPI's "Development Status" classifier, e.g. "Development Status :: 7 - Inactive". */
  status?: string;
  repository?: string;
  /** Path of the package inside a monorepo, when the registry gives it. */
  repositoryDir?: string;
  homepage?: string;
  projectUrls?: Record<string, string>;
  /** Highest major first. */
  majors: MajorLine[];
  /** Prereleases newer than the latest stable release, e.g. a beta of the next major. */
  upcoming?: string[];
  versions: number;
};

export type PackageLookup = { name: string; found: PackageInfo[]; errors: string[] };

/** Looks a package name up in the registries it could belong to. Tests pass recorded ones. */
export interface PackageRegistry {
  lookup(name: string): Promise<PackageLookup>;
}

type Parsed = { major: number; minor: number; patch: number; pre: boolean };

/** Lenient semver and PEP 440 parsing: enough to group releases into major lines. */
export function parseVersion(version: string): Parsed | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/i.exec(version.trim());
  if (!match) return undefined;
  const rest = match[4] ?? '';
  if (rest && !/^([-+.]|a|b|c|rc|alpha|beta|pre|preview|dev|post)/i.test(rest)) return undefined;
  const pre = rest !== '' && !/^(\+|\.?post\d*$)/i.test(rest);
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre,
  };
}

function compare(a: Parsed, b: Parsed): number {
  return (
    a.major - b.major || a.minor - b.minor || a.patch - b.patch || Number(!a.pre) - Number(!b.pre)
  );
}

const day = (iso?: string) =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined;

type Release = { version: string; publishedAt?: string; deprecated?: string };

/** Groups stable releases into major lines, highest first, and lists prereleases newer than all of them. */
export function majorLines(releases: Release[]): { majors: MajorLine[]; upcoming: string[] } {
  const parsed = releases
    .map((release) => ({ release, v: parseVersion(release.version) }))
    .filter((entry): entry is { release: Release; v: Parsed } => entry.v !== undefined);
  const stable = parsed.filter((entry) => !entry.v.pre).sort((a, b) => compare(a.v, b.v));
  const lines = new Map<number, typeof stable>();
  for (const entry of stable)
    lines.set(entry.v.major, [...(lines.get(entry.v.major) ?? []), entry]);
  const majors: MajorLine[] = [...lines.entries()]
    .sort(([a], [b]) => b - a)
    .map(([major, entries]) => {
      const first = entries[0].release;
      const latest = entries[entries.length - 1].release;
      const line: MajorLine = {
        major,
        first: first.version,
        latest: latest.version,
        releases: entries.length,
      };
      const firstAt = day(first.publishedAt);
      const latestAt = day(latest.publishedAt);
      if (firstAt) line.firstAt = firstAt;
      if (latestAt) line.latestAt = latestAt;
      if (latest.deprecated) line.deprecated = latest.deprecated;
      return line;
    });
  const top = stable.at(-1)?.v;
  const upcoming = parsed
    .filter((entry) => entry.v.pre && (!top || compare(entry.v, top) > 0))
    .sort((a, b) => compare(b.v, a.v))
    .slice(0, 3)
    .map((entry) => entry.release.version);
  return { majors, upcoming };
}

export type GitHubRepo = { owner: string; repo: string; url: string; dir?: string };

/** The GitHub repository a registry's repository or homepage field points to, if any. */
export function githubRepo(url?: string, dir?: string): GitHubRepo | undefined {
  if (!url) return undefined;
  const match =
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?]|$)(?:(?:tree|blob)\/[^/]+\/([^#?]+))?/i.exec(
      url,
    ) ?? /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(url);
  if (!match) return undefined;
  const [owner, repo] = [match[1], match[2]];
  const path = (dir ?? match[3] ?? '').replace(/^\/+|\/+$/g, '');
  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
    ...(path ? { dir: path } : {}),
  };
}

const str = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Reads npm's full metadata document for one package. */
export function npmInfo(
  name: string,
  doc: unknown,
  registryUrl: string,
  readAt: string,
): PackageInfo {
  const d = (doc && typeof doc === 'object' ? doc : {}) as {
    name?: string;
    description?: string;
    homepage?: string;
    repository?: string | { url?: string; directory?: string };
    'dist-tags'?: Record<string, string>;
    time?: Record<string, string>;
    versions?: Record<string, { deprecated?: unknown; repository?: unknown }>;
  };
  const versions = d.versions ?? {};
  const time = d.time ?? {};
  const latest = d['dist-tags']?.latest;
  const repoField = d.repository ?? (latest ? versions[latest]?.repository : undefined);
  const repoUrl = typeof repoField === 'string' ? repoField : (repoField as { url?: string })?.url;
  const repoDir =
    typeof repoField === 'object' && repoField
      ? str((repoField as { directory?: string }).directory)
      : undefined;
  const repo = githubRepo(repoUrl, repoDir) ?? githubRepo(d.homepage);
  const { majors, upcoming } = majorLines(
    Object.entries(versions).map(([version, meta]) => ({
      version,
      publishedAt: time[version],
      deprecated: str(meta?.deprecated),
    })),
  );
  const info: PackageInfo = {
    ecosystem: 'npm',
    name: d.name ?? name,
    registryUrl,
    pageUrl: `https://www.npmjs.com/package/${d.name ?? name}`,
    readAt,
    majors,
    versions: Object.keys(versions).length,
  };
  const description = str(d.description);
  if (description) info.description = description;
  if (latest) info.latest = latest;
  const latestAt = latest ? day(time[latest]) : undefined;
  if (latestAt) info.latestAt = latestAt;
  const deprecated = latest ? str(versions[latest]?.deprecated) : undefined;
  if (deprecated) info.deprecated = deprecated;
  if (repo) info.repository = repo.url;
  if (repo?.dir) info.repositoryDir = repo.dir;
  const homepage = str(d.homepage);
  if (homepage) info.homepage = homepage;
  if (upcoming.length) info.upcoming = upcoming;
  return info;
}

/** Reads PyPI's JSON metadata document for one project. */
export function pypiInfo(
  name: string,
  doc: unknown,
  registryUrl: string,
  readAt: string,
): PackageInfo {
  const d = (doc && typeof doc === 'object' ? doc : {}) as {
    info?: {
      name?: string;
      summary?: string;
      version?: string;
      home_page?: string;
      project_urls?: Record<string, string> | null;
      classifiers?: string[];
    };
    releases?: Record<string, { upload_time_iso_8601?: string; yanked?: boolean }[]>;
  };
  const meta = d.info ?? {};
  const projectName = meta.name ?? name;
  const releases = Object.entries(d.releases ?? {})
    // A release with no files, or with every file yanked, cannot be installed.
    .filter(([, files]) => files.length > 0 && files.some((file) => !file.yanked))
    .map(([version, files]) => ({
      version,
      publishedAt: files
        .map((file) => file.upload_time_iso_8601 ?? '')
        .filter(Boolean)
        .sort()[0],
    }));
  const { majors, upcoming } = majorLines(releases);
  const projectUrls = meta.project_urls ?? undefined;
  const repo =
    Object.values(projectUrls ?? {})
      .map((url) => githubRepo(url))
      .find(Boolean) ?? githubRepo(meta.home_page);
  const info: PackageInfo = {
    ecosystem: 'pypi',
    name: projectName,
    registryUrl,
    pageUrl: `https://pypi.org/project/${projectName}/`,
    readAt,
    majors,
    versions: releases.length,
  };
  const description = str(meta.summary);
  if (description) info.description = description;
  if (meta.version) info.latest = meta.version;
  const latestAt = releases.find((release) => release.version === meta.version)?.publishedAt;
  if (day(latestAt)) info.latestAt = day(latestAt);
  const status = meta.classifiers?.find((c) => c.startsWith('Development Status'));
  if (status) info.status = status;
  if (repo) info.repository = repo.url;
  if (repo?.dir) info.repositoryDir = repo.dir;
  const homepage = str(meta.home_page) ?? str(projectUrls?.Homepage);
  if (homepage) info.homepage = homepage;
  if (projectUrls && Object.keys(projectUrls).length) info.projectUrls = projectUrls;
  if (upcoming.length) info.upcoming = upcoming;
  return info;
}

/** Which registries a manifest name can belong to. Scoped names are npm only; module paths none. */
export function registriesFor(name: string): Ecosystem[] {
  if (/^@[^/\s]+\/[^/\s]+$/.test(name)) return ['npm'];
  if (name.includes('/') || name.includes(':') || /\s/.test(name)) return [];
  return ['npm', 'pypi'];
}

export function npmRegistryUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
}

export function pypiRegistryUrl(name: string): string {
  return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
}

/** npm and PyPI over HTTP (or a recorded JsonFetcher). A 404 means "not in that registry". */
export function registryClient(
  options: { json?: JsonFetcher; today?: () => string } = {},
): PackageRegistry {
  const json = options.json ?? httpJsonFetcher();
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  return {
    async lookup(name) {
      const found: PackageInfo[] = [];
      const errors: string[] = [];
      await Promise.all(
        registriesFor(name).map(async (ecosystem) => {
          const url = ecosystem === 'npm' ? npmRegistryUrl(name) : pypiRegistryUrl(name);
          const result = await json.json(url);
          if (!result.ok) {
            if (result.status !== 404) errors.push(`${ecosystem} ${name}: ${result.error}`);
            return;
          }
          found.push(
            ecosystem === 'npm'
              ? npmInfo(name, result.data, url, today())
              : pypiInfo(name, result.data, url, today()),
          );
        }),
      );
      found.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem));
      return { name, found, errors };
    },
  };
}

/** A registry that answers from saved lookups, for replaying a recorded run. */
export function savedRegistry(saved: PackageInfo[]): PackageRegistry {
  return {
    async lookup(name) {
      const lower = name.toLowerCase();
      return {
        name,
        found: saved.filter((info) => info.name.toLowerCase() === lower),
        errors: [],
      };
    },
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The section of a changelog or release list about one version: from the first
 * heading that names it to the next heading of the same or a higher level.
 */
export function sectionFor(
  text: string,
  version: string,
  maxChars = 2_000,
  /** Only lines like this start and end a section, e.g. the release headings of a release list. */
  heading?: RegExp,
): { offset: number; text: string } | undefined {
  const token = new RegExp(`(^|[^0-9A-Za-z.])v?${escapeRegExp(version)}(?![0-9A-Za-z-]|\\.\\d)`);
  const lines = text.split('\n');
  let offset = 0;
  const starts = lines.map((line) => {
    const at = offset;
    offset += line.length + 1;
    return at;
  });
  const level = (line: string) =>
    heading ? (heading.test(line) ? 1 : 0) : (/^(#{1,6})\s/.exec(line)?.[1].length ?? 0);
  // A heading's link targets (compare/v1.0.0...v1.1.0) name other versions, so only its words count.
  const words = (line: string) => line.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, ' ');
  let index = lines.findIndex((line) => level(line) > 0 && token.test(words(line)));
  if (index === -1) index = lines.findIndex((line) => token.test(words(line)));
  if (index === -1) return undefined;
  const own = level(lines[index]) || 7;
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i++) {
    const l = level(lines[i]);
    if (l > 0 && l <= own) {
      end = i;
      break;
    }
  }
  const body = lines.slice(index, end).join('\n').trim();
  return {
    offset: starts[index],
    text: body.length > maxChars ? `${body.slice(0, maxChars)}\n[section continues]` : body,
  };
}

export type ReleaseNotes = { version: string; url: string; offset: number; excerpt: string };

export type NotesResult = {
  notes: ReleaseNotes[];
  /** Pages worth listing as starting pages: the changelog, the release list, the README. */
  sources: ProviderSource[];
  /** Versions whose notes were not found in the pages tried. */
  missing: string[];
};

const RAW = 'https://raw.githubusercontent.com';
/** A release heading in githubReleasesToText output: "## name (tag, published date)". */
export const RELEASE_HEADING = /^## .*\(.*, published [^)]*\)$/;

/** GitHub "blob" links to files become raw links, so the page is the file itself. */
export function rawGitHubUrl(url: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
  return match ? `${RAW}/${match[1]}/${match[2]}/${match[3]}` : url;
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'package';

/**
 * Reads the release notes of the first release of each major line (all but the
 * lowest line, which nothing upgrades into), newest first and at most `maxMajors`.
 * It tries the changelog the registry names, then the repository's CHANGELOG.md,
 * then its GitHub releases. Every page goes through `read`, so quotes from it check.
 */
export async function releaseNotesFor(
  info: PackageInfo,
  read: (url: string, format?: ProviderSource['format']) => Promise<FetchedPage>,
  options: { maxMajors?: number; maxChars?: number } = {},
): Promise<NotesResult> {
  const repo = githubRepo(info.repository, info.repositoryDir);
  const prefix = `${slugify(info.name)}-${info.ecosystem}`;
  const sources: ProviderSource[] = [];
  const wanted = info.majors.slice(0, -1).slice(0, options.maxMajors ?? 8);
  const named = Object.entries(info.projectUrls ?? {})
    .filter(([label]) => /change|release|history|news/i.test(label))
    .map(([, url]) => rawGitHubUrl(url))
    .filter((url) => url.startsWith('https://'));
  const changelogs = [
    ...named,
    ...(repo
      ? [
          `${RAW}/${repo.owner}/${repo.repo}/HEAD/${repo.dir ? `${repo.dir}/` : ''}CHANGELOG.md`,
          ...(repo.dir ? [`${RAW}/${repo.owner}/${repo.repo}/HEAD/CHANGELOG.md`] : []),
        ]
      : []),
  ];
  let changelog: FetchedPage | undefined;
  for (const url of [...new Set(changelogs)]) {
    const page = await read(url, url.endsWith('.md') ? 'markdown' : undefined);
    if (page.ok && page.text) {
      changelog = page;
      sources.push({
        id: `${prefix}-changelog`,
        kind: 'sdk-releases',
        url,
        ...(url.endsWith('.md') ? { format: 'markdown' as const } : {}),
        note: `Changelog of ${info.name} (${info.ecosystem})`,
      });
      break;
    }
  }
  const releasesUrl = repo
    ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`
    : undefined;
  if (releasesUrl)
    sources.push({
      id: `${prefix}-releases`,
      kind: 'sdk-releases',
      url: releasesUrl,
      format: 'github-releases',
      note: `GitHub releases of ${repo!.owner}/${repo!.repo}, newest first`,
    });
  if (repo)
    sources.push({
      id: `${prefix}-readme`,
      kind: 'other',
      url: `${RAW}/${repo.owner}/${repo.repo}/HEAD/${repo.dir ? `${repo.dir}/` : ''}README.md`,
      format: 'markdown',
      note: `README of ${info.name}: install notes, deprecation banners and docs links`,
    });

  const notes: ReleaseNotes[] = [];
  const missing: string[] = [];
  let releases: FetchedPage | undefined;
  for (const line of wanted) {
    let found = changelog && sectionFor(changelog.text, line.first, options.maxChars);
    let url = changelog?.url;
    if (!found && releasesUrl) {
      releases ??= await read(releasesUrl, 'github-releases');
      found = releases.ok
        ? sectionFor(releases.text, line.first, options.maxChars, RELEASE_HEADING)
        : undefined;
      url = releasesUrl;
    }
    if (found && url)
      notes.push({ version: line.first, url, offset: found.offset, excerpt: found.text });
    else missing.push(line.first);
  }
  return { notes, sources, missing };
}

/** A package as text for the agent's prompt. Strings from the registry are quoted as given. */
export function renderPackage(info: PackageInfo, notes?: NotesResult): string {
  const label = info.ecosystem === 'npm' ? 'npm' : 'PyPI';
  const lines = [
    `### ${label} package ${info.name}`,
    `Registry data: ${info.registryUrl} (read ${info.readAt}); page: ${info.pageUrl}`,
  ];
  if (info.description) lines.push(`Description: "${info.description}"`);
  lines.push(
    `Repository: ${info.repository ? `${info.repository}${info.repositoryDir ? ` (folder ${info.repositoryDir})` : ''}` : 'none given'}`,
  );
  if (info.homepage && info.homepage !== info.repository) lines.push(`Homepage: ${info.homepage}`);
  if (info.projectUrls) {
    const urls = Object.entries(info.projectUrls).map(([key, url]) => `${key} ${url}`);
    if (urls.length) lines.push(`Project links: ${urls.join('; ')}`);
  }
  lines.push(
    `Latest: ${info.latest ?? 'unknown'}${info.latestAt ? ` (published ${info.latestAt})` : ''}; ${info.versions} versions in the registry.`,
  );
  if (info.deprecated)
    lines.push(`Deprecated (registry message on the latest release): "${info.deprecated}"`);
  if (info.status) lines.push(`Classifier: "${info.status}"`);
  if (info.majors.length) {
    lines.push('Major lines (stable releases):');
    for (const line of info.majors) {
      lines.push(
        `- ${line.major}.x: ${line.first}${line.firstAt ? ` (${line.firstAt})` : ''} to ${line.latest}${line.latestAt ? ` (${line.latestAt})` : ''}, ${line.releases} release${line.releases === 1 ? '' : 's'}${line.deprecated ? `; deprecated: "${line.deprecated}"` : ''}`,
      );
    }
  } else lines.push('Major lines: no stable releases found.');
  if (info.upcoming?.length)
    lines.push(`Prereleases newer than the latest: ${info.upcoming.join(', ')}`);
  if (notes) {
    for (const note of notes.notes) {
      lines.push(
        `Release notes of ${note.version}, from ${note.url} (offset ${note.offset}):\n"""\n${note.excerpt}\n"""`,
      );
    }
    if (notes.missing.length)
      lines.push(
        `Release notes not found for: ${notes.missing.join(', ')} (tried the changelog and GitHub releases; look further if the version matters).`,
      );
  }
  return lines.join('\n');
}
