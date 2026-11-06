import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFetchCache,
  loadPlaybookMeta,
  loadToolPack,
  parseFrontMatter,
} from '../toolkit/index.ts';
import { recordedFetch, type FakeResponse } from '../toolkit/testing.ts';
import { parseAction } from './actions.ts';
import { parseImage, supportedTags } from './docker.ts';
import { cycleFor } from './end-of-life.ts';
import {
  SPECIFICS,
  UPGRADE_KINDS,
  actionVersions,
  codemod,
  createUpgradeTools,
  dockerImageTags,
  endOfLife,
  migrationGuide,
  modelReplacement,
  registryDiff,
  specificFor,
  upgradePlaybook,
  upgradeTools,
} from './index.ts';
import { providerFor } from './models.ts';

const DIR = fileURLToPath(new URL('./fixtures/recorded/', import.meta.url));
const ctx = { repoDir: '.' };
const now = () => new Date('2026-11-06T12:00:00Z');

function tools(extra: Record<string, FakeResponse> = {}) {
  const fetch = recordedFetch(extra, DIR);
  const made = createUpgradeTools({ fetch, now });
  const run = (name: string, input: unknown) => {
    const tool = made.find((t) => t.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.run(input, ctx);
  };
  return { run, fetch };
}

beforeEach(() => clearFetchCache());

describe('exports', () => {
  it('exports every tool as an AgentTool with a usable name and schema', () => {
    expect(upgradeTools.map((t) => t.name)).toEqual([
      'end_of_life',
      'migration_guide',
      'registry_diff',
      'codemod',
      'model_replacement',
      'action_versions',
      'docker_image_tags',
    ]);
    expect([
      endOfLife,
      migrationGuide,
      registryDiff,
      codemod,
      modelReplacement,
      actionVersions,
      dockerImageTags,
    ]).toEqual(upgradeTools);
    for (const tool of upgradeTools) {
      expect(tool.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('never throws or blocks: bad input and no network both come back as information', async () => {
    const offline = createUpgradeTools({ fetch: null, now });
    const inputs = [
      {},
      'nonsense',
      { product: 'node', version: '18' },
      { package: 'next', from: '14', to: '15' },
      { provider: 'anthropic', model: 'claude-3-5-sonnet-20240620' },
      { action: 'actions/checkout@v4' },
      { image: 'node:18' },
    ];
    for (const tool of offline) {
      for (const input of inputs) {
        await expect(tool.run(input, ctx)).resolves.toEqual(expect.any(String));
      }
    }
  });
});

describe('end_of_life', () => {
  it('reports an end-of-life version, the supported ones and a target', async () => {
    const out = await tools().run('end_of_life', { product: 'node', version: '18.19.0' });
    expect(out).toContain('18: support ended 2025-04-30');
    expect(out).toContain('It is past end of life.');
    expect(out).toContain('Recommended target: 26');
    expect(out).toContain('- 22: support ends 2027-04-30');
    expect(out).not.toContain('- 20:');
    expect(out).toContain('https://endoflife.date/nodejs');
  });

  it('recommends the newest LTS and names the newest release when they differ', async () => {
    const out = await tools().run('end_of_life', { product: 'django', version: '4.2' });
    expect(out).toContain('Recommended target: 5.2');
    expect(out).toContain('Newest supported overall: 6.1');
  });

  it('reads an image reference, and never calls a future LTS date an LTS', async () => {
    const out = await tools().run('end_of_life', { product: 'node:24-bookworm' });
    expect(out).toContain('Your version 24-bookworm is in 24');
    const early = createUpgradeTools({
      fetch: recordedFetch({}, DIR),
      now: () => new Date('2026-07-01T00:00:00Z'),
    })[0];
    expect(await early.run({ product: 'node' }, ctx)).toContain('Recommended target: 24');
  });

  it('suggests products when the name is unknown', async () => {
    const out = await tools().run('end_of_life', { product: 'nodee' });
    expect(out).toContain('no answer for "nodee"');
    expect(out).toContain('nodejs');
  });

  it('matches versions to cycles', () => {
    const cycles = [{ cycle: '3.10' }, { cycle: '3.1' }, { cycle: '12', codename: 'Bookworm' }];
    expect(cycleFor('3.10.4', cycles)?.cycle).toBe('3.10');
    expect(cycleFor('>=3.1', cycles)?.cycle).toBe('3.1');
    expect(cycleFor('bookworm', cycles)?.cycle).toBe('12');
    expect(cycleFor('7', cycles)).toBeUndefined();
  });
});

describe('migration_guide', () => {
  it('reads the official guide and the release notes for a known package', async () => {
    const { run, fetch } = tools();
    const out = await run('migration_guide', { package: 'express', from: '4.18.2', to: '5' });
    expect(out).toContain('express 4.18.2 -> 5.3.0');
    expect(fetch.calls).toContain('GET https://expressjs.com/en/guide/migrating-5.html');
    expect(out).toContain('### https://expressjs.com/en/guide/migrating-5.html');
    expect(out).toMatch(/removed|no longer/i);
  });

  it('reads one guide per major for Next.js', async () => {
    const { run, fetch } = tools();
    const out = await run('migration_guide', { package: 'next', from: '14.2.30', to: '15' });
    expect(fetch.calls).toContain('GET https://nextjs.org/docs/app/guides/upgrading/version-15');
    expect(out).toContain('### https://nextjs.org/docs/app/guides/upgrading/version-15');
    expect(out).not.toContain('version-14');
    expect(out).not.toContain('version-16');
  });

  it('picks the registry that has the version when a name is on both', async () => {
    // Illustrative: npm's "django" is a placeholder package with a single 1.0.0 release.
    const placeholder = JSON.stringify({
      name: 'django',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': {} },
    });
    const { run, fetch } = tools({
      'https://registry.npmjs.org/django': { status: 200, body: placeholder },
    });
    const out = await run('migration_guide', { package: 'django', from: '4.2.1', to: '5.0' });
    expect(out).toContain('Django 4.2.1 -> 5.0');
    expect(fetch.calls).toContain('GET https://docs.djangoproject.com/en/stable/releases/5.0/');
  });

  it('reads the runtime guides between two versions and reports the ones it could not read', async () => {
    const node = await tools().run('migration_guide', { package: 'node', from: '19', to: '24' });
    expect(node).toContain('v18-to-v20: could not read');
    expect(node).toContain('### https://nodejs.org/en/blog/migrations/v22-to-v24');
    expect(node).not.toContain('v19');

    const python = tools();
    await python.run('migration_guide', { package: 'python', from: '3.12', to: '3.13' });
    expect(python.fetch.calls).toEqual(['GET https://docs.python.org/3/whatsnew/3.13.html']);

    expect(await tools().run('migration_guide', { package: 'node' })).toContain('Pass "from"');
  });

  it('says what it tried for an unknown package', async () => {
    const out = await tools().run('migration_guide', { package: 'no-such-pkg-here' });
    expect(out).toContain('No registry data for "no-such-pkg-here"');
  });
});

describe('registry_diff', () => {
  it('compares npm manifests and lists breaking lines from release notes', async () => {
    const out = await tools().run('registry_diff', {
      package: 'express',
      from: '^4.18.2',
      to: '5',
    });
    expect(out).toContain('express 4.18.2 -> 5.3.0 on npm');
    expect(out).toContain('engine changed: node >= 0.10.0 -> >= 18');
    expect(out).toContain('dependency removed: methods');
    expect(out).toContain('Release-note lines about breaking changes or removals');
    expect(out).toContain('https://github.com/expressjs/express');
  });

  it('compares PyPI requirements and reports yanked releases', async () => {
    const out = await tools().run('registry_diff', {
      package: 'django',
      from: '4.2.1',
      to: '5.0',
      ecosystem: 'pypi',
    });
    expect(out).toContain('Django 4.2.1 -> 5.0 on pypi');
    expect(out).toContain('requires-python changed: >=3.8 -> >=3.10');
    expect(out).toContain('dependency removed: backports.zoneinfo');
    expect(out).toContain('- 4.2.12: Release files');
  });

  it('says so when versions cannot be placed', async () => {
    const out = await tools().run('registry_diff', { package: 'express', from: '99.0.0' });
    expect(out).toContain('Could not place 99.0.0');
    expect(await tools().run('registry_diff', {})).toContain('Pass "package"');
  });
});

describe('codemod', () => {
  it('lists official codemods and how to run them in the sandbox', async () => {
    const out = await tools().run('codemod', { package: 'next', from: '14', to: '15' });
    expect(out).toContain('npx @next/codemod upgrade major');
    expect(out).toContain('official');
    expect(out).toContain('only inside the sandbox');
  });

  it('marks community tools and says when it knows none', async () => {
    expect(await tools().run('codemod', { package: 'django', ecosystem: 'pypi' })).toContain(
      'community',
    );
    const none = await tools().run('codemod', { package: 'no-such-pkg-here' });
    expect(none).toContain('None known');
    expect(none).toContain('migration_guide');
  });

  it('every listed codemod links its source', () => {
    const data = JSON.parse(
      readFileSync(new URL('./data/codemods.json', import.meta.url), 'utf8'),
    ) as { packages: Record<string, { url: string; command: string }[]> };
    for (const entry of Object.values(data.packages).flat()) {
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.command).not.toBe('');
    }
  });
});

describe('model_replacement', () => {
  it('answers OpenAI from its pack, with request-shape notes', async () => {
    const out = await tools().run('model_replacement', { provider: 'openai', model: 'gpt-4o' });
    expect(out).toContain('Recommended replacement: gpt-6-luna');
    expect(out).toContain('Shutdown date: 2027-01-14');
    expect(out).toContain('Request-shape notes:');
  });

  it('answers Anthropic from the snapshot and the live page', async () => {
    const out = await tools().run('model_replacement', {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20240620',
    });
    expect(out).toContain('Retirement date: 2025-10-28');
    expect(out).toContain('Recommended replacement: claude-sonnet-5-5');
    expect(out).toContain('The live page today:');
    expect(out).toContain('Request-shape notes:');
  });

  it('reads cloud-prefixed ids and infers the provider', async () => {
    const out = await tools().run('model_replacement', {
      model: 'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
    });
    expect(out).toContain('Recommended replacement: claude-sonnet-5-5');
    expect(providerFor(undefined, 'gemini-2.5-pro')).toBe('google');
    expect(providerFor(undefined, 'gpt-4o')).toBe('openai');
    expect(providerFor('openai', 'ft:gpt-4o:org::id')).toBe('openai');
    expect(providerFor(undefined, 'mistral-large')).toBeUndefined();
  });

  it('answers Google and says when an id is not in the snapshot', async () => {
    const known = await tools().run('model_replacement', {
      provider: 'google',
      model: 'models/gemini-2.5-pro',
    });
    expect(known).toContain('google model models/gemini-2.5-pro');
    expect(known).toContain('Status on 2026-11-06');
    const missing = await tools().run('model_replacement', {
      provider: 'google',
      model: 'gemini-1.5-pro',
    });
    expect(missing).toContain('Not in the 2026-11-06 snapshot');
  });

  it('points elsewhere for a provider it has no data for', async () => {
    const out = await tools().run('model_replacement', {
      provider: 'mistral',
      model: 'mistral-large',
    });
    expect(out).toContain('No retirement data for mistral');
    expect(out).toContain('fetch_changelog');
  });

  it('every snapshot row quotes its source', () => {
    const data = JSON.parse(
      readFileSync(new URL('./data/model-retirements.json', import.meta.url), 'utf8'),
    ) as Record<string, { source: string; models: { id: string; quote: string }[] }>;
    for (const snapshot of Object.values(data)) {
      expect(snapshot.source).toMatch(/^https:\/\//);
      expect(snapshot.models.length).toBeGreaterThan(0);
      for (const row of snapshot.models) expect(row.quote).not.toBe('');
    }
  });
});

describe('action_versions', () => {
  it('lists majors with their runtimes and marks the pinned one', async () => {
    const out = await tools().run('action_versions', { action: 'actions/checkout@v3' });
    expect(out).toContain('Latest: 7.0.1.');
    expect(out).toMatch(/- v3: latest 3\.7\.0 \(2026-07-20\), runs on node16 <- pinned here/);
    expect(out).toContain('runs on node20');
    expect(out).not.toContain('archived');
  });

  it('does not treat a commit SHA as a version', async () => {
    const out = await tools().run('action_versions', { action: 'actions/checkout@3df4ab1' });
    expect(out).not.toContain('pinned here');
  });

  it('reports an archived repo and a rate-limited releases call', async () => {
    const out = await tools({
      'https://api.github.com/repos/actions/checkout': {
        status: 200,
        body: JSON.stringify({ archived: true }),
      },
      'https://api.github.com/repos/actions/checkout/releases?per_page=100': {
        status: 403,
        body: 'rate limited',
      },
    }).run('action_versions', { action: 'actions/checkout@v3' });
    expect(out).toContain('archived');
    expect(out).toContain('Could not read the releases (HTTP 403');
    expect(out).toContain('runs on node16 <- pinned here');
  });

  it('points runner labels at the right place', async () => {
    expect(await tools().run('action_versions', { action: 'ubuntu-22.04' })).toContain(
      'actions/runner-images',
    );
    expect(parseAction('github/codeql-action/init@v2')).toEqual({
      owner: 'github',
      repo: 'codeql-action',
      path: 'init',
      version: 'v2',
    });
  });
});

describe('docker_image_tags', () => {
  it('says when a tag has left the supported list of an official image', async () => {
    const out = await tools().run('docker_image_tags', { image: 'node:18-bookworm' });
    expect(out).toContain('Tag 18-bookworm: last pushed 2025-05-23, status active.');
    expect(out).toContain("not on the maintainers' supported list");
    expect(out).toContain('26-bookworm');
  });

  it('says when a tag is supported', async () => {
    const out = await tools().run('docker_image_tags', { image: 'node:26-bookworm' });
    expect(out).toContain('26-bookworm is on the supported list.');
  });

  it('lists recent tags for other images and leaves signing artifacts out', async () => {
    const body = JSON.stringify({
      results: [
        { name: 'sha256-abc.sig', tag_last_pushed: '2026-11-04T00:00:00Z' },
        { name: 'latest-metadata', tag_last_pushed: '2026-11-04T00:00:00Z' },
        { name: '7.4.0', tag_last_pushed: '2026-11-04T00:00:00Z' },
      ],
    });
    const out = await tools({
      'https://hub.docker.com/v2/repositories/acme/redis/tags?page_size=100&ordering=last_updated':
        { status: 200, body },
    }).run('docker_image_tags', { image: 'acme/redis' });
    expect(out).toContain('No official supported list');
    expect(out).toContain('- 7.4.0 (2026-11-04)');
    expect(out).not.toContain('sha256');
    expect(out).not.toContain('latest-metadata');
  });

  it('says when every recent tag is a signing artifact', async () => {
    const body = JSON.stringify({ results: [{ name: 'sha256-abc.sig' }] });
    const out = await tools({
      'https://hub.docker.com/v2/repositories/acme/redis/tags?page_size=100&ordering=last_updated':
        { status: 200, body },
    }).run('docker_image_tags', { image: 'acme/redis' });
    expect(out).toContain('all signing artifacts');
  });

  it('says it reads Docker Hub only for other registries', async () => {
    expect(await tools().run('docker_image_tags', { image: 'ghcr.io/o/r:1' })).toContain(
      'reads Docker Hub only',
    );
  });

  it('parses image references and supported-tag sections', () => {
    expect(parseImage('node:18')).toEqual({
      registry: undefined,
      repository: 'library/node',
      tag: '18',
    });
    expect(parseImage('ghcr.io/o/r:1@sha256:abc')).toEqual({
      registry: 'ghcr.io',
      repository: 'o/r',
      tag: '1',
    });
    expect(
      supportedTags('# Supported tags\n\n-\t[`a`, `b`](x)\n\n# Quick reference\n-\t`no`\n'),
    ).toEqual([['a', 'b']]);
    expect(supportedTags('no section')).toEqual([]);
  });
});

describe('playbooks', () => {
  const dir = new URL('./playbooks/', import.meta.url);

  it('has one playbook per kind and each set of specifics, with official links', () => {
    const paths = [...UPGRADE_KINDS, ...SPECIFICS.map((name) => `specifics/${name}`)];
    for (const path of paths) {
      const url = new URL(`${path}.md`, dir);
      expect(existsSync(url), path).toBe(true);
      const { meta, body } = parseFrontMatter(readFileSync(url, 'utf8'));
      expect(meta.reviewed, path).toBe('false');
      expect(meta.drafted, path).toBe('2026-11-06');
      expect(body, path).toMatch(/\]\(https:\/\//);
    }
    expect(Object.keys(loadPlaybookMeta(dir)).sort()).toEqual([...UPGRADE_KINDS].sort());
  });

  it('gives advice and adds specifics by dependency, never a gate', () => {
    for (const name of [...UPGRADE_KINDS, ...SPECIFICS]) {
      const path = (UPGRADE_KINDS as readonly string[]).includes(name)
        ? `${name}.md`
        : `specifics/${name}.md`;
      const body = readFileSync(new URL(path, dir), 'utf8');
      expect(body).not.toMatch(/\b(refuse|compliant)\b/i);
    }
    const plain = upgradePlaybook('runtime-eol');
    const withNode = upgradePlaybook('runtime-eol', 'node:18-bookworm');
    expect(plain).not.toBe('');
    expect(plain).not.toMatch(/^---/);
    expect(withNode.startsWith(plain)).toBe(true);
    expect(withNode.length).toBeGreaterThan(plain.length);
    expect(upgradePlaybook('runtime-eol', 'erlang')).toBe(plain);
    expect(upgradePlaybook('no-such-kind')).toBe('');
    expect(specificFor('nodejs')).toBe('node');
    expect(specificFor('next')).toBe('nextjs');
    expect(specificFor('library/python:3.9-slim')).toBe('python');
    expect(specificFor('Django')).toBe('django');
    expect(specificFor('nodemon')).toBeUndefined();
  });

  it('adds retirement playbooks and tools to the model providers, and keeps OpenAI working', async () => {
    for (const provider of ['anthropic', 'google']) {
      const pack = await loadToolPack(provider, { fetch: null });
      expect(pack.provider).toBe(provider);
      expect(pack.playbooks['model-retirement']).toContain('model_replacement');
      expect(pack.tools.map((t) => t.name)).toContain('model_replacement');
      expect(pack.tools.map((t) => t.name)).toContain(`${provider}_search_docs`);
    }
    const openai = await loadToolPack('openai', { fetch: null });
    expect(openai.playbooks['model-retirement']).toContain('openai_model_lookup');
    expect(openai.tools.map((t) => t.name)).toContain('openai_model_lookup');
  });

  it('leaves no stray files in the playbooks folder', () => {
    expect(readdirSync(dir).sort()).toEqual(
      [...UPGRADE_KINDS.map((k) => `${k}.md`), 'specifics'].sort(),
    );
  });
});
