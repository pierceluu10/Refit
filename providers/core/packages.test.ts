import { describe, expect, it } from 'vitest';
import type { FetchedPage, JsonFetcher } from './fetch.ts';
import {
  githubRepo,
  majorLines,
  npmInfo,
  parseVersion,
  pypiInfo,
  rawGitHubUrl,
  registriesFor,
  registryClient,
  RELEASE_HEADING,
  releaseNotesFor,
  renderPackage,
  sectionFor,
  type PackageInfo,
} from './packages.ts';

// Registry documents below are trimmed to the fields the reader uses; names and versions are made up.

describe('versions', () => {
  it('parses semver and PEP 440 versions leniently', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: false });
    expect(parseVersion('v3')).toEqual({ major: 3, minor: 0, patch: 0, pre: false });
    expect(parseVersion('2.0.0-beta.1')?.pre).toBe(true);
    expect(parseVersion('1.0.0rc1')?.pre).toBe(true);
    expect(parseVersion('0.9.0.dev3')?.pre).toBe(true);
    expect(parseVersion('1.0.0.post1')?.pre).toBe(false);
    expect(parseVersion('1.0.0+build.5')?.pre).toBe(false);
    expect(parseVersion('latest')).toBeUndefined();
    expect(parseVersion('1.0.0x')).toBeUndefined();
  });

  it('groups stable releases into major lines, highest first, with newer prereleases apart', () => {
    const { majors, upcoming } = majorLines([
      { version: '0.9.0', publishedAt: '2024-01-01T00:00:00Z' },
      { version: '1.0.0', publishedAt: '2024-06-01T00:00:00Z' },
      { version: '1.10.0', publishedAt: '2025-01-01T00:00:00Z' },
      { version: '1.2.0', publishedAt: '2024-09-01T00:00:00Z', deprecated: 'use 2.x' },
      { version: '2.0.0-rc.1', publishedAt: '2025-02-01T00:00:00Z' },
      { version: '2.0.0', publishedAt: '2025-03-01T00:00:00Z' },
      { version: '3.0.0-beta.1', publishedAt: '2026-10-01T00:00:00Z' },
      { version: 'not-a-version' },
    ]);
    expect(majors).toEqual([
      {
        major: 2,
        first: '2.0.0',
        firstAt: '2025-03-01',
        latest: '2.0.0',
        latestAt: '2025-03-01',
        releases: 1,
      },
      {
        major: 1,
        first: '1.0.0',
        firstAt: '2024-06-01',
        latest: '1.10.0',
        latestAt: '2025-01-01',
        releases: 3,
      },
      {
        major: 0,
        first: '0.9.0',
        firstAt: '2024-01-01',
        latest: '0.9.0',
        latestAt: '2024-01-01',
        releases: 1,
      },
    ]);
    expect(upcoming).toEqual(['3.0.0-beta.1']);
  });
});

describe('repositories', () => {
  it('finds the GitHub repository in the forms registries use', () => {
    expect(githubRepo('git+https://github.com/acme/acme-node.git')).toEqual({
      owner: 'acme',
      repo: 'acme-node',
      url: 'https://github.com/acme/acme-node',
    });
    expect(githubRepo('git@github.com:acme/acme.js.git')?.repo).toBe('acme.js');
    expect(githubRepo('github:acme/acme')?.url).toBe('https://github.com/acme/acme');
    expect(githubRepo('https://github.com/acme/mono/tree/main/packages/sdk')?.dir).toBe(
      'packages/sdk',
    );
    expect(githubRepo('https://github.com/acme/mono', 'packages/sdk/')?.dir).toBe('packages/sdk');
    expect(githubRepo('https://gitlab.com/acme/acme')).toBeUndefined();
    expect(rawGitHubUrl('https://github.com/acme/sdk/blob/main/CHANGES.md')).toBe(
      'https://raw.githubusercontent.com/acme/sdk/main/CHANGES.md',
    );
  });

  it('knows which registries a manifest name can be in', () => {
    expect(registriesFor('@acme/sdk')).toEqual(['npm']);
    expect(registriesFor('acme')).toEqual(['npm', 'pypi']);
    expect(registriesFor('github.com/acme/acme-go/v3')).toEqual([]);
    expect(registriesFor('com.acme:acme-java')).toEqual([]);
  });
});

describe('registry documents', () => {
  it('reads npm metadata: majors, deprecation, monorepo folder, prereleases', () => {
    const info = npmInfo(
      '@acme/sdk',
      {
        name: '@acme/sdk',
        description: 'Acme SDK',
        repository: { url: 'git+https://github.com/acme/mono.git', directory: 'packages/sdk' },
        'dist-tags': { latest: '2.1.0' },
        time: {
          '1.0.0': '2025-01-01T00:00:00Z',
          '2.0.0': '2026-01-01T00:00:00Z',
          '2.1.0': '2026-02-01T00:00:00Z',
        },
        versions: {
          '1.0.0': { deprecated: 'Upgrade to 2.x' },
          '2.0.0': {},
          '2.1.0': { deprecated: 'This package moved to @acme/client' },
          '3.0.0-alpha.0': {},
        },
      },
      'https://registry.npmjs.org/@acme%2Fsdk',
      '2026-11-03',
    );
    expect(info).toMatchObject({
      ecosystem: 'npm',
      pageUrl: 'https://www.npmjs.com/package/@acme/sdk',
      latest: '2.1.0',
      latestAt: '2026-02-01',
      deprecated: 'This package moved to @acme/client',
      repository: 'https://github.com/acme/mono',
      repositoryDir: 'packages/sdk',
      upcoming: ['3.0.0-alpha.0'],
      versions: 4,
    });
    expect(info.majors.map((line) => [line.major, line.deprecated])).toEqual([
      [2, 'This package moved to @acme/client'],
      [1, 'Upgrade to 2.x'],
    ]);
    const text = renderPackage(info);
    expect(text).toContain(
      'Deprecated (registry message on the latest release): "This package moved to @acme/client"',
    );
    expect(text).toContain('Repository: https://github.com/acme/mono (folder packages/sdk)');
  });

  it('reads PyPI metadata and skips releases that cannot be installed', () => {
    const info = pypiInfo(
      'acme',
      {
        info: {
          name: 'acme',
          summary: 'Acme for Python',
          version: '1.1.0',
          project_urls: {
            Source: 'https://github.com/acme/acme-python',
            Changelog: 'https://github.com/acme/acme-python/blob/main/CHANGES.md',
          },
          classifiers: ['Development Status :: 7 - Inactive', 'License :: OSI Approved'],
        },
        releases: {
          '0.5.0': [{ upload_time_iso_8601: '2024-01-01T00:00:00Z' }],
          '1.0.0': [
            { upload_time_iso_8601: '2025-01-02T00:00:00Z' },
            { upload_time_iso_8601: '2025-01-01T00:00:00Z' },
          ],
          '1.1.0': [{ upload_time_iso_8601: '2025-06-01T00:00:00Z' }],
          '1.2.0': [{ upload_time_iso_8601: '2025-07-01T00:00:00Z', yanked: true }],
          '1.3.0': [],
        },
      },
      'https://pypi.org/pypi/acme/json',
      '2026-11-03',
    );
    expect(info).toMatchObject({
      ecosystem: 'pypi',
      latest: '1.1.0',
      latestAt: '2025-06-01',
      status: 'Development Status :: 7 - Inactive',
      repository: 'https://github.com/acme/acme-python',
      versions: 3,
    });
    expect(info.majors[0]).toMatchObject({
      major: 1,
      first: '1.0.0',
      firstAt: '2025-01-01',
      releases: 2,
    });
  });

  it('looks a name up in each registry it can be in; a 404 is "not there", other failures are listed', async () => {
    const calls: string[] = [];
    const json: JsonFetcher = {
      async json(url) {
        calls.push(url);
        if (url.includes('pypi.org')) return { ok: false, status: 503, url, error: 'HTTP 503' };
        return { ok: false, status: 404, url, error: 'HTTP 404' };
      },
    };
    const lookup = await registryClient({ json }).lookup('acme');
    expect(calls.sort()).toEqual([
      'https://pypi.org/pypi/acme/json',
      'https://registry.npmjs.org/acme',
    ]);
    expect(lookup.found).toEqual([]);
    expect(lookup.errors).toEqual(['pypi acme: HTTP 503']);
  });
});

describe('release notes', () => {
  it('finds a version section by its heading words, not by compare links naming it', () => {
    const changelog = [
      '# Changelog',
      '## [1.1.0](https://github.com/acme/sdk/compare/v1.0.0...v1.1.0) (2026-02-01)',
      '* add things',
      '## [1.0.0](https://github.com/acme/sdk/compare/v0.9.0...v1.0.0) (2026-01-01)',
      '### ⚠ BREAKING CHANGES',
      '* drop Node 18',
      '## 0.9.0',
      '* older',
    ].join('\n');
    const section = sectionFor(changelog, '1.0.0');
    expect(section?.text).toBe(
      '## [1.0.0](https://github.com/acme/sdk/compare/v0.9.0...v1.0.0) (2026-01-01)\n### ⚠ BREAKING CHANGES\n* drop Node 18',
    );
    expect(changelog.slice(section!.offset).startsWith('## [1.0.0]')).toBe(true);
    expect(sectionFor(changelog, '10.0.0')).toBeUndefined();
    expect(sectionFor('## 11.0.0\nx', '1.0.0')).toBeUndefined();
  });

  it('keeps a release body whole in a release list, whatever headings the body has', () => {
    const list = [
      '## v2.0.0 (v2.0.0, published 2026-01-01T00:00:00Z)',
      'https://github.com/acme/sdk/releases/tag/v2.0.0',
      "## What's Changed",
      '* removed `widgets.list`',
      '## v1.9.0 (v1.9.0, published 2025-12-01T00:00:00Z, prerelease)',
      '* fixes',
    ].join('\n');
    expect(
      RELEASE_HEADING.test('## v1.9.0 (v1.9.0, published 2025-12-01T00:00:00Z, prerelease)'),
    ).toBe(true);
    expect(sectionFor(list, '2.0.0', 2000, RELEASE_HEADING)?.text).toContain(
      '* removed `widgets.list`',
    );
  });

  it("reads each major's first release from the changelog, then from the GitHub releases", async () => {
    const info: PackageInfo = {
      ecosystem: 'npm',
      name: 'acme-node',
      registryUrl: 'https://registry.npmjs.org/acme-node',
      pageUrl: 'https://www.npmjs.com/package/acme-node',
      readAt: '2026-11-03',
      repository: 'https://github.com/acme/acme-node',
      majors: [
        { major: 3, first: '3.0.0', latest: '3.0.0', releases: 1 },
        { major: 2, first: '2.0.0', latest: '2.4.0', releases: 5 },
        { major: 1, first: '1.0.0', latest: '1.0.0', releases: 1 },
      ],
      versions: 7,
    };
    const pages: Record<string, string> = {
      'https://raw.githubusercontent.com/acme/acme-node/HEAD/CHANGELOG.md':
        '# Changelog\n## 3.0.0\n* rename charges\n## 2.4.0\n* fix',
      'https://api.github.com/repos/acme/acme-node/releases?per_page=100':
        '## v2.0.0 (v2.0.0, published 2025-01-01T00:00:00Z)\n* require an API key',
    };
    const read = async (url: string): Promise<FetchedPage> => ({
      url,
      status: pages[url] ? 200 : 404,
      ok: Boolean(pages[url]),
      fetchedAt: '2026-11-03T00:00:00.000Z',
      contentType: 'text/plain',
      text: pages[url] ?? '',
    });
    const result = await releaseNotesFor(info, read);
    expect(result.notes.map((note) => [note.version, note.url, note.excerpt])).toEqual([
      [
        '3.0.0',
        'https://raw.githubusercontent.com/acme/acme-node/HEAD/CHANGELOG.md',
        '## 3.0.0\n* rename charges',
      ],
      [
        '2.0.0',
        'https://api.github.com/repos/acme/acme-node/releases?per_page=100',
        '## v2.0.0 (v2.0.0, published 2025-01-01T00:00:00Z)\n* require an API key',
      ],
    ]);
    // The lowest line has nothing to upgrade from, so its notes are not read.
    expect(result.missing).toEqual([]);
    expect(result.sources.map((source) => source.id)).toEqual([
      'acme-node-npm-changelog',
      'acme-node-npm-releases',
      'acme-node-npm-readme',
    ]);
    expect(renderPackage(info, result)).toContain(
      'Release notes of 3.0.0, from https://raw.githubusercontent.com/acme/acme-node/HEAD/CHANGELOG.md (offset 12):',
    );
  });
});
