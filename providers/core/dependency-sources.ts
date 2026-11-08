// Where each source group starts reading for a dependency. These are head starts the agent may
// ignore or add to; nothing here decides whether a dependency or change matters.

import type { DependencyUsage } from '../../shared/types.ts';
import type { FetchedPage, JsonFetcher } from './fetch.ts';
import { githubRepo } from './packages.ts';
import type { SourceGroup } from './prompt.ts';
import type { ProviderSource } from './types.ts';

/** Names endoflife.date spells differently; all.json lets the agent correct any other. */
const EOL_ALIASES: Record<string, string> = { node: 'nodejs', next: 'nextjs', 'next.js': 'nextjs' };

/** Official release-schedule pages, keyed by endoflife.date product. */
const OFFICIAL_SCHEDULES: Record<string, string> = {
  nodejs: 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json',
  python: 'https://devguide.python.org/versions/',
  nextjs: 'https://nextjs.org/support-policy',
  django: 'https://www.djangoproject.com/download/',
  ubuntu: 'https://ubuntu.com/about/release-cycle',
  debian: 'https://wiki.debian.org/LTS',
  alpine: 'https://alpinelinux.org/releases/',
};

/** "docker.io/library/node:18-bookworm" is the product "node". */
export function eolProduct(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[:@].*$/, '')
      .split('/')
      .at(-1) ?? '';
  return EOL_ALIASES[base] ?? base;
}

function eolSources(dep: DependencyUsage): ProviderSource[] {
  const product = eolProduct(dep.name.replace(/^@/, ''));
  const official = OFFICIAL_SCHEDULES[product];
  return [
    {
      id: `eol-${product}`,
      kind: 'deprecations',
      url: `https://endoflife.date/api/${encodeURIComponent(product)}.json`,
      format: 'json',
      note: `endoflife.date's release cycles for "${product}" (a guess from the name)`,
      guess: true,
    },
    {
      id: 'eol-products',
      kind: 'other',
      url: 'https://endoflife.date/api/all.json',
      format: 'json',
      note: 'every product name endoflife.date covers',
    },
    ...(official
      ? [
          {
            id: `schedule-${product}`,
            kind: 'deprecations' as const,
            url: official,
            note: `the official release schedule for ${product}`,
          },
        ]
      : []),
  ];
}

const MODEL_PAGES: ProviderSource[] = [
  {
    id: 'openai-deprecations',
    kind: 'deprecations',
    url: 'https://developers.openai.com/api/docs/deprecations.md',
    format: 'markdown',
    note: "OpenAI's model and API deprecations",
  },
  {
    id: 'anthropic-deprecations',
    kind: 'deprecations',
    url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
    note: "Anthropic's model deprecations",
  },
  {
    id: 'google-gemini-deprecations',
    kind: 'deprecations',
    url: 'https://ai.google.dev/gemini-api/docs/deprecations.md.txt',
    format: 'markdown',
    note: "Google's Gemini API model deprecations",
  },
  {
    id: 'google-vertex-deprecations',
    kind: 'deprecations',
    url: 'https://cloud.google.com/vertex-ai/generative-ai/docs/deprecations',
    note: "Google's Vertex AI deprecations",
  },
];

function ciSources(dep: DependencyUsage): ProviderSource[] {
  const repo = githubRepo(`https://github.com/${dep.name.replace(/@.*$/, '')}`);
  return [
    ...(repo
      ? [
          {
            id: 'action-releases',
            kind: 'sdk-releases' as const,
            url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`,
            format: 'github-releases' as const,
            note: `releases of ${repo.owner}/${repo.repo}, newest first`,
          },
        ]
      : []),
    {
      id: 'github-actions-changelog',
      kind: 'changelog',
      url: 'https://github.blog/changelog/label/actions/feed/',
      format: 'rss',
      note: "GitHub's changelog for Actions: deprecations and brownouts, newest first",
    },
    {
      id: 'runner-images',
      kind: 'deprecations',
      url: 'https://raw.githubusercontent.com/actions/runner-images/main/README.md',
      format: 'markdown',
      note: 'supported runner labels and which are being retired',
    },
  ];
}

const OSV_QUERY = 'https://api.osv.dev/v1/query';
const OSV_ECOSYSTEM: Record<string, string> = { npm: 'npm', pypi: 'PyPI' };
const GHSA_ECOSYSTEM: Record<string, string> = { npm: 'npm', pypi: 'pip' };

/** npm and PyPI are the registries tonight; with no ecosystem named, the package may be in either. */
function packageEcosystems(dep: DependencyUsage): string[] {
  const named = dep.ecosystem?.toLowerCase();
  if (named) return named in OSV_ECOSYSTEM ? [named] : [];
  return dep.name.startsWith('@') ? ['npm'] : ['npm', 'pypi'];
}

/** The exact version in a pin such as "^13.4.0" or "==3.2", which is what the feeds match on. */
export function exactVersion(version?: string): string | undefined {
  return /\d+\.\d+(?:\.\d+)?(?:[-.+\w]*)/.exec(version ?? '')?.[0];
}

function advisorySources(dep: DependencyUsage): ProviderSource[] {
  const version = exactVersion(dep.version);
  return packageEcosystems(dep).map((ecosystem) => ({
    id: `ghsa-${ecosystem}`,
    kind: 'deprecations',
    url: `https://api.github.com/advisories?ecosystem=${GHSA_ECOSYSTEM[ecosystem]}&affects=${encodeURIComponent(
      version ? `${dep.name}@${version}` : dep.name,
    )}&per_page=30`,
    format: 'json',
    note: `GitHub Advisory Database for ${dep.name} on ${ecosystem}`,
  }));
}

type OsvVuln = {
  id?: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { name?: string };
    ranges?: { events?: { introduced?: string; fixed?: string }[] }[];
  }[];
};

/** OSV's answer as text the agent can read and quote, one advisory to a paragraph. */
export function renderOsv(name: string, version: string | undefined, data: unknown): string {
  const vulns = (data as { vulns?: OsvVuln[] }).vulns ?? [];
  const header = `OSV advisories for ${name}${version ? ` at ${version}` : ' (all versions)'}: ${vulns.length}.`;
  return [
    header,
    ...vulns.map((vuln) => {
      const fixed = (vuln.affected ?? [])
        .filter((entry) => !entry.package?.name || entry.package.name === name)
        .flatMap((entry) => entry.ranges ?? [])
        .flatMap((range) => range.events ?? [])
        .flatMap((event) => (event.fixed ? [event.fixed] : []));
      return [
        `## ${vuln.id ?? 'unknown id'}${vuln.aliases?.length ? ` (${vuln.aliases.join(', ')})` : ''}`,
        `https://osv.dev/vulnerability/${vuln.id ?? ''}`,
        vuln.summary ?? 'No summary given.',
        `Severity: ${vuln.database_specific?.severity ?? 'not given'}. First fixed in: ${fixed.length ? [...new Set(fixed)].join(', ') : 'not given'}.`,
      ].join('\n');
    }),
  ].join('\n\n');
}

export const osvPageUrl = (name: string, ecosystem: string, version?: string) =>
  `${OSV_QUERY}?package=${encodeURIComponent(name)}&ecosystem=${ecosystem}${version ? `&version=${encodeURIComponent(version)}` : ''}`;

/** Asks OSV about the dependency. A failed query comes back as a failed page, which the report lists. */
export async function readOsv(dep: DependencyUsage, json: JsonFetcher): Promise<FetchedPage[]> {
  const version = exactVersion(dep.version);
  const fetchedAt = new Date().toISOString();
  return Promise.all(
    packageEcosystems(dep).map(async (ecosystem): Promise<FetchedPage> => {
      const result = await json.json(OSV_QUERY, {
        package: { name: dep.name, ecosystem: OSV_ECOSYSTEM[ecosystem] },
        ...(version ? { version } : {}),
      });
      return {
        url: osvPageUrl(dep.name, ecosystem, version),
        status: result.status,
        ok: result.ok,
        fetchedAt,
        contentType: 'text/plain',
        text: result.ok ? renderOsv(dep.name, version, result.data) : '',
        ...(result.ok ? {} : { error: result.error }),
      };
    }),
  );
}

export function osvSource(page: FetchedPage, dep: DependencyUsage): ProviderSource {
  const ecosystem = new URL(page.url).searchParams.get('ecosystem') ?? 'unknown';
  return {
    id: `osv-${ecosystem}`,
    kind: 'deprecations',
    url: page.url,
    note: `OSV advisories for ${dep.name} on ${ecosystem}, already fetched: read it with read_page`,
  };
}

/** Which source groups a dependency's watcher reads, by what kind of thing it is. */
export const GROUPS_BY_KIND: Partial<Record<DependencyUsage['kind'], SourceGroup[]>> = {
  runtime: ['eol'],
  'container-image': ['eol'],
  framework: ['eol', 'packages', 'advisories'],
  library: ['packages', 'advisories'],
  sdk: ['packages', 'advisories'],
  'ai-model': ['models'],
  ci: ['ci'],
};

export function sourcesFor(dep: DependencyUsage, groups: SourceGroup[]): ProviderSource[] {
  return groups.flatMap((group) => {
    switch (group) {
      case 'eol':
        return eolSources(dep);
      case 'advisories':
        return advisorySources(dep);
      case 'models':
        return MODEL_PAGES;
      case 'ci':
        return ciSources(dep);
      case 'packages':
        return []; // the registry lookups add these, with each package's changelog and releases
    }
  });
}
