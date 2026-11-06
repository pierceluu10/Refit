// migration_guide, registry_diff and codemod: what the registries, release notes and official guides
// say about moving a package between two versions. Keyword picks are a head start, so each tool
// links the full source for the agent to read.

import { readFileSync } from 'node:fs';
import type { AgentTool } from '../../shared/types.ts';
import {
  compareVersions,
  defineTool,
  fetchPackage,
  fetchPage,
  pageToText,
  parseVersion,
  rank,
  releaseNotes,
  splitPassages,
  str,
  type Ecosystem,
  type PackageInfo,
  type ReleaseNote,
  type Version,
} from '../toolkit/index.ts';
import type { UpgradeToolOptions } from './options.ts';

const PACKAGE_INPUT = {
  type: 'object',
  properties: {
    package: { type: 'string', description: 'As the manifest names it, e.g. "next" or "django".' },
    from: { type: 'string', description: 'The version in use, e.g. "14.2.3" or "^14".' },
    to: { type: 'string', description: 'The target version. Defaults to the latest.' },
    ecosystem: {
      type: 'string',
      enum: ['npm', 'pypi'],
      description: 'Registry. Tries npm then PyPI when omitted.',
    },
  },
  required: ['package'],
};

async function findPackage(
  input: Record<string, unknown>,
  options: UpgradeToolOptions,
): Promise<{ info?: PackageInfo; misses: string[] }> {
  const name = str(input, 'package') ?? str(input, 'name') ?? '';
  const asked = str(input, 'ecosystem')?.toLowerCase();
  const ecosystems: Ecosystem[] = asked
    ? [/pypi|pip|python/.test(asked) ? 'pypi' : 'npm']
    : name.startsWith('@')
      ? ['npm']
      : ['npm', 'pypi'];
  const pin = str(input, 'from') ?? str(input, 'to');
  const misses: string[] = [];
  const found: PackageInfo[] = [];
  for (const ecosystem of ecosystems) {
    const { info, error } = await fetchPackage(ecosystem, name, options);
    if (info) found.push(info);
    else misses.push(`${ecosystem}: ${error}`);
  }
  // The same name can be unrelated on each registry, or a placeholder (npm's "django"), so the one
  // that has the version in use wins.
  const info = found.find((f) => pin && resolveVersion(pin, f)) ?? found[0];
  if (info) return { info, misses };
  return { misses };
}

/** A published version for a pin: an exact match, else the highest release on that line. */
export function resolveVersion(pin: string | undefined, info: PackageInfo): string | undefined {
  if (!pin) return info.latest;
  const wanted = parseVersion(pin);
  if (!wanted) return undefined;
  // A bare major such as "5" means that line, not 5.0.0.
  const bareMajor = /^\D*\d+\D*$/.test(pin);
  const exact = info.versions.find((v) => compareVersions(v.version, pin) === 0);
  if (exact && !bareMajor) return exact.version;
  return info.versions
    .filter((v) => !v.prerelease)
    .filter((v) => {
      const parsed = parseVersion(v.version);
      return parsed?.major === wanted.major && compareVersions(v.version, pin) >= 0;
    })
    .sort((a, b) => compareVersions(b.version, a.version))[0]?.version;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut; read the rest at the link]` : text;
}

// ---------- migration_guide ----------

type GuideStep = 'major' | 'minor';
type GuideSource = { step: GuideStep; url: (v: Version) => string | undefined };

// Official guide pages, each confirmed on 2026-11-06. Any other package falls back to its
// repository's migration files and release notes.
const GUIDES: Record<string, GuideSource> = {
  next: {
    step: 'major',
    url: (v) => `https://nextjs.org/docs/app/guides/upgrading/version-${v.major}`,
  },
  react: {
    step: 'major',
    url: (v) =>
      ({
        18: 'https://react.dev/blog/2022/03/08/react-18-upgrade-guide',
        19: 'https://react.dev/blog/2024/04/25/react-19-upgrade-guide',
      })[v.major],
  },
  express: {
    step: 'major',
    url: (v) => `https://expressjs.com/en/guide/migrating-${v.major}.html`,
  },
  django: {
    step: 'minor',
    url: (v) => `https://docs.djangoproject.com/en/stable/releases/${v.major}.${v.minor}/`,
  },
  flask: { step: 'major', url: () => 'https://flask.palletsprojects.com/en/stable/changes/' },
  pydantic: { step: 'major', url: () => 'https://docs.pydantic.dev/latest/migration/' },
  sqlalchemy: {
    step: 'major',
    url: (v) =>
      v.major === 2 ? 'https://docs.sqlalchemy.org/en/20/changelog/migration_20.html' : undefined,
  },
};

// Runtimes have no registry entry to read versions from, so the steps come from the input.
const RUNTIME_GUIDES: Record<string, GuideSource> = {
  node: {
    step: 'major',
    url: (v) => `https://nodejs.org/en/blog/migrations/v${v.major - 2}-to-v${v.major}`,
  },
  python: {
    step: 'minor',
    url: (v) => `https://docs.python.org/${v.major}/whatsnew/${v.major}.${v.minor}.html`,
  },
};
RUNTIME_GUIDES.nodejs = RUNTIME_GUIDES.node;

const GUIDE_FILES = ['MIGRATION.md', 'MIGRATING.md', 'UPGRADING.md', 'UPGRADE.md'];
const GUIDE_QUERY = 'breaking removed deprecated upgrade migration no longer changed required';

function sameLine(a: Version, b: Version, step: GuideStep): boolean {
  return a.major === b.major && (step === 'major' || a.minor === b.minor);
}

/** One version per guide-sized step after `from`, up to and including `to`. */
function stepsBetween(versions: string[], from: Version | undefined, to: Version, step: GuideStep) {
  const steps: Version[] = [];
  const parsed = versions
    .map((v) => parseVersion(v))
    .filter((v): v is Version => !!v)
    .sort((a, b) => compareVersions(a.raw, b.raw));
  for (const v of parsed) {
    if (compareVersions(v.raw, to.raw) > 0) break;
    if (from && (sameLine(v, from, step) || compareVersions(v.raw, from.raw) < 0)) continue;
    if (!steps.some((s) => sameLine(s, v, step))) steps.push(v);
  }
  return steps;
}

async function readGuide(url: string, options: UpgradeToolOptions): Promise<string> {
  const page = await fetchPage(url, options);
  if (!page.ok) return `- ${url}: could not read (${page.error}).`;
  const text = pageToText(page.text, page.contentType, page.url);
  const best = rank(GUIDE_QUERY, splitPassages(text), (p) => p)
    .slice(0, 4)
    .map((r) => r.item);
  return [`### ${page.url}`, ...(best.length ? best : [text]).map((p) => cut(p, 900))].join('\n\n');
}

function breakingNotes(notes: ReleaseNote[]): ReleaseNote[] {
  return notes.filter((n) => /migrat|upgrad|breaking|codemod/i.test(`${n.title} ${n.text}`));
}

export function createMigrationGuideTool(options: UpgradeToolOptions = {}): AgentTool {
  return defineTool({
    name: 'migration_guide',
    description:
      'Find the migration guide and changelog passages for moving a package (or the node or python runtime) between two versions, with links. Passages are picked by keyword, so read the linked page when one looks relevant. Informational.',
    inputSchema: PACKAGE_INPUT,
    run: async (input) => {
      const name = str(input, 'package') ?? str(input, 'name');
      if (!name) return 'Pass "package", e.g. "next", "django" or "node".';
      const from = str(input, 'from');
      const to = str(input, 'to');
      const key = name.toLowerCase();

      const runtime = RUNTIME_GUIDES[key];
      if (runtime) {
        const [low, high] = [parseVersion(from ?? ''), parseVersion(to ?? '')];
        if (!low || !high) return `Pass "from" and "to" for the ${name} runtime, e.g. 18 and 24.`;
        // Node's guides cover even majors; Python's cover each 3.x.
        const [first, last] = key === 'python' ? [low.minor, high.minor] : [low.major, high.major];
        const urls: string[] = [];
        for (let n = first + 1; n <= last; n++) {
          const step = parseVersion(key === 'python' ? `${low.major}.${n}` : String(n));
          const url = step && (key === 'python' || n % 2 === 0) ? runtime.url(step) : undefined;
          if (url) urls.push(url);
        }
        const guides = await Promise.all(urls.map((url) => readGuide(url, options)));
        return [`${name} ${from} -> ${to}:`, ...guides].join('\n\n');
      }

      const { info, misses } = await findPackage(input, options);
      const out: string[] = [];
      const guide = GUIDES[key];
      const target = info ? resolveVersion(to, info) : to;
      const toVersion = parseVersion(target ?? '');
      if (guide && toVersion) {
        const steps = stepsBetween(
          info?.versions.filter((v) => !v.prerelease).map((v) => v.version) ?? [toVersion.raw],
          parseVersion(from ?? ''),
          toVersion,
          guide.step,
        );
        const urls = [
          ...new Set(steps.map((s) => guide.url(s)).filter((u): u is string => !!u)),
        ].slice(-6);
        out.push(...(await Promise.all(urls.map((url) => readGuide(url, options)))));
      }
      if (!info) {
        out.push(`No registry data for "${name}" (${misses.join('; ')}).`);
        return out.join('\n\n');
      }
      out.unshift(`${info.name} ${from ?? '(unknown)'} -> ${target} (${info.page}):`);

      if (info.repository) {
        const raw = info.repository.replace(
          'https://github.com/',
          'https://raw.githubusercontent.com/',
        );
        for (const file of GUIDE_FILES) {
          const page = await fetchPage(`${raw}/HEAD/${file}`, options);
          if (page.ok) {
            out.push(
              [`### ${info.repository}/blob/HEAD/${file}`, cut(page.text, 2500)].join('\n\n'),
            );
            break;
          }
        }
      }

      const notes = await releaseNotes(info, { from, to: target }, options);
      const picked = breakingNotes(notes.notes)
        .sort((a, b) => compareVersions(b.version, a.version))
        .slice(0, 6);
      out.push(
        picked.length
          ? [
              `### Release notes that mention migrating or breaking changes (${notes.source})`,
              ...picked.map(
                (n) => `## ${n.version}${n.url ? ` ${n.url}` : ''}\n${cut(n.text, 1200)}`,
              ),
            ].join('\n\n')
          : `No release notes between these versions mention migrating or breaking changes (looked at ${notes.source}; tried ${notes.tried.join(', ') || 'nothing'}). That does not prove there are none.`,
      );
      return out.join('\n\n');
    },
  });
}

// ---------- registry_diff ----------

type Manifest = {
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  bin?: unknown;
  main?: string;
  type?: string;
  exports?: unknown;
};
type PypiRelease = { info?: { requires_python?: string | null; requires_dist?: string[] | null } };

function diffMap(label: string, a: Record<string, string> = {}, b: Record<string, string> = {}) {
  const lines: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === b[key]) continue;
    if (!(key in b)) lines.push(`- ${label} removed: ${key} (was ${a[key]})`);
    else if (!(key in a)) lines.push(`- ${label} added: ${key} ${b[key]}`);
    else lines.push(`- ${label} changed: ${key} ${a[key]} -> ${b[key]}`);
  }
  return lines;
}

function exportKeys(manifest: Manifest): Record<string, string> {
  const exports = manifest.exports;
  if (!exports || typeof exports !== 'object') return {};
  return Object.fromEntries(
    Object.keys(exports)
      .filter((key) => key.startsWith('.'))
      .map((key) => [key, 'exported']),
  );
}

function requiresDist(release: PypiRelease): Record<string, string> {
  return Object.fromEntries(
    (release.info?.requires_dist ?? []).map((line) => {
      const name = /^[A-Za-z0-9._-]+/.exec(line)?.[0] ?? line;
      return [name, line.slice(name.length).trim() || '(any)'];
    }),
  );
}

async function manifestDiff(
  info: PackageInfo,
  from: string,
  to: string,
  options: UpgradeToolOptions,
): Promise<string[]> {
  const urlFor = (version: string) =>
    info.ecosystem === 'npm'
      ? `https://registry.npmjs.org/${info.name}/${version}`
      : `https://pypi.org/pypi/${encodeURIComponent(info.name)}/${version}/json`;
  const [a, b] = await Promise.all(
    [from, to].map((v) => fetchPage(urlFor(v), { ...options, timeoutMs: 30_000 })),
  );
  if (!a.ok || !b.ok) {
    return [`Could not read both manifests (${!a.ok ? a.error : ''} ${!b.ok ? b.error : ''}).`];
  }
  if (info.ecosystem === 'npm') {
    const [ma, mb] = [JSON.parse(a.text) as Manifest, JSON.parse(b.text) as Manifest];
    return [
      ...diffMap('engine', ma.engines, mb.engines),
      ...diffMap('peer dependency', ma.peerDependencies, mb.peerDependencies),
      ...diffMap('dependency', ma.dependencies, mb.dependencies),
      ...diffMap('export path', exportKeys(ma), exportKeys(mb)),
      ...(ma.type !== mb.type ? [`- module type changed: ${ma.type} -> ${mb.type}`] : []),
      ...(ma.main !== mb.main ? [`- main entry changed: ${ma.main} -> ${mb.main}`] : []),
    ];
  }
  const [pa, pb] = [JSON.parse(a.text) as PypiRelease, JSON.parse(b.text) as PypiRelease];
  return [
    ...(pa.info?.requires_python !== pb.info?.requires_python
      ? [`- requires-python changed: ${pa.info?.requires_python} -> ${pb.info?.requires_python}`]
      : []),
    ...diffMap('dependency', requiresDist(pa), requiresDist(pb)),
  ];
}

const BREAKING_LINE =
  /\bbreaking\b|\bremov(?:e|ed|es|al)\b|\bno longer\b|\bdrop(?:s|ped)?\b|\brenamed?\b|\bdeprecat\w*\b|^[\s*-]*\w+(?:\([^)]*\))?!:/i;

export function createRegistryDiffTool(options: UpgradeToolOptions = {}): AgentTool {
  return defineTool({
    name: 'registry_diff',
    description:
      'Compare two published versions of an npm or PyPI package: changes to required runtimes, peer and direct dependencies and export paths, deprecated or yanked versions between them, and the lines in their release notes that mention breaking changes or removals. Picked by keyword, so a short list does not mean a safe upgrade. Informational.',
    inputSchema: { ...PACKAGE_INPUT, required: ['package', 'from'] },
    run: async (input) => {
      const name = str(input, 'package') ?? str(input, 'name');
      if (!name) return 'Pass "package" and "from", e.g. "express" and "4.18.2".';
      const { info, misses } = await findPackage(input, options);
      if (!info) return `No registry data for "${name}" (${misses.join('; ')}).`;
      const fromPin = str(input, 'from');
      const from = resolveVersion(fromPin, info);
      const to = resolveVersion(str(input, 'to'), info);
      if (!from || !to) {
        return `Could not place ${fromPin ?? 'the versions'} among ${info.name}'s releases on ${info.ecosystem}; latest is ${info.latest}. See ${info.page}.`;
      }
      const out = [`${info.name} ${from} -> ${to} on ${info.ecosystem} (${info.page}):`];
      const changes = await manifestDiff(info, from, to, options);
      out.push(
        changes.length
          ? ['Manifest changes:', ...changes].join('\n')
          : 'Manifest changes: none in runtimes, dependencies or export paths.',
      );
      const between = info.versions.filter(
        (v) => compareVersions(v.version, from) > 0 && compareVersions(v.version, to) <= 0,
      );
      const flagged = between.filter((v) => v.deprecated || v.yanked);
      if (flagged.length) {
        out.push(
          [
            'Flagged versions in this range:',
            ...flagged
              .slice(0, 10)
              .map((v) => `- ${v.version}: ${cut(v.deprecated ?? v.yanked ?? '', 200)}`),
          ].join('\n'),
        );
      }
      const notes = await releaseNotes(info, { from, to }, options);
      const lines = notes.notes
        .sort((a, b) => compareVersions(b.version, a.version))
        .flatMap((note) =>
          note.text
            .split('\n')
            .filter((line) => BREAKING_LINE.test(line))
            .map((line) => `- ${note.version}: ${line.trim().slice(0, 240)}`),
        );
      out.push(
        lines.length
          ? [
              `Release-note lines about breaking changes or removals (${notes.source}):`,
              ...lines.slice(0, 50),
              ...(lines.length > 50 ? [`[${lines.length - 50} more lines not shown]`] : []),
            ].join('\n')
          : `No matching release-note lines (${notes.notes.length} notes read from ${notes.source}; tried ${notes.tried.join(', ') || 'nothing'}).`,
      );
      out.push('Links:', ...[info.page, info.repository].filter(Boolean).map((l) => `- ${l}`));
      return out.join('\n\n');
    },
  });
}

// ---------- codemod ----------

type Codemod = { command: string; applies: string; url: string; official: boolean; note?: string };
const CODEMODS = JSON.parse(
  readFileSync(new URL('./data/codemods.json', import.meta.url), 'utf8'),
) as { retrieved: string; packages: Record<string, Codemod[]> };

const SANDBOX_NOTE =
  'Run codemods only inside the sandbox, never on the host. Review the diff afterwards, and run the checks: a codemod handles the patterns it knows and can miss or mangle the rest.';

export function createCodemodTool(options: UpgradeToolOptions = {}): AgentTool {
  return defineTool({
    name: 'codemod',
    description:
      "List known codemods for moving a package between versions (for example Next.js and React's official ones), how to run them in the sandbox, and any codemods its release notes mention. Informational; whether one helps is your call.",
    inputSchema: PACKAGE_INPUT,
    run: async (input) => {
      const name = str(input, 'package') ?? str(input, 'name');
      if (!name) return 'Pass "package", e.g. "next" or "react".';
      const from = str(input, 'from');
      const to = str(input, 'to');
      const known = CODEMODS.packages[name.toLowerCase()] ?? [];
      const out = [`Codemods for ${name}${from ? ` ${from}` : ''}${to ? ` -> ${to}` : ''}:`];
      out.push(
        ...known.map(
          (c) =>
            `- \`${c.command}\` (${c.official ? 'official' : 'community'}; ${c.applies}) ${c.url}${c.note ? `\n  ${c.note}` : ''}`,
        ),
      );
      const { info } = await findPackage(input, options);
      if (info) {
        const notes = await releaseNotes(
          info,
          { from, to: resolveVersion(to, info) ?? to },
          options,
        );
        const mentions = notes.notes
          .filter((n) => /codemod/i.test(n.text))
          .sort((a, b) => compareVersions(b.version, a.version))
          .slice(0, 5)
          .flatMap((n) =>
            n.text
              .split('\n')
              .filter((line) => /codemod/i.test(line))
              .slice(0, 2)
              .map(
                (line) => `- ${n.version}: ${line.trim().slice(0, 240)}${n.url ? ` ${n.url}` : ''}`,
              ),
          );
        if (mentions.length) out.push('Mentioned in release notes:', ...mentions);
      }
      if (out.length === 1) {
        out.push(
          'None known. This list is short, so check the migration guide (migration_guide) before assuming none exists, then make the edits yourself.',
        );
      }
      out.push(SANDBOX_NOTE);
      return out.join('\n');
    },
  });
}
