import { describe, expect, it } from 'vitest';
import type { MigrationKind } from '../../shared/types.ts';
import { checkCallSites, type CallSite } from './check-callsites.ts';
import { loadDevSet, type RepoEntry } from './index.ts';

const entry = (callSites: CallSite[]): RepoEntry => ({
  repo: 'o/r',
  commit: 'a'.repeat(40),
  callSites,
});

describe('checkCallSites', () => {
  it('passes lines that still read the same and names the ones that do not', async () => {
    const reads: string[] = [];
    const checks = await checkCallSites(
      [
        entry([
          { file: 'src/a.ts', line: 2, text: "fetch('https://old.example.com/v1')" },
          { file: 'src/a.ts', line: 3, text: 'return old' },
          { file: 'gone.ts', line: 1, text: 'x' },
        ]),
      ],
      async (_repo, _commit, file) => {
        reads.push(file);
        return file === 'src/a.ts'
          ? "import x\r\nfetch('https://old.example.com/v1')\r\nreturn new\r\n"
          : undefined;
      },
    );
    expect(checks).toEqual([
      { repo: 'o/r', file: 'src/a.ts', line: 2 },
      { repo: 'o/r', file: 'src/a.ts', line: 3, problem: 'line reads "return new"' },
      { repo: 'o/r', file: 'gone.ts', line: 1, problem: 'file not found at the pinned commit' },
    ]);
    expect(reads).toEqual(['src/a.ts', 'gone.ts']);
  });

  it('checks declaredIn lines the same way, after an entry’s call sites', async () => {
    const checks = await checkCallSites(
      [
        {
          ...entry([{ file: 'src/a.ts', line: 1, text: 'x' }]),
          declaredIn: [
            { file: '.nvmrc', line: 1, text: '16' },
            { file: 'package.json', line: 3, text: '    "node": "16.x"' },
          ],
        },
      ],
      async (_repo, _commit, file) =>
        ({
          'src/a.ts': 'x\n',
          '.nvmrc': '16\n',
          'package.json': '{\n  "engines": {\n    "node": "18.x"\n  }\n}\n',
        })[file],
    );
    expect(checks).toEqual([
      { repo: 'o/r', file: 'src/a.ts', line: 1 },
      { repo: 'o/r', file: '.nvmrc', line: 1 },
      {
        repo: 'o/r',
        file: 'package.json',
        line: 3,
        problem: `line reads ${JSON.stringify('    "node": "18.x"')}`,
      },
    ]);
  });
});

const KINDS: MigrationKind[] = [
  'api-version',
  'sdk-major',
  'field-removed',
  'field-renamed',
  'endpoint-removed',
  'rest-to-graphql',
  'auth-change',
  'webhook-payload',
  'model-retirement',
  'product-shutdown',
  'pagination-or-limits',
  'other',
];

describe('longtail-dev-20', () => {
  const set = loadDevSet('longtail-dev-20');

  it('holds 20 distinct repos, each naming its provider, its pending change and where it is', () => {
    expect(set.provider).toBe('mixed');
    expect(set.source.curated).toBeTruthy();
    expect(new Set(set.repos.map((repo) => repo.repo)).size).toBe(20);
    for (const repo of set.repos) {
      const change = repo.pendingChange as {
        kind: MigrationKind;
        source: { url: string; quote: string };
      };
      expect(typeof repo.provider, repo.repo).toBe('string');
      expect(['http', 'sdk', 'graphql', 'webhook']).toContain(repo.via);
      expect(KINDS).toContain(change.kind);
      expect(change.source.url, repo.repo).toMatch(/^https:\/\//);
      expect(change.source.quote.length, repo.repo).toBeGreaterThan(10);
      expect((repo.callSites as CallSite[]).length, repo.repo).toBeGreaterThan(0);
    }
  });

  it('covers the long tail: many providers and every way of reaching an API', () => {
    expect(new Set(set.repos.map((repo) => repo.provider)).size).toBeGreaterThanOrEqual(10);
    expect(new Set(set.repos.map((repo) => repo.via))).toEqual(
      new Set(['http', 'sdk', 'graphql', 'webhook']),
    );
  });
});
