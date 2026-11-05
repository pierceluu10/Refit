import { describe, expect, it } from 'vitest';
import type { DeadApiEntry, FutureShutdown } from '../shared/types.ts';
import {
  buildList,
  DeadApiListError,
  entriesInForce,
  inForceVersion,
  listProblems,
  loadDeadApis,
  readProviderFiles,
  shutdownsArrived,
  type ProviderFile,
} from './list.ts';
import { textMatches, urlMatches } from './match.ts';

const LIST_DATE = '2026-11-05';

function entry(overrides: Partial<DeadApiEntry> = {}): DeadApiEntry {
  return {
    id: 'AN-1.old',
    provider: 'anthropic',
    what: 'old model',
    diedOn: '2026-01-01',
    source: { url: 'https://platform.claude.com/x', checkedOn: '2026-11-04' },
    lookFor: ['old-model'],
    matchers: [{ kind: 'string', value: 'old-model' }],
    replacement: 'new-model',
    replacementIds: ['new-model'],
    requires: [],
    ...overrides,
  };
}

function future(overrides: Partial<FutureShutdown> = {}): FutureShutdown {
  return {
    id: 'AN-9.soon',
    provider: 'anthropic',
    what: 'dying model',
    diesOn: '2027-01-01',
    source: { url: 'https://platform.claude.com/x', checkedOn: '2026-11-04' },
    matchers: [{ kind: 'string', value: 'dying-model' }],
    replacement: 'new-model',
    ...overrides,
  };
}

const file = (entries: DeadApiEntry[], shutdowns: FutureShutdown[] = []): ProviderFile => ({
  provider: 'anthropic',
  officialHosts: ['claude.com'],
  entries,
  future: shutdowns,
});

describe('the kept list', () => {
  const files = readProviderFiles();
  const list = loadDeadApis();

  it('holds every hand-written provider and passes its own checks', () => {
    console.log(
      files.map((one) => `${one.provider}: ${one.entries.length} + ${one.future.length} future`),
    );
    expect(files.map((one) => one.provider)).toEqual(
      expect.arrayContaining([
        'anthropic',
        'cohere',
        'gemini',
        'google-analytics',
        'groq',
        'openai',
        'pinecone',
        'sentry',
        'stripe',
        'supabase',
        'upstash',
        'vercel',
      ]),
    );
    expect(listProblems(files)).toEqual([]);
  });

  it('gives every entry a source, a checked date, a replacement and something to match', () => {
    for (const one of list.entries) {
      expect(one.source.url, one.id).toMatch(/^https:\/\//);
      expect(one.source.checkedOn, one.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(one.replacement.trim(), one.id).not.toBe('');
      expect(one.matchers.length, one.id).toBeGreaterThan(0);
    }
  });

  it('flags nothing still alive, and keeps announced shutdowns apart', () => {
    for (const one of list.entries) expect(one.diedOn <= LIST_DATE, one.id).toBe(true);
    for (const one of list.future) expect(one.diesOn > one.source.checkedOn, one.id).toBe(true);
    const flagged = list.entries.flatMap((one) => one.matchers.map((matcher) => matcher.value));
    for (const alive of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'o3']) {
      expect(flagged, alive).not.toContain(alive);
    }
    expect(list.future.flatMap((one) => one.matchers.map((matcher) => matcher.value))).toEqual(
      expect.arrayContaining(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5-20250929']),
    );
  });

  it('carries the changes the list test found, on the entry that needs them', () => {
    const anthropic = list.entries.find((one) => one.id === 'AN-1.claude-sonnet-4-20250514');
    const requires = anthropic?.requires.join(' ').toLowerCase() ?? '';
    for (const word of ['thinking', 'max_tokens', 'prefill', 'temperature']) {
      expect(requires, word).toContain(word);
    }
    const periods = list.entries.find((one) => one.id === 'ST-1.current_period_end');
    expect(periods?.appliesTo?.apiVersionSince).toBe('2025-03-31.basil');
    expect(periods?.requires.join(' ').toLowerCase()).toContain('webhook');
  });

  it('names a Groq replacement that is alive, following the chain', () => {
    const llama = list.entries.find((one) => one.id === 'GR-1.llama-3.3-70b-versatile');
    expect(llama?.replacementIds).toContain('openai/gpt-oss-120b');
    expect(llama?.context?.hosts).toContain('api.groq.com');
  });
});

describe('the entries from the first read of unlisted providers', () => {
  const list = loadDeadApis();
  const hits = (id: string, text: string) => {
    const found = list.entries.find((one) => one.id === id);
    expect(found, id).toBeDefined();
    return found!.matchers.some((matcher) =>
      matcher.kind === 'url'
        ? urlMatches(matcher, text)
        : matcher.kind === 'string' || matcher.kind === 'regex'
          ? textMatches(matcher, text)
          : false,
    );
  };

  it.each<[string, string, string[], string[]]>([
    [
      'cohere embed',
      'CO-1.embed-english-v2.0',
      ['co.embed(texts=t, model="embed-english-v2.0")'],
      ['model="embed-english-v3.0"', 'model="cohere.embed-english-v2.0"', 'embed-v4.0'],
    ],
    [
      'cohere multilingual, as Cohere spells it',
      'CO-1.embed-multilingual-v2.0',
      ['model: "embed-multilingual-v2.0"'],
      ['model: "embed-multilingual-v3.0"', 'model: "embed-multilingual-light-v3.0"'],
    ],
    [
      'cohere aya',
      'CO-1.c4ai-aya-expanse-8b',
      ['model="c4ai-aya-expanse-8b"'],
      ['model="c4ai-aya-expanse-32b"', 'model="command-a-03-2025"'],
    ],
    [
      'cohere rerank',
      'CO-2.rerank-english-v2.0',
      ['model="rerank-english-v2.0"'],
      ['model="rerank-english-v3.0"', 'model="rerank-v3.5"'],
    ],
    [
      'cohere fine-tuning',
      'CO-3.finetuning',
      [
        'requests.get("https://api.cohere.com/v1/finetuning/finetuned-models")',
        'co.finetuning.list_finetuned_models()',
        'await cohere.finetuning.createFinetunedModel(body)',
      ],
      ['client.fine_tuning.jobs.create()', 'import { finetuning } from "./finetuning"', '/v1/chat'],
    ],
    [
      'pinecone sse',
      'PI-1.assistant-mcp-sse',
      [
        'new URL("https://prod-1-data.ke.pinecone.io/mcp/assistants/docs/sse")',
        'const url = `${host}/mcp/assistants/${name}/sse`;',
      ],
      [
        'new URL("https://prod-1-data.ke.pinecone.io/mcp/assistants/docs")',
        '/mcp/assistants/docs/sse-logs',
        '/mcp/sse',
      ],
    ],
    [
      'sentry',
      'SN-1.sendDefaultPii',
      ['Sentry.init({ sendDefaultPii: true });', 'if (options.sendDefaultPii) {'],
      ['Sentry.init({ dataCollection: {} });', 'sentry_sdk.init(send_default_pii=True)'],
    ],
    [
      'supabase',
      'SU-1.logs.all',
      ['`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs.all?sql=${q}`'],
      [
        '`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs?sql=${q}`',
        'await db.logs.all()',
        'http://analytics:4000/api/endpoints/query/logs.all',
        '/analytics/endpoints/logs.allowed',
      ],
    ],
    [
      'upstash serve options',
      'UP-1.serve-options',
      [
        'serve(async (context) => {\n  await context.run("a", go);\n}, {\n  retries: 3,\n});',
        'serve<Payload>(async (context) => { go(); }, { failureUrl: url });',
        'export const { POST } = serve(handler, { flowControl: { key: "k", rate: 1 } });',
        'serve(handler, {\n  receiver,\n  retryDelay: "1000",\n});',
      ],
      [
        'serve(async (context) => {\n  await context.call("a", { url, retries: 3 });\n});',
        'await client.trigger({ url, retries: 3, retryDelay: "1000", failureUrl: u });',
        'serve(handler);',
        'Bun.serve({ fetch() {}, }, { retries: 3 });',
        'serveMany({ a, b }, { retries: 3 });',
      ],
    ],
    [
      'upstash global parallelism',
      'UP-2.global-parallelism-wait-list',
      ['const r = await get("/v2/globalParallelism");\nreturn r.waitListSize;'],
      [
        'const r = await get("/v2/globalParallelism");\nreturn r.parallelismMax;',
        'const r = await get("/v2/flowControl/k");\nreturn r.waitListSize;',
      ],
    ],
    [
      'vercel domains',
      'VE-1.legacy-domains',
      [
        'fetch("https://api.vercel.com/v4/domains/price?name=a.com")',
        'fetch(`https://api.vercel.com/v4/domains/status?name=${d}`)',
        'fetch("https://api.vercel.com/v5/domains/buy", opts)',
        'fetch(`https://api.vercel.com/v1/domains/${d}/registry`)',
        'await vercel.domains.checkDomainPrice({ name })',
        'await domainsBuyDomain(vercel, { body })',
      ],
      [
        'fetch("https://api.vercel.com/v5/domains")',
        'fetch(`https://api.vercel.com/v5/domains/${d}`)',
        'fetch(`https://api.vercel.com/v1/registrar/domains/${d}/price`)',
        'await vercel.domainsRegistrar.getDomainPrice({ domain })',
        'await vercel.domains.getDomain({ domain })',
      ],
    ],
    [
      'vercel login',
      'VE-2.cli-login-methods',
      ['vercel login --github', 'npx vercel login --oob', 'vercel login me@example.com'],
      ['vercel login', 'vercel login && vercel deploy', 'vercel deploy --github'],
    ],
  ])('%s: hits the dead use and not the live one beside it', (_name, id, dead, live) => {
    for (const line of dead) expect(hits(id, line), line).toBe(true);
    for (const line of live) expect(hits(id, line), line).toBe(false);
  });

  it('gates the two SDK removals on the version that made them', () => {
    const gate = (id: string) => list.entries.find((one) => one.id === id)?.appliesTo?.sdkSince;
    expect(gate('SN-1.sendDefaultPii')).toContainEqual({
      package: '@sentry/nextjs',
      version: '11.0.0',
      ecosystem: 'npm',
    });
    expect(gate('SN-1.sendDefaultPii')?.map((one) => one.package)).not.toContain(
      '@sentry/react-native',
    );
    expect(gate('UP-1.serve-options')).toEqual([
      { package: '@upstash/workflow', version: '1.0.0', ecosystem: 'npm' },
    ]);
  });

  it('asks a fix to drop what must go, in words a fix can find', () => {
    const requires = (id: string) =>
      list.entries.find((one) => one.id === id)?.requires.join('\n') ?? '';
    expect(requires('SN-1.sendDefaultPii')).toMatch(/Remove sendDefaultPii/);
    expect(requires('UP-1.serve-options')).toMatch(/Remove retries/);
    expect(requires('VE-2.cli-login-methods')).toMatch(/Remove --github/);
  });
});

describe('listProblems', () => {
  it('passes a good file', () => {
    expect(listProblems([file([entry()], [future()])])).toEqual([]);
  });

  it('trusts only the named part of a shared host', () => {
    const on = (url: string) => {
      const scoped = { ...file([entry({ source: { url, checkedOn: '2026-11-04' } })]) };
      return listProblems([{ ...scoped, officialHosts: ['github.com/acme'] }]);
    };
    expect(on('https://github.com/acme/sdk/blob/main/CHANGES.md')).toEqual([]);
    expect(on('https://github.com/someone-else/sdk/blob/main/CHANGES.md')[0]).toMatch(/official/);
    expect(on('https://github.com/acme-evil/sdk')[0]).toMatch(/official/);
  });

  it.each<[string, Partial<DeadApiEntry>, RegExp]>([
    [
      'an unofficial source',
      { source: { url: 'https://blog.example.com', checkedOn: '2026-11-04' } },
      /official/,
    ],
    [
      'plain http',
      { source: { url: 'http://platform.claude.com', checkedOn: '2026-11-04' } },
      /official/,
    ],
    ['no checked date', { source: { url: 'https://claude.com', checkedOn: 'soon' } }, /checkedOn/],
    ['a date after it was checked', { diedOn: '2027-01-01' }, /future/],
    ['no replacement', { replacement: ' ' }, /no replacement/],
    ['no matchers', { matchers: [] }, /no matchers/],
    ['a bad id', { id: 'nope' }, /doesn't match/],
    ['another provider', { provider: 'openai' }, /wrong provider/],
  ])('rejects %s', (_name, overrides, problem) => {
    expect(listProblems([file([entry(overrides)])]).join('\n')).toMatch(problem);
  });

  it('rejects a replacement that is itself dead or dying', () => {
    const dead = entry({ id: 'AN-1.dead', matchers: [{ kind: 'string', value: 'new-model' }] });
    expect(listProblems([file([entry(), dead])]).join('\n')).toMatch(/new-model is dead/);
    const dying = future({ matchers: [{ kind: 'string', value: 'new-model' }] });
    expect(listProblems([file([entry()], [dying])]).join('\n')).toMatch(/new-model is dying/);
  });

  it('rejects a replacement that a dead wildcard covers, and leaves a live one alone', () => {
    const wildcard = entry({
      id: 'AN-1.older',
      matchers: [{ kind: 'string', value: 'older-*' }],
      replacementIds: [],
    });
    const covered = entry({ replacementIds: ['older-2'] });
    expect(listProblems([file([covered, wildcard])]).join('\n')).toMatch(/older-2 is dead/);
    expect(listProblems([file([entry(), wildcard])])).toEqual([]);
  });

  it('refuses an impossible date, and tells apart one field on two owners', () => {
    expect(listProblems([file([entry({ diedOn: '2026-02-31' })])]).join('\n')).toMatch(
      /not a date/,
    );
    const field = (id: string, on: string[]) =>
      entry({ id, replacementIds: [], matchers: [{ kind: 'field', value: 'period', on }] });
    expect(listProblems([file([field('AN-1.a', ['one']), field('AN-1.b', ['two'])])])).toEqual([]);
    expect(listProblems([file([field('AN-1.a', ['one']), field('AN-1.b', ['one'])])])).not.toEqual(
      [],
    );
  });

  it('rejects one name that is both dead and dying, and a shutdown already past', () => {
    const both = future({ matchers: [{ kind: 'string', value: 'old-model' }] });
    expect(listProblems([file([entry()], [both])]).join('\n')).toMatch(/also dead/);
    const past = future({ diesOn: '2026-01-01' });
    expect(listProblems([file([], [past])]).join('\n')).toMatch(/it's dead/);
  });

  it('rejects a duplicate id and a repeated matcher', () => {
    expect(listProblems([file([entry(), entry()])]).join('\n')).toMatch(/duplicate id/);
    const repeat = entry({ id: 'AN-1.other', replacementIds: [] });
    expect(listProblems([file([entry(), repeat])]).join('\n')).toMatch(/repeats old-model/);
  });

  it('makes buildList throw with every problem listed', () => {
    const broken = file([entry({ replacement: '', matchers: [] })]);
    expect(() => buildList([broken])).toThrow(DeadApiListError);
    try {
      buildList([broken]);
    } catch (error) {
      expect((error as DeadApiListError).problems).toHaveLength(2);
    }
  });
});

describe('buildList and entriesInForce', () => {
  it('changes the version when an entry changes, and only then', () => {
    const before = buildList([file([entry()])]).version;
    expect(buildList([file([entry()])]).version).toBe(before);
    expect(buildList([file([entry({ what: 'other' })])]).version).not.toBe(before);
  });

  it('leaves a date the provider calls the earliest possible to a source read', () => {
    const list = buildList([file([], [future({ earliest: true })])]);
    expect(entriesInForce(list, '2028-01-01')).toEqual([]);
  });

  it('never counts a future shutdown before its date, and counts it from that date', () => {
    const list = buildList([file([entry()], [future({ diesOn: '2027-01-01' })])]);
    expect(entriesInForce(list, '2026-12-31').map((one) => one.id)).toEqual(['AN-1.old']);
    const arrived = entriesInForce(list, '2027-01-01');
    expect(arrived.map((one) => one.id)).toEqual(['AN-1.old', 'AN-9.soon']);
    expect(arrived[1].diedOn).toBe('2027-01-01');
  });
});

describe('inForceVersion', () => {
  const SOON = '2027-01-01';
  const DAY_BEFORE = '2026-12-31';

  it('moves when the list gains an entry', () => {
    const before = inForceVersion(buildList([file([entry()])]), LIST_DATE);
    const gained = entry({
      id: 'AN-2.other',
      matchers: [{ kind: 'string', value: 'other-model' }],
    });
    expect(inForceVersion(buildList([file([entry(), gained])]), LIST_DATE)).not.toBe(before);
  });

  it('moves on the day a shutdown arrives, and not the day before', () => {
    const list = buildList([file([entry()], [future({ diesOn: SOON })])]);
    expect(inForceVersion(list, DAY_BEFORE)).toBe(inForceVersion(list, LIST_DATE));
    expect(inForceVersion(list, SOON)).not.toBe(inForceVersion(list, DAY_BEFORE));
    expect(inForceVersion(list, '2027-06-01')).toBe(inForceVersion(list, SOON));
  });

  it('stays put for a date the provider calls earliest possible', () => {
    const list = buildList([file([entry()], [future({ diesOn: SOON, earliest: true })])]);
    expect(inForceVersion(list, '2030-01-01')).toBe(inForceVersion(list, LIST_DATE));
  });

  it("stays put for what can't change a scan today, though list.version moves", () => {
    const base = buildList([file([entry()])]);
    const withFuture = buildList([file([entry()], [future()])]);
    expect(withFuture.version).not.toBe(base.version);
    expect(inForceVersion(withFuture, LIST_DATE)).toBe(inForceVersion(base, LIST_DATE));

    const source = { url: 'https://platform.claude.com/x', checkedOn: '2026-11-05' };
    const rechecked = buildList([file([entry({ source })])]);
    expect(rechecked.version).not.toBe(base.version);
    expect(inForceVersion(rechecked, LIST_DATE)).toBe(inForceVersion(base, LIST_DATE));
  });
});

describe('shutdownsArrived', () => {
  const list = buildList([
    file(
      [entry()],
      [
        future({ id: 'AN-9.a', diesOn: '2026-11-10' }),
        future({
          id: 'AN-9.b',
          diesOn: '2026-11-12',
          matchers: [{ kind: 'string', value: 'b-model' }],
        }),
        future({
          id: 'AN-9.c',
          diesOn: '2026-11-12',
          earliest: true,
          matchers: [{ kind: 'string', value: 'c-model' }],
        }),
      ],
    ),
  ]);
  const ids = (after: string, today: string) =>
    shutdownsArrived(list, after, today).map((one) => one.id);

  it('holds what came into force after one day, up to and including another', () => {
    expect(ids('2026-11-09', '2026-11-10')).toEqual(['AN-9.a']);
    expect(ids('2026-11-10', '2026-11-11')).toEqual([]);
    expect(ids('2026-11-05', '2026-11-30')).toEqual(['AN-9.a', 'AN-9.b']);
  });
});
