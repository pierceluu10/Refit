import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META_SDK } from './deadline-exposure.ts';
import type { EvidenceGrade } from './check-selection.ts';
import type { MetaGraphChange, MetaGraphChanges } from './meta-graph-changes.ts';
import {
  metaGraphEvidence,
  metaGraphGrade,
  probeGraphRequests,
  proveMetaGraphPatch,
  reviewMetaGraphPatch,
} from './meta-graph-proof.ts';
import { scanGraphCalls } from './meta-graph-calls.ts';
import { readRepository } from './repository.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-proof-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app' }),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return readRepository(root, META_SDK);
}

const source = (version: string) =>
  `https://developers.facebook.com/docs/graph-api/changelog/version${version.slice(1)}`;

// The casts keep these fixtures valid for ME2's table shape too (nullable version, replacement,
// appliesToAll, quote and released).
function change(
  overrides: Pick<MetaGraphChange, 'id' | 'kind' | 'name'> & { version: string },
): MetaGraphChange {
  return {
    node: null,
    edge: null,
    path: null,
    replacement: null,
    appliesToAll: null,
    quote: 'Quoted.',
    summary: `${overrides.id} changes.`,
    source: source(overrides.version),
    checkedAt: '2026-10-20',
    ...overrides,
  } as MetaGraphChange;
}

// Hypothetical: v18.0 to v25.0, all reviewed unless named.
function changes(entries: MetaGraphChange[] = [], unread: string[] = []): MetaGraphChanges {
  return {
    formatVersion: 1,
    provider: 'meta-graph',
    versions: Array.from({ length: 8 }, (_, index) => `v${18 + index}.0`).map((version) => ({
      version,
      status: unread.includes(version) ? ('unread' as const) : ('reviewed' as const),
      source: source(version),
      checkedAt: '2026-10-20',
      note: unread.includes(version) ? 'Not read.' : null,
      released: '2024-01-01',
    })) as MetaGraphChanges['versions'],
    changes: entries,
  };
}

const profile = (version: string, fields = 'id,name') =>
  `export async function profile(token) {\n  const response = await fetch(\`https://graph.facebook.com/${version}/me?fields=${fields}&access_token=\${token}\`);\n  return response.json();\n}\n`;

const typeChecked: EvidenceGrade = {
  letter: 'C',
  level: 'type-check',
  reason: 'tsc type-checks src/profile.ts; no test ran that code.',
};

async function proof(before: string, after: string, table = changes()) {
  return proveMetaGraphPatch(
    await repository({ 'src/profile.js': before }),
    await repository({ 'src/profile.js': after }),
    { changes: table },
  );
}

describe('field-table proof', () => {
  it('proves a version move whose request uses nothing the crossed versions change', async () => {
    const result = await proof(profile('v18.0'), profile('v21.0'));
    expect(result.proven).toBe(true);
    expect(result.target).toBe('v21.0');
    expect(result.requests).toMatchObject([
      { file: 'src/profile.js', from: 'v18.0', to: 'v21.0', crossed: ['v19.0', 'v20.0', 'v21.0'] },
    ]);
    const grade = metaGraphGrade(typeChecked, result);
    expect(grade).toMatchObject({ letter: 'C', level: 'type-check' });
    expect(grade?.reason).toContain('valid at v21.0 in the reviewed change table');
  });

  it('refuses a patched request that still asks for a field a crossed version removes', async () => {
    const table = changes([
      change({ id: 'user-name-removed', version: 'v20.0', kind: 'field-removed', name: 'name' }),
    ]);
    const result = await proof(profile('v18.0'), profile('v21.0'), table);
    expect(result.proven).toBe(false);
    expect(result.reasons.join(' ')).toContain('user-name-removed');
    expect(result.requests[0].fixed).toEqual(['user-name-removed']);
    expect(metaGraphGrade(typeChecked, result)).toMatchObject({ letter: 'D', level: 'none' });
  });

  it('proves a patch that drops the removed field, and records what it fixed', async () => {
    const table = changes([
      change({ id: 'user-name-removed', version: 'v20.0', kind: 'field-removed', name: 'name' }),
    ]);
    const result = await proof(profile('v18.0'), profile('v21.0', 'id,email'), table);
    expect(result.proven).toBe(true);
    expect(result.requests[0]).toMatchObject({ fixed: ['user-name-removed'], problems: [] });
  });

  it('refuses a move across an unreviewed changelog', async () => {
    const result = await proof(profile('v18.0'), profile('v21.0'), changes([], ['v20.0']));
    expect(result.proven).toBe(false);
    expect(result.reasons.join(' ')).toContain('v20.0 is not reviewed');
  });

  it('refuses a patch that changes no traced Graph request', async () => {
    const result = await proof(profile('v18.0'), `${profile('v18.0')}// comment\n`);
    expect(result.proven).toBe(false);
    expect(result.reasons).toEqual(['The patch changes no Graph API request Refit traced.']);
  });

  it('refuses WhatsApp requests, whose changelog the table does not cover', async () => {
    const send = (version: string) =>
      `export const send = (id, token, body) => fetch(\`https://graph.facebook.com/${version}/\${id}/messages\`, { method: 'POST', headers: { Authorization: \`Bearer \${token}\` }, body });\n`;
    const result = await proof(send('v18.0'), send('v21.0'));
    expect(result.proven).toBe(false);
    expect(result.reasons.join(' ')).toContain('WhatsApp Business Platform');
  });

  it('keeps grade D when no check covers the changed files, saying the table passed', () => {
    const grade = metaGraphGrade(
      { letter: 'D', level: 'none', reason: 'No check ran.' },
      { target: 'v21.0', proven: true, requests: [], reasons: [] },
    );
    expect(grade).toMatchObject({ letter: 'D' });
    expect(grade?.reason).toContain('No passing check covers the changed files.');
  });
});

describe('live proof', () => {
  // Fake shapes: an app access token (app_id|secret) and a test user token.
  const APP = `1234567890|${'a'.repeat(32)}`;
  const USER = `EAA${'x'.repeat(40)}`;
  const proven = { target: 'v21.0', proven: true, requests: [], reasons: [] };
  const appRead = (fields = 'id,name') =>
    `export const app = (token) => fetch(\`https://graph.facebook.com/v21.0/app?fields=${fields}&access_token=\${token}\`);\n`;
  async function calls(text: string) {
    return (await scanGraphCalls('', { repository: await repository({ 'src/a.js': text }) })).calls;
  }
  const answering = (body: unknown, status = 200) =>
    vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));

  it('does nothing without META_TEST_TOKEN', async () => {
    expect(await probeGraphRequests(await calls(profile('v21.0')), 'v21.0', {})).toBeUndefined();
  });

  it('proves an app-level read with the app token, sent in the header only', async () => {
    const request = answering({ id: '1', name: 'Refit Test' });
    const live = await probeGraphRequests(
      await calls(appRead()),
      'v21.0',
      { META_TEST_TOKEN: APP },
      request as unknown as typeof fetch,
    );
    expect(live).toMatchObject({
      proven: true,
      versionAccepted: true,
      probes: [{ path: '/app', status: 200 }],
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://graph.facebook.com/v21.0/app?fields=id',
      'https://graph.facebook.com/v21.0/app?fields=id%2Cname',
    ]);
    for (const [url, init] of request.mock.calls) {
      expect(url).not.toContain(APP);
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${APP}`);
    }
    expect(metaGraphGrade(typeChecked, proven, live)).toMatchObject({
      letter: 'A',
      level: 'live-requests',
    });
  });

  it('falls back to the field table for user requests the app token cannot read', async () => {
    const request = answering({ id: '1' });
    const live = await probeGraphRequests(
      await calls(profile('v21.0')),
      'v21.0',
      { META_TEST_TOKEN: APP },
      request as unknown as typeof fetch,
    );
    // Only the version check is sent.
    expect(request).toHaveBeenCalledTimes(1);
    expect(live).toMatchObject({ proven: false, versionAccepted: true, probes: [] });
    expect(live?.reasons[0]).toContain('needs user or page permissions');
    const grade = metaGraphGrade(typeChecked, proven, live);
    expect(grade).toMatchObject({ letter: 'C' });
    expect(grade?.reason).toContain('confirmed the Graph API serves v21.0');
    expect(grade?.reason).toContain('needs user or page permissions');
  });

  it('gives grade D when the Graph API refuses the target version', async () => {
    const live = await probeGraphRequests(
      await calls(profile('v21.0')),
      'v21.0',
      { META_TEST_TOKEN: APP },
      answering(
        { error: { message: 'Unknown path components: /v21.0' } },
        400,
      ) as unknown as typeof fetch,
    );
    expect(live?.versionAccepted).toBe(false);
    expect(metaGraphGrade(typeChecked, proven, live)).toMatchObject({ letter: 'D' });
  });

  it('keeps the table grade when the Graph API cannot be reached', async () => {
    const live = await probeGraphRequests(
      await calls(profile('v21.0')),
      'v21.0',
      { META_TEST_TOKEN: APP },
      (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    );
    expect(live?.versionAccepted).toBeNull();
    expect(metaGraphGrade(typeChecked, proven, live)).toMatchObject({ letter: 'C' });
  });

  it('reads /me with a test user token, and refuses a missing field', async () => {
    const live = await probeGraphRequests(
      await calls(profile('v21.0')),
      'v21.0',
      { META_TEST_TOKEN: USER },
      answering({ id: '1' }) as unknown as typeof fetch,
    );
    expect(live).toMatchObject({ proven: false, probes: [{ path: '/me', missing: ['name'] }] });
  });

  it('redacts the token from provider errors', async () => {
    const refused = await probeGraphRequests(
      await calls(appRead()),
      'v21.0',
      { META_TEST_TOKEN: APP },
      answering(
        { error: { message: `Invalid token ${APP} or ${USER}` } },
        400,
      ) as unknown as typeof fetch,
    );
    expect(refused?.proven).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(APP);
    expect(JSON.stringify(refused)).not.toContain(USER);
  });

  it('never sends writes or requests on customer objects', async () => {
    const request = answering({ id: '1' });
    const live = await probeGraphRequests(
      await calls(
        "export const post = (id) => fetch(`https://graph.facebook.com/v21.0/${id}/feed`, { method: 'POST' });\n",
      ),
      'v21.0',
      { META_TEST_TOKEN: APP },
      request as unknown as typeof fetch,
    );
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'https://graph.facebook.com/v21.0/app?fields=id',
    ]);
    expect(live?.proven).toBe(false);
  });

  it('refuses a token that is not shaped like a Graph token, without calling', async () => {
    const live = await probeGraphRequests([], 'v21.0', { META_TEST_TOKEN: 'sk_test_123' });
    expect(live).toMatchObject({ proven: false, versionAccepted: null, probes: [] });
  });
});

describe('AI second-opinion review', () => {
  const MODEL = 'gpt-5.4-mini';
  const answer = (text: string) =>
    Response.json({
      id: 'resp_review',
      model: MODEL,
      status: 'completed',
      usage: { input_tokens: 1000, output_tokens: 100 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    });

  it('records the verdict and its cost, advisory only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        answer(JSON.stringify({ verdict: 'concerns', summary: 'One read.', concerns: ['a:1'] })),
      ),
    );
    const review = await reviewMetaGraphPatch(
      { diff: '', proof: { target: 'v21.0', proven: true, requests: [], reasons: [] } },
      { apiKey: 'key', model: MODEL },
    );
    expect(review).toMatchObject({ advisoryOnly: true, verdict: 'concerns', concerns: ['a:1'] });
    expect(review.costUsd).toBeGreaterThan(0);
  });

  it('never changes the grade, and records a failed review instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );
    const original = await repository({ 'src/profile.js': profile('v18.0') });
    const patched = await repository({ 'src/profile.js': profile('v21.0') });
    const evidence = await metaGraphEvidence({
      original,
      patched,
      grade: typeChecked,
      diff: '',
      ai: { apiKey: 'key', model: MODEL },
      environment: {},
    });
    expect(evidence.grade?.letter).toBe(evidence.record.proof.proven ? 'C' : 'D');
    expect(evidence.record.review).toMatchObject({ advisoryOnly: true, costUsd: null });
    expect(evidence.record.review?.error).toBeDefined();
  });
});
