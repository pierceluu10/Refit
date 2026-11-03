import { beforeEach, describe, expect, it } from 'vitest';
import { clearFetchCache } from './fetch.ts';
import { createPackageLookupTool, githubRepo, packageReport, rawGithubUrl } from './packages.ts';
import { PageStore } from './pages.ts';
import { recorded, recordedFetch } from './testing.ts';
import {
  compareVersions,
  isPrerelease,
  majorOf,
  parseVersion,
  versionFromTag,
} from './versions.ts';

const RELEASES_API =
  'https://api.github.com/repos/anthropics/anthropic-sdk-typescript/releases?per_page=100';
const CHANGELOG_LATEST = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.4.0/CHANGELOG.md';

beforeEach(() => clearFetchCache());

describe('versions', () => {
  it('parses npm and PyPI versions and the ranges repos pin', () => {
    expect(parseVersion('^14.21.0')).toMatchObject({ major: 14, minor: 21, patch: 0, pre: '' });
    expect(parseVersion('v2.0.0-beta.3')).toMatchObject({ major: 2, pre: 'beta.3' });
    expect(parseVersion('==1.30.1rc1')).toMatchObject({
      major: 1,
      minor: 30,
      patch: 1,
      pre: 'rc1',
    });
    expect(parseVersion('1.2.3.post1')?.pre).toBe('');
    expect(majorOf('>=2,<3')).toBe(2);
    expect(majorOf('latest')).toBeUndefined();
    expect(isPrerelease('0.1.0rc2')).toBe(true);
    expect(isPrerelease('1.4.0')).toBe(false);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
    expect(versionFromTag('sdk-v1.4.0')).toBe('1.4.0');
    expect(versionFromTag('@scope/pkg@3.1.0')).toBe('3.1.0');
  });

  it('reads repository links in the forms registries use', () => {
    expect(githubRepo('git+https://github.com/stripe/stripe-node.git')).toBe(
      'https://github.com/stripe/stripe-node',
    );
    expect(githubRepo('github:octokit/rest.js')).toBe('https://github.com/octokit/rest.js');
    expect(githubRepo('https://github.com/o/r/tree/main/packages/x')).toBe(
      'https://github.com/o/r',
    );
    expect(githubRepo('https://gitlab.com/o/r')).toBeUndefined();
    expect(rawGithubUrl('https://github.com/o/r/blob/main/CHANGELOG.md')).toBe(
      'https://raw.githubusercontent.com/o/r/main/CHANGELOG.md',
    );
  });
});

describe('package_lookup on recorded registry responses', () => {
  it('reports an npm SDK with its release notes from GitHub releases, monorepo tags filtered', async () => {
    const fetch = recordedFetch();
    const out = await packageReport({ name: '@anthropic-ai/sdk', version: '^1.2.0' }, { fetch });
    expect(out).toContain(
      'npm package @anthropic-ai/sdk: https://www.npmjs.com/package/@anthropic-ai/sdk',
    );
    expect(out).toContain('Latest: 1.4.0');
    expect(out).toContain('Repository: https://github.com/anthropics/anthropic-sdk-typescript');
    expect(out).toContain('Pinned: ^1.2.0 (major 1); target 1.4.0 (major 1): same major.');
    expect(out).toMatch(/- 1\.x: 1\.0\.0 \(\d{4}-\d{2}-\d{2}\) to 1\.4\.0/);
    expect(out).toContain(
      'from GitHub releases of https://github.com/anthropics/anthropic-sdk-typescript',
    );
    expect(out).toContain('## 1.4.0');
    expect(out).toContain('## 1.3.0');
    // vertex-sdk-v1.1.1 and the other sub-packages' releases are not this package's.
    expect(out).not.toContain('## 1.1.1');
    // A scoped name is only on npm, so PyPI is never asked.
    expect(fetch.calls.some((call) => call.includes('pypi.org'))).toBe(false);
  });

  it('falls back to the CHANGELOG when the releases API is rate limited, and ranks by query', async () => {
    const fetch = recordedFetch({
      [RELEASES_API]: { status: 403, body: '{"message":"API rate limit exceeded"}' },
      [CHANGELOG_LATEST]: {
        status: 200,
        body: recorded('changelog-anthropic-sdk.md.txt'),
        contentType: 'text/markdown',
      },
    });
    const store = new PageStore();
    const out = await packageReport(
      {
        name: '@anthropic-ai/sdk',
        ecosystem: 'npm',
        version: '1.2.0',
        query: 'compaction limit',
        limit: 1,
      },
      { fetch },
      store,
    );
    expect(out).toContain(`from changelog ${CHANGELOG_LATEST}`);
    const shown = out.split('\n').filter((line) => /^## \d/.test(line));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatch(/^## 1\.4\.0 \(2026-11-02\)/);
    expect(out).toContain('compaction_limit_reached_error');
    // The changelog it read is kept for the docs search.
    expect(store.get(CHANGELOG_LATEST)?.text).toContain('## [1.4.0]');
  });

  it('shows a deprecated npm package and its deprecation message', async () => {
    const out = await packageReport(
      { name: 'request', ecosystem: 'npm', notes: false },
      { fetch: recordedFetch() },
    );
    expect(out).toContain('Latest: 2.88.2');
    expect(out).toContain(
      'Package: the latest version is deprecated: request has been deprecated, see https://github.com/request/request/issues/3142',
    );
    expect(out).toMatch(/- \S+ \.\. 2\.88\.2 \(\d+\): request has been deprecated/);
  });

  it('shows an inactive PyPI package and its yanked release', async () => {
    const out = await packageReport(
      { name: 'google-generativeai', ecosystem: 'pypi', version: '0.7.2' },
      { fetch: recordedFetch() },
    );
    expect(out).toContain(
      'pypi package google-generativeai: https://pypi.org/project/google-generativeai/',
    );
    expect(out).toContain('Latest: 0.8.6');
    expect(out).toContain('Package: classified "Development Status :: 7 - Inactive"');
    expect(out).toContain('- 0.1.0rc2: yanked:');
    // No release notes were recorded for its repo: the tool says where it looked.
    expect(out).toContain('No release notes in range');
    expect(out).toContain(
      'https://api.github.com/repos/google/generative-ai-python/releases?per_page=100',
    );
  });

  it('reads a PyPI package’s notes from the changelog its project_urls name', async () => {
    const fetch = recordedFetch();
    const out = await packageReport(
      { name: 'httpx', ecosystem: 'pypi', version: '==0.27.0' },
      { fetch },
    );
    expect(out).toContain('Latest: 0.28.1 (2024-12-06)');
    expect(out).toContain(
      'from changelog https://raw.githubusercontent.com/encode/httpx/master/CHANGELOG.md',
    );
    expect(out).toMatch(/## 0\.28\.1 \(2024-12-06\)/);
    // Under semver a 0.x minor may break, so it is marked and kept first.
    expect(out).toMatch(/## 0\.28\.0 \(2024-11-28\) \[0\.x minor: may break\]/);
    expect(out).toContain('The `verify` argument as a string argument is now deprecated');
    // The releases API was tried first and had nothing recorded (404).
    expect(fetch.calls[1]).toBe(
      'GET https://api.github.com/repos/encode/httpx/releases?per_page=100',
    );
  });

  it('says plainly when a name is on neither registry', async () => {
    const out = await packageReport({ name: 'no-such-package-here' }, { fetch: recordedFetch() });
    expect(out).toContain(
      'No registry data for "no-such-package-here" (npm: not found on npm; pypi: not found on pypi).',
    );
  });

  it('is a tool that asks for a name and lists the inventory packages it knows', async () => {
    const tool = createPackageLookupTool({ fetch: null, packages: ['openai (npm)'] });
    expect(tool.name).toBe('package_lookup');
    expect(tool.description).toContain('openai (npm)');
    expect(await tool.run({}, { repoDir: '.' })).toContain('Pass "name"');
    expect(await tool.run({ name: 'openai' }, { repoDir: '.' })).toContain('No registry data');
  });
});
