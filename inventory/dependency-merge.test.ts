import { describe, expect, it } from 'vitest';
import type { ApiUsage } from '../shared/types.ts';
import { mergeApiUsages } from './dependency-merge.ts';
import type { DependencyFinding } from './dependency-merge.ts';

const REPO = 'acme/app';

function library(name: string, pkg?: string): DependencyFinding {
  return {
    repo: REPO,
    kind: 'library',
    name,
    ecosystem: 'npm',
    version: '^4',
    declaredIn: [{ file: `${pkg ?? '.'}/package.json` }],
    ...(pkg ? { package: pkg } : {}),
  };
}

function usage(overrides: Partial<ApiUsage>): ApiUsage {
  return { repo: REPO, provider: 'openai', via: 'sdk', callSites: [], ...overrides };
}

describe('mergeApiUsages', () => {
  it('attaches an SDK usage to its library and also yields the pinned API', () => {
    const merged = mergeApiUsages(
      [library('openai')],
      [
        usage({
          sdk: { name: 'openai', version: '4.20.1', lockfile: 'package-lock.json' },
          pinnedVersion: { value: '2024-06-01', file: 'src/client.ts', line: 3 },
          callSites: [{ file: 'src/summarize.js', line: 6, operation: 'chat.completions.create' }],
          hints: { hosts: ['api.openai.com'] },
        }),
      ],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      kind: 'sdk',
      name: 'openai',
      version: '^4',
      hints: { hosts: ['api.openai.com'] },
      callSites: [{ file: 'src/summarize.js', line: 6 }],
    });
    expect(merged[1]).toEqual({
      repo: REPO,
      kind: 'api',
      name: 'openai',
      ecosystem: 'openai',
      version: '2024-06-01',
      declaredIn: [{ file: 'src/client.ts', line: 3 }],
      callSites: [{ file: 'src/summarize.js', line: 6, operation: 'chat.completions.create' }],
      hints: { hosts: ['api.openai.com'] },
      notes: 'sdk',
    });
  });

  it('creates an SDK finding when no dependency has the name', () => {
    const [created, ...rest] = mergeApiUsages(
      [],
      [
        usage({
          sdk: { name: 'stripe', version: '12.0.0', lockfile: 'poetry.lock' },
          callSites: [{ file: 'app.py', line: 9, operation: 'Charge.create' }],
        }),
      ],
    );
    expect(rest).toEqual([]);
    expect(created).toEqual({
      repo: REPO,
      kind: 'sdk',
      name: 'stripe',
      version: '12.0.0',
      declaredIn: [{ file: 'poetry.lock' }],
      callSites: [{ file: 'app.py', line: 9, operation: 'Charge.create' }],
    });
  });

  it('routes call sites to the monorepo package that contains them', () => {
    const findings = [
      library('next', '.'),
      library('next', 'apps/web'),
      library('next', 'apps/admin'),
    ];
    const merged = mergeApiUsages(findings, [
      usage({
        sdk: { name: 'next', version: '14' },
        callSites: [
          { file: 'apps/web/src/ai.ts', line: 4, operation: 'a' },
          { file: 'apps/admin/src/x.ts', line: 1, operation: 'b' },
          { file: 'scripts/build.ts', line: 2, operation: 'c' },
          { file: 'apps/webby/y.ts', line: 1, operation: 'd' },
        ],
      }),
    ]);
    const operations = merged.map((finding) => finding.callSites?.map((site) => site.operation));
    expect(operations).toEqual([['c', 'd'], ['a'], ['b']]);
  });

  it('sends unmatched call sites to the first finding when no root package exists', () => {
    const merged = mergeApiUsages(
      [library('next', 'apps/web'), library('next', 'apps/admin')],
      [
        usage({
          sdk: { name: 'next', version: '14' },
          callSites: [{ file: 'lib/z.ts', line: 1, operation: 'z' }],
        }),
      ],
    );
    expect(merged[0].callSites).toHaveLength(1);
    expect(merged[1].callSites).toEqual([]);
  });

  it('turns HTTP and webhook usages of one provider into a single API entry', () => {
    const merged = mergeApiUsages(
      [],
      [
        usage({
          provider: 'stripe',
          via: 'http',
          callSites: [{ file: 'a.ts', line: 1, operation: 'POST /v1/charges' }],
          hints: { hosts: ['api.stripe.com'] },
        }),
        usage({
          provider: 'stripe',
          via: 'webhook',
          callSites: [
            { file: 'a.ts', line: 1, operation: 'POST /v1/charges' },
            { file: 'hook.ts', line: 5, operation: 'charge.succeeded' },
          ],
          hints: { hosts: ['api.stripe.com'], docsUrls: ['https://docs.stripe.com/changelog'] },
        }),
        usage({ provider: 'github', via: 'graphql' }),
      ],
    );
    expect(merged.map((finding) => finding.name)).toEqual(['stripe', 'github']);
    expect(merged[0]).toMatchObject({
      kind: 'api',
      notes: 'http, webhook',
      callSites: [
        { file: 'a.ts', line: 1 },
        { file: 'hook.ts', line: 5 },
      ],
      hints: { hosts: ['api.stripe.com'], docsUrls: ['https://docs.stripe.com/changelog'] },
    });
    expect(merged[0].version).toBeUndefined();
    expect(merged[1]).toMatchObject({ notes: 'graphql', declaredIn: [], callSites: [] });
  });

  it('merges hints into existing findings and does not mutate its inputs', () => {
    const findings = [{ ...library('openai'), hints: { packages: ['openai'] } }];
    const usages = [
      usage({
        sdk: { name: 'openai', version: '4' },
        pinnedVersion: { value: 'v1', file: 'c.ts', line: 1 },
        callSites: [{ file: 'a.ts', line: 1, operation: 'x' }],
        hints: { packages: ['openai', 'openai-edge'], hosts: ['api.openai.com'] },
      }),
    ];
    const before = structuredClone({ findings, usages });
    const merged = mergeApiUsages(findings, usages);
    expect(merged[0].hints).toEqual({
      packages: ['openai', 'openai-edge'],
      hosts: ['api.openai.com'],
    });
    expect({ findings, usages }).toEqual(before);
    expect(merged[0]).not.toBe(findings[0]);
  });

  it('keeps unrelated findings, their order, and appends new entries', () => {
    const findings = [
      library('react'),
      library('openai'),
      { ...library('node'), kind: 'runtime' as const },
    ];
    const merged = mergeApiUsages(findings, [
      usage({ sdk: { name: 'node', version: '20' }, callSites: [] }),
    ]);
    expect(merged.map((finding) => `${finding.kind}:${finding.name}`)).toEqual([
      'library:react',
      'library:openai',
      'runtime:node',
      'sdk:node',
    ]);
  });
});
