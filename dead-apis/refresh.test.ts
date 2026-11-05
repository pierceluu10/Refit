import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchedPage, Fetcher } from '../providers/core/fetch.ts';
import { watchCostReport } from '../providers/core/watch-cache.ts';
import type { ProviderChange, ScanResult } from '../shared/types.ts';
import { entriesInForce, loadDeadApis, type ProviderFile } from './list.ts';
import { readProposals, refuseEntry, settleChanges, UnknownEntryError } from './proposals.ts';
import { enqueueUnlisted, markRead, nextInQueue, readQueue } from './queue.ts';
import { READ_USD, refresh, refreshFinished, type ReadSource } from './refresh.ts';

const TODAY = '2026-11-05';
const SEEDED_ON = '2026-11-01';
const NOW = () => new Date(`${TODAY}T12:00:00Z`);
const PAGE_URL = 'https://docs.acme.dev/changelog';
const QUOTE = 'The widget-1 model shuts down on October 1, 2026.';
const PAGE = `Changelog\n\nThe   widget-1\nmodel shuts down on October 1, 2026.\nModels: widget-2, gadget-3-mini. POST /v2/widgets is the new path. legacy_id is gone.`;

const seed: ProviderFile = {
  provider: 'acme',
  officialHosts: ['docs.acme.dev'],
  entries: [
    {
      id: 'AC-1.old-model',
      provider: 'acme',
      what: 'old model',
      diedOn: '2026-01-01',
      source: { url: PAGE_URL, checkedOn: SEEDED_ON, quote: 'old' },
      lookFor: ['old-model'],
      matchers: [
        { kind: 'string', value: 'old-model' },
        { kind: 'string', value: 'older-*' },
      ],
      replacement: 'widget-2',
      replacementIds: ['widget-2'],
      requires: [],
    },
  ],
  future: [],
};

function change(overrides: Partial<ProviderChange> = {}): ProviderChange {
  return {
    provider: 'acme',
    id: 'acme:widget-1',
    kind: 'model-retirement',
    title: 'widget-1 retired',
    effectiveDate: '2026-10-01',
    source: { url: PAGE_URL, quote: QUOTE },
    affects: { operations: ['widget-1'] },
    ...overrides,
  };
}

/** A change whose quote gives its date, on a page that holds that quote. */
function dated(effectiveDate: string, quote: string, overrides: Partial<ProviderChange> = {}) {
  return {
    change: change({ effectiveDate, source: { url: PAGE_URL, quote }, ...overrides }),
    fake: fakeFetcher({ [PAGE_URL]: `${PAGE}\n${quote}` }),
  };
}

const quoted = (quote: string, overrides: Partial<ProviderChange> = {}) =>
  change({ source: { url: PAGE_URL, quote }, ...overrides });

function fakeFetcher(pages: Record<string, string> = { [PAGE_URL]: PAGE }) {
  const fetch = vi.fn(async (url: string): Promise<FetchedPage> => {
    const text = pages[url];
    return {
      url,
      status: text === undefined ? 404 : 200,
      ok: text !== undefined,
      fetchedAt: `${TODAY}T00:00:00Z`,
      contentType: 'text/html',
      text: text ?? '',
      ...(text === undefined ? { error: 'not found' } : {}),
    };
  });
  return { fetch, fetcher: { fetch } as Fetcher };
}

function fakeRead(changes: ProviderChange[] = [], costUsd = 0.25) {
  return vi.fn<ReadSource>(async () => ({ changes, finished: true, costUsd }));
}

let root: string;
let dataDir: string;
let storeDir: string;
let cacheDir: string;

const dataFile = (name: string) =>
  JSON.parse(readFileSync(path.join(dataDir, `${name}.json`), 'utf8')) as ProviderFile;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'dead-apis-'));
  dataDir = mkdtempSync(path.join(root, 'data-'));
  storeDir = path.join(root, 'store');
  cacheDir = path.join(root, 'cache');
  writeFileSync(path.join(dataDir, 'acme.json'), JSON.stringify(seed));
  vi.stubEnv('APTITUDE_AI_BUDGET_USD', '10');
  vi.stubEnv('APTITUDE_WATCH_REFRESH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const settle = (changes: ProviderChange[], { fetcher } = fakeFetcher(), dryRun = false) =>
  settleChanges({
    provider: 'acme',
    changes,
    today: TODAY,
    fetcher,
    storeDir,
    dataDir,
    dryRun,
  });

describe('going live', () => {
  it('writes a backed change to the list, whitespace aside, so the version changes', async () => {
    const before = loadDeadApis(dataDir);
    const [proposal] = await settle([change()]);
    expect(proposal.status).toBe('live');
    const after = loadDeadApis(dataDir);
    expect(after.version).not.toBe(before.version);
    const entry = after.entries.find((one) => one.id === 'AC-100.widget-1');
    expect(entry?.source.quote).toBe(QUOTE);
    expect(entry?.diedOn).toBe('2026-10-01');
    expect(await readProposals(storeDir)).toEqual([proposal]);
  });

  it.each<[string, Partial<ProviderChange>, RegExp]>([
    ['no quote', { source: { url: PAGE_URL, quote: '  ' } }, /no source quote/],
    [
      'a quote not on the page',
      { source: { url: PAGE_URL, quote: 'widget-1 lives forever' } },
      /quote isn't on/,
    ],
    ['a made-up replacement model', { title: 'widget-1 retired, use widget-9' }, /widget-9 isn't/],
    ['a made-up replacement path', { title: 'gone; use /v9/widgets' }, /\/v9\/widgets isn't/],
    ['a replacement only part of a live name', { title: 'gone: use gadget-3' }, /gadget-3 isn't/],
    ['a replacement that is itself dead', { title: 'gone: use old-model' }, /old-model is dead/],
    [
      'an unofficial host',
      { source: { url: 'https://blog.example.com/acme', quote: QUOTE } },
      /official/,
    ],
    ['no date, since a date is never guessed', { effectiveDate: undefined }, /diedOn/],
    ['nothing to match on', { affects: {} }, /no matchers/],
    ['a dead name the page never mentions', { affects: { operations: ['widget-7'] } }, /widget-7/],
  ])('rejects %s and leaves the list alone', async (_name, overrides, reason) => {
    const before = loadDeadApis(dataDir).version;
    const [proposal] = await settle([change(overrides)]);
    expect(proposal.status).toBe('rejected');
    expect(proposal.reason).toMatch(reason);
    expect(loadDeadApis(dataDir).version).toBe(before);
    expect(await readProposals(storeDir)).toEqual([proposal]);
  });

  it('rejects a deprecation with no end, and passes one with an end', async () => {
    const noEnd = 'widget-1 is deprecated in favor of widget-2.';
    const withEnd = 'widget-1 is deprecated and reaches end of life on October 1, 2026.';
    const [held, passed] = await settle(
      [quoted(noEnd), quoted(withEnd, { id: 'acme:widget-1b' })],
      fakeFetcher({ [PAGE_URL]: `${PAGE}\n${noEnd}\n${withEnd}` }),
      true,
    );
    expect(held.status).toBe('rejected');
    expect(held.reason).toMatch(/deprecated with no end/);
    expect(passed.status).toBe('pending');
  });

  it('turns a trailing /* in a templated path into everything under it', async () => {
    const quote = 'Requests to POST /a/{id}/kv/* will no longer work after October 1, 2026.';
    const [proposal] = await settle(
      [quoted(quote, { affects: { operations: ['POST /a/{id}/kv/*'] } })],
      fakeFetcher({ [PAGE_URL]: `${PAGE}\n${quote}` }),
      true,
    );
    const pattern = new RegExp((proposal.entry?.matchers[0] as { value: string }).value);
    expect(pattern.test('/a/123/kv/items')).toBe(true);
    expect(pattern.test('/a/123/kv')).toBe(true);
    expect(pattern.test('/a/123/kvstore')).toBe(false);
  });

  it("doesn't fetch a page on a host that isn't official", async () => {
    const fake = fakeFetcher();
    await settle([change({ source: { url: 'https://evil.example/x', quote: QUOTE } })], fake);
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('accepts a replacement that is on the page, or one that says the read named none', async () => {
    const [named, none] = await settle([
      change({ title: 'widget-1 retired; use widget-2 or gadget-3-mini' }),
      quoted('legacy_id is gone.', {
        id: 'acme:legacy',
        title: 'legacy_id removed',
        kind: 'field-removed',
        affects: { fields: ['thing.legacy_id'] },
      }),
    ]);
    expect(named.status).toBe('live');
    expect(named.entry?.replacementIds).toEqual(['widget-2', 'gadget-3-mini']);
    expect(none.status).toBe('live');
    expect(none.entry?.replacement).toMatch(/named no replacement/);
    expect(none.entry?.matchers).toEqual([
      { kind: 'field', value: 'legacy_id', on: ['thing'], ambiguous: true },
    ]);
  });

  it('turns an endpoint call into a url matcher that the list accepts', async () => {
    const [proposal] = await settle([
      quoted('POST /v2/widgets is the new path.', {
        kind: 'endpoint-removed',
        affects: { operations: ['POST /v2/widgets'] },
      }),
    ]);
    expect(proposal.entry?.matchers).toEqual([
      { kind: 'url', value: '/v2/widgets', ambiguous: true },
    ]);
    expect(proposal.status).toBe('live');
  });

  it('keeps a new provider pending until something other than its own source vouches for the host', async () => {
    const blog = 'https://some-blog.example.com/resend-died';
    const settleIt = (url: string, hints = {}) =>
      settleChanges({
        provider: 'startly',
        changes: [change({ provider: 'startly', source: { url, quote: QUOTE } })],
        today: TODAY,
        fetcher: fakeFetcher({ [url]: PAGE }).fetcher,
        storeDir,
        dataDir,
        hints,
      });
    const [waiting] = await settleIt(blog);
    expect(waiting.status).toBe('pending');
    expect(waiting.reason).toMatch(/nothing vouches for some-blog\.example\.com/);
    expect(readdirSync(dataDir)).toEqual(['acme.json']);
    const docs = 'https://docs.startly.dev/changelog';
    const [vouched] = await settleIt(docs, { hosts: ['api.startly.dev'] });
    expect(vouched.status).toBe('live');
    expect(dataFile('startly').officialHosts).toEqual(['startly.dev']);
  });

  it('gives a provider with no data file a new one, with hosts from its source', async () => {
    const url = 'https://resend.com/changelog';
    const [proposal] = await settleChanges({
      provider: 'Resend',
      changes: [change({ provider: 'resend', source: { url, quote: QUOTE } })],
      today: TODAY,
      fetcher: fakeFetcher({ [url]: PAGE }).fetcher,
      storeDir,
      dataDir,
    });
    expect(proposal.status).toBe('live');
    expect(dataFile('resend').officialHosts).toEqual(['resend.com']);
    expect(loadDeadApis(dataDir).entries.map((one) => one.id)).toContain('RE-100.widget-1');
  });

  it('keeps a dry run pending, then lets a real run take it live, once', async () => {
    const [dry] = await settle([change()], fakeFetcher(), true);
    expect(dry.status).toBe('pending');
    expect(dataFile('acme').entries).toHaveLength(1);
    await settle([change()]);
    const stored = await readProposals(storeDir);
    expect(stored.map((one) => one.status)).toEqual(['live']);
    expect(dataFile('acme').entries).toHaveLength(2);
    expect(await settle([change()])).toEqual([]);
  });

  it('gives a later change that reuses an id a number, so what it names still lands', async () => {
    await settle([change()]);
    const [again] = await settle([
      quoted('Models: widget-2, gadget-3-mini.', {
        affects: { operations: ['widget-1', 'gadget-3-mini'] },
      }),
    ]);
    expect(again.status).toBe('live');
    expect(again.id).toBe('AC-100.widget-1-2');
    expect(again.entry?.matchers.map((one) => one.value)).toEqual(['gadget-3-mini']);
    expect((await readProposals(storeDir)).map((one) => one.id)).toEqual([
      'AC-100.widget-1',
      'AC-100.widget-1-2',
    ]);
  });

  it('gives a provider with the same two letters as another its own id', async () => {
    const url = 'https://resend.com/changelog';
    writeFileSync(
      path.join(dataDir, 'redis.json'),
      JSON.stringify({
        ...seed,
        provider: 'redis',
        entries: [{ ...seed.entries[0], id: 'RE-100.widget-1', provider: 'redis' }],
      }),
    );
    const [proposal] = await settleChanges({
      provider: 'resend',
      changes: [change({ provider: 'resend', source: { url, quote: QUOTE } })],
      today: TODAY,
      fetcher: fakeFetcher({ [url]: PAGE }).fetcher,
      storeDir,
      dataDir,
    });
    expect(proposal.id).toBe('RE-100.widget-1-2');
    expect(proposal.status).toBe('live');
  });

  it("leaves a proposal pending when the page can't be read, never live", async () => {
    const [proposal] = await settle([change()], fakeFetcher({}));
    expect(proposal.status).toBe('pending');
    expect(proposal.reason).toMatch(/couldn't read/);
    expect(dataFile('acme').entries).toHaveLength(1);
  });

  it('takes the first of two changes in one read that name the same thing, once', async () => {
    const settled = await settle([change(), change({ id: 'acme:again' })]);
    expect(settled.map((one) => one.status)).toEqual(['live']);
    expect((await readProposals(storeDir)).map((one) => one.id)).toEqual(['AC-100.widget-1']);
  });

  it.each<[string, Partial<ProviderChange>, RegExp]>([
    [
      'a live name beside the dead one in the quote',
      { affects: { operations: ['widget-2'] } },
      /widget-2 isn't in the quote/,
    ],
    [
      'a one-letter quote',
      { source: { url: PAGE_URL, quote: 'a' } },
      /widget-1 isn't in the quote/,
    ],
    [
      'a date the quote contradicts',
      { effectiveDate: '2025-10-01' },
      /quote says 2026-10-01, not 2025-10-01/,
    ],
    [
      'a name only part of a longer one',
      {
        source: { url: PAGE_URL, quote: 'Models: widget-2, gadget-3-mini.' },
        affects: { operations: ['gadget-3'] },
      },
      /gadget-3 isn't in the quote/,
    ],
  ])('ties the claim to the quote: rejects %s', async (_name, overrides, reason) => {
    const [proposal] = await settle([change(overrides)]);
    expect(proposal.status).toBe('rejected');
    expect(proposal.reason).toMatch(reason);
  });

  it('accepts a quote with no date when the page gives it, and refuses when it does not', async () => {
    const quote = 'The widget-1 model shuts down on';
    const [onPage] = await settle([quoted(quote)]);
    expect(onPage.status).toBe('live');
    const [absent] = await settle([
      quoted('Models: widget-2, gadget-3-mini.', {
        id: 'acme:mini',
        effectiveDate: '2026-03-03',
        affects: { operations: ['gadget-3-mini'] },
      }),
    ]);
    expect(absent.status).toBe('rejected');
    expect(absent.reason).toMatch(/2026-03-03 isn't on/);
  });

  it('matches a name on the page whatever its case, as the quote check does', async () => {
    const gone = quoted('gpt-4 is gone as of October 1, 2026', {
      affects: { operations: ['gpt-4'] },
    });
    const page = { [PAGE_URL]: 'GPT-4 is gone as of October 1, 2026' };
    const [proposal] = await settle([gone], fakeFetcher(page));
    expect(proposal.status).toBe('live');
  });

  it.each(['SuperWidget', 'createWidgetThing', 'gizmo'])(
    "rejects a replacement the page doesn't hold, even a plain word: %s",
    async (name) => {
      const [proposal] = await settle([change({ title: `widget-1 retired; use ${name}` })]);
      expect(proposal.status).toBe('rejected');
      expect(proposal.reason).toContain(`replacement ${name} isn't on`);
    },
  );

  it.each(['widget-1 retired, please use widget-2', 'widget-1 superseded by widget-2'])(
    'reads the replacement in %s',
    async (title) => {
      const [proposal] = await settle([change({ title })]);
      expect(proposal.entry?.replacementIds).toEqual(['widget-2']);
    },
  );

  it("doesn't read 'Use of widget-1' as a replacement", async () => {
    const [proposal] = await settle([change({ title: 'Use of widget-1 is retired' })]);
    expect(proposal.status).toBe('live');
    expect(proposal.entry?.replacementIds).toBeUndefined();
  });

  it('never claims nothing else is required, and lets the replacement be checked later', async () => {
    const [proposal] = await settle([change({ title: 'widget-1 retired; use widget-2' })]);
    expect(proposal.entry?.requires).toEqual([expect.stringContaining('Not checked yet')]);
  });

  it('records the dated API version that removed a field, for the compare', async () => {
    const [proposal] = await settle([
      quoted('legacy_id is gone.', {
        kind: 'field-removed',
        affects: { fields: ['thing.legacy_id'], versions: ['2025-03-31.basil'], sdk: 'acme' },
      }),
    ]);
    expect(proposal.entry?.appliesTo).toEqual({
      describe: '2025-03-31.basil',
      apiVersionSince: '2025-03-31.basil',
    });
    expect(proposal.entry?.context?.packages).toEqual(['acme']);
  });

  it('fetches a GitHub releases source in the format the watcher read it in', async () => {
    const api = 'https://api.github.com/repos/a/b/releases?per_page=100';
    writeFileSync(
      path.join(dataDir, 'acme.json'),
      JSON.stringify({ ...seed, officialHosts: ['docs.acme.dev', 'github.com'] }),
    );
    const fake = fakeFetcher({ [api]: PAGE });
    await settle([change({ source: { url: api, quote: QUOTE } })], fake);
    expect(fake.fetch).toHaveBeenCalledWith(api, 'github-releases');
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'GET /v1/charges/{id}',
      { kind: 'regex', value: '/v1/charges/[^/\\s]+(?![\\w/-])', ambiguous: true },
    ],
    [
      'DELETE /v1/customers/:id',
      { kind: 'regex', value: '/v1/customers/[^/\\s]+(?![\\w/-])', ambiguous: true },
    ],
    ['POST /v1/x?y=1', { kind: 'url', value: '/v1/x', ambiguous: true }],
    ['get /v1/x', { kind: 'url', value: '/v1/x', ambiguous: true }],
  ])('makes a matcher from the endpoint %s', async (operation, matcher) => {
    const [proposal] = await settle(
      [
        quoted(`${operation} is gone`, {
          kind: 'endpoint-removed',
          affects: { operations: [operation] },
        }),
      ],
      fakeFetcher({ [PAGE_URL]: `${PAGE} ${operation} is gone` }),
    );
    expect(proposal.status).toBe('live');
    expect(proposal.entry?.matchers).toEqual([matcher]);
  });

  it('leaves the list and the store agreeing when a later proposal throws', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(await fakeFetcher().fetcher.fetch(PAGE_URL))
      .mockRejectedValueOnce(new Error('disk full'));
    const fetcher = { fetch } as Fetcher;
    const other = 'https://docs.acme.dev/other';
    await expect(
      settleChanges({
        provider: 'acme',
        changes: [
          change(),
          change({
            id: 'acme:two',
            source: { url: other, quote: 'Models: widget-2, gadget-3-mini.' },
            affects: { operations: ['gadget-3-mini'] },
          }),
        ],
        today: TODAY,
        fetcher,
        storeDir,
        dataDir,
      }),
    ).rejects.toThrow('disk full');
    expect(dataFile('acme').entries).toHaveLength(2);
    expect((await readProposals(storeDir)).map((one) => one.status)).toEqual(['live']);
  });

  it('checks a pending proposal again with no new read naming it', async () => {
    await settle([change()], fakeFetcher({}));
    const [settled] = await settle([]);
    expect(settled.status).toBe('live');
    expect((await readProposals(storeDir)).map((one) => one.status)).toEqual(['live']);
  });

  it('turns a dry run pending into a real one on the next settle', async () => {
    await settle([change()], fakeFetcher(), true);
    expect((await settle([])).map((one) => one.status)).toEqual(['live']);
  });

  it('forgets a pending proposal once the list holds what it named', async () => {
    await settle([change()], fakeFetcher({}));
    const file = dataFile('acme');
    file.entries[0].matchers.push({ kind: 'string', value: 'widget-1' });
    writeFileSync(path.join(dataDir, 'acme.json'), JSON.stringify(file));
    expect(await settle([])).toEqual([]);
    expect(await readProposals(storeDir)).toEqual([]);
  });
});

describe('what a read proposes', () => {
  it('never makes a dead entry from a future date', async () => {
    const { change: later, fake } = dated('2027-03-01', 'widget-1 shuts down on March 1, 2027.');
    const [proposal] = await settle([later], fake);
    expect(proposal.status).toBe('live');
    expect(proposal.entry).toBeUndefined();
    expect(proposal.future?.diesOn).toBe('2027-03-01');
    const list = loadDeadApis(dataDir);
    expect(list.entries.map((one) => one.id)).toEqual(['AC-1.old-model']);
    expect(entriesInForce(list, TODAY).map((one) => one.id)).toEqual(['AC-1.old-model']);
    const arrived = entriesInForce(list, '2027-03-01').find((one) => one.id === 'AC-100.widget-1');
    expect(arrived?.source.quote).toBe('widget-1 shuts down on March 1, 2027.');
  });

  it("treats this month's month-only date as not yet dead, and never turns it on alone", async () => {
    const { change: soon, fake } = dated('2026-11', 'widget-1 shuts down in November 2026.');
    const [proposal] = await settle([soon], fake);
    expect(proposal.future).toMatchObject({ diesOn: '2026-11-30', earliest: true });
    expect(entriesInForce(loadDeadApis(dataDir), '2027-06-01')).toHaveLength(1);
  });

  it('counts a finished month as dead, on its last day', async () => {
    const { change: gone, fake } = dated('2026-02', 'widget-1 shut down in February 2026.');
    const [proposal] = await settle([gone], fake);
    expect(proposal.entry?.diedOn).toBe('2026-02-28');
  });

  it.each(['other', 'api-version', 'sdk-major', 'auth-change', 'pagination-or-limits'] as const)(
    "notes a %s change where it can be seen, and doesn't list it",
    async (kind) => {
      const [noted] = await settle([change({ kind })]);
      expect(noted.status).toBe('noted');
      expect(noted.reason).toContain(kind);
      expect(dataFile('acme').entries).toHaveLength(1);
      expect(await readProposals(storeDir)).toEqual([noted]);
    },
  );

  it.each<[ProviderChange['kind'], ProviderChange['affects'], string]>([
    ['webhook-payload', { fields: ['event.zeta_field'] }, 'event.zeta_field stopped arriving.'],
    ['rest-to-graphql', { operations: ['/admin/products.json'] }, '/admin/products.json is gone.'],
  ])('lists a %s removal', async (kind, affects, quote) => {
    const [proposal] = await settle(
      [quoted(quote, { kind, affects })],
      fakeFetcher({ [PAGE_URL]: `${PAGE} ${quote}` }),
    );
    expect(proposal.status).toBe('live');
  });

  it.each(['2026-02-31', '2026-13'])('refuses the impossible date %s', async (effectiveDate) => {
    const [proposal] = await settle([change({ effectiveDate })]);
    expect(proposal.status).toBe('rejected');
    expect(proposal.reason).toMatch(/is not a date/);
  });

  it('skips a change the list already holds, including under a wildcard', async () => {
    expect(await settle([change({ affects: { operations: ['old-model'] } })])).toEqual([]);
    expect(await settle([change({ affects: { operations: ['older-2'] } })])).toEqual([]);
  });

  it('tells owners of one field apart, and keeps every owner one change names', async () => {
    const file = dataFile('acme');
    file.entries[0].matchers.push({ kind: 'field', value: 'period', on: ['subscription'] });
    writeFileSync(path.join(dataDir, 'acme.json'), JSON.stringify(file));
    const [other] = await settle([
      quoted('quote_line.period is gone.', {
        kind: 'field-removed',
        affects: { fields: ['quote_line.period'] },
      }),
    ]);
    expect(other.entry?.matchers).toEqual([
      { kind: 'field', value: 'period', on: ['quote_line'], ambiguous: true },
    ]);
    const [both] = await settle(
      [
        quoted('alpha.zeta and beta.zeta are gone.', {
          id: 'acme:zeta',
          kind: 'field-removed',
          affects: { fields: ['alpha.zeta', 'beta.zeta'] },
        }),
      ],
      fakeFetcher({ [PAGE_URL]: `${PAGE} alpha.zeta and beta.zeta are gone.` }),
    );
    expect(both.entry?.matchers).toEqual([
      { kind: 'field', value: 'zeta', on: ['alpha', 'beta'], ambiguous: true },
    ]);
  });

  it('holds an endpoint a listed wildcard covers, but not one a plain path only prefixes', async () => {
    const file = dataFile('acme');
    file.entries[0].matchers.push(
      { kind: 'url', value: '/v1/assistants*' },
      { kind: 'url', value: '/v1/plain' },
    );
    writeFileSync(path.join(dataDir, 'acme.json'), JSON.stringify(file));
    const endpoint = (operation: string) =>
      quoted(`${operation} is gone`, {
        id: `acme:${operation}`,
        kind: 'endpoint-removed',
        affects: { operations: [operation] },
      });
    expect(await settle([endpoint('POST /v1/assistants')])).toEqual([]);
    expect(await settle([endpoint('GET /v1/assistants/{id}')])).toEqual([]);
    const [template] = await settle(
      [endpoint('GET /v1/plain/{id}')],
      fakeFetcher({ [PAGE_URL]: `${PAGE} GET /v1/plain/{id} is gone` }),
    );
    expect(template.status).toBe('live');
  });

  it('proposes only the matchers the list lacks', async () => {
    const [proposal] = await settle([
      change({ affects: { operations: ['old-model', 'widget-1'] } }),
    ]);
    expect(proposal.entry?.matchers).toEqual([
      { kind: 'string', value: 'widget-1', ambiguous: true },
    ]);
    expect(proposal.status).toBe('live');
  });

  it('treats an SDK name as a package only when the product is shutting down', async () => {
    const page = { [PAGE_URL]: `${PAGE} acme-sdk` };
    const [removal] = await settle(
      [change({ affects: { operations: ['widget-1'], sdk: 'acme-sdk' } })],
      fakeFetcher(page),
      true,
    );
    expect(removal.entry?.matchers.map((one) => one.kind)).toEqual(['string']);
    expect(removal.entry?.context?.packages).toEqual(['acme-sdk']);
    const [shutdown] = await settle(
      [change({ kind: 'product-shutdown', affects: { sdk: 'acme-sdk' } })],
      fakeFetcher(page),
      true,
    );
    expect(shutdown.entry?.matchers).toEqual([{ kind: 'package', value: 'acme-sdk' }]);
  });
});

describe('a chain of replacements', () => {
  it('lets a replacement die, moving older entries on to what replaced it', async () => {
    const quote = 'widget-2 is gone as of October 1, 2026.';
    const { change: dead, fake } = dated('2026-10-01', quote, {
      title: 'widget-2 retired; use gadget-3-mini',
      affects: { operations: ['widget-2'] },
    });
    const [proposal] = await settle([dead], fake);
    expect(proposal.status).toBe('live');
    expect(proposal.reason).toContain('moved AC-1.old-model on');
    const list = loadDeadApis(dataDir);
    const older = list.entries.find((one) => one.id === 'AC-1.old-model');
    expect(older?.replacementIds).toEqual(['gadget-3-mini']);
    expect(older?.replacement).toContain('gadget-3-mini');
  });

  it('lets a replacement announce a shutdown, and says so when nothing replaces it', async () => {
    const quote = 'widget-2 shuts down on March 1, 2027.';
    const { change: dying, fake } = dated('2027-03-01', quote, {
      affects: { operations: ['widget-2'] },
    });
    const [proposal] = await settle([dying], fake);
    expect(proposal.future?.diesOn).toBe('2027-03-01');
    const older = loadDeadApis(dataDir).entries.find((one) => one.id === 'AC-1.old-model');
    expect(older?.replacementIds).toEqual([]);
    expect(older?.replacement).toMatch(/widget-2 has its own entry now/);
  });

  it("still rejects a new entry's own dead replacement, under a wildcard too", async () => {
    const [proposal] = await settle([change({ title: 'widget-1 retired; use older-2' })]);
    expect(proposal.status).toBe('rejected');
    expect(proposal.reason).toMatch(/replacement older-2 is dead/);
  });
});

describe('a later read of a shutdown the list holds', () => {
  const page = (...quotes: string[]) => fakeFetcher({ [PAGE_URL]: [PAGE, ...quotes].join('\n') });
  const FIRST = 'widget-1 shuts down on March 1, 2027.';

  beforeEach(async () => {
    await settle([quoted(FIRST, { effectiveDate: '2027-03-01' })], page(FIRST));
  });

  const shutdown = () => loadDeadApis(dataDir).future.find((one) => one.id === 'AC-100.widget-1');

  it('adds nothing when it says the same date', async () => {
    expect(await settle([quoted(FIRST, { effectiveDate: '2027-03-01' })], page(FIRST))).toEqual([]);
  });

  it('adds nothing when it gives no date', async () => {
    expect(await settle([quoted(FIRST, { effectiveDate: undefined })], page(FIRST))).toEqual([]);
  });

  it('moves a postponed date, keeping the id', async () => {
    const later = 'widget-1 now shuts down on June 1, 2027.';
    const [moved] = await settle([quoted(later, { effectiveDate: '2027-06-01' })], page(later));
    expect(moved.status).toBe('live');
    expect(moved.id).toBe('AC-100.widget-1');
    expect(shutdown()?.diesOn).toBe('2027-06-01');
    expect(loadDeadApis(dataDir).future).toHaveLength(1);
    expect(entriesInForce(loadDeadApis(dataDir), '2027-03-02')).toHaveLength(1);
    expect(await readProposals(storeDir)).toEqual([moved]);
  });

  it('moves an earlier date too', async () => {
    const sooner = 'widget-1 now shuts down on December 1, 2026.';
    await settle([quoted(sooner, { effectiveDate: '2026-12-01' })], page(sooner));
    expect(shutdown()?.diesOn).toBe('2026-12-01');
  });

  it('turns dead when a read says the day has come, keeping the id', async () => {
    const dead = 'widget-1 shut down on October 1, 2026.';
    const [moved] = await settle([quoted(dead, { effectiveDate: '2026-10-01' })], page(dead));
    expect(moved.entry?.diedOn).toBe('2026-10-01');
    expect(moved.id).toBe('AC-100.widget-1');
    expect(shutdown()).toBeUndefined();
    expect(loadDeadApis(dataDir).entries.map((one) => one.id)).toContain('AC-100.widget-1');
  });

  it('turns a month-only date on once a later read gives its day', async () => {
    const other = 'gadget-3-mini shuts down in November 2026.';
    await settle(
      [
        quoted(other, {
          id: 'acme:mini',
          effectiveDate: '2026-11',
          affects: { operations: ['gadget-3-mini'] },
        }),
      ],
      page(other),
    );
    const list = () => loadDeadApis(dataDir);
    expect(entriesInForce(list(), '2027-06-01').map((one) => one.id)).not.toContain('AC-100.mini');
    const exact = 'gadget-3-mini shut down on November 15, 2026.';
    const later = settleChanges({
      provider: 'acme',
      changes: [
        quoted(exact, {
          id: 'acme:mini',
          effectiveDate: '2026-11-15',
          affects: { operations: ['gadget-3-mini'] },
        }),
      ],
      today: '2026-12-01',
      fetcher: page(exact).fetcher,
      storeDir,
      dataDir,
    });
    expect((await later)[0].entry?.diedOn).toBe('2026-11-15');
    expect(entriesInForce(list(), '2027-06-01').map((one) => one.id)).toContain('AC-100.mini');
  });

  it('never turns a date on while the provider still calls it the earliest', async () => {
    const quote = 'gadget-3-mini retires no earlier than December 1, 2026.';
    const made = quoted(quote, {
      id: 'acme:mini',
      effectiveDate: '2026-12-01',
      affects: { operations: ['gadget-3-mini'] },
    });
    const [first] = await settle([made], page(quote));
    expect(first.future).toMatchObject({ diesOn: '2026-12-01', earliest: true });
    const after = await settleChanges({
      provider: 'acme',
      changes: [made],
      today: '2027-01-15',
      fetcher: page(quote).fetcher,
      storeDir,
      dataDir,
    });
    expect(after).toEqual([]);
  });
});

describe('refusing an entry', () => {
  it('takes it off the list, and the same change never puts it back', async () => {
    await settle([change()]);
    const refused = await refuseEntry({
      id: 'AC-100.widget-1',
      reason: 'a hand-check disagrees',
      storeDir,
      dataDir,
    });
    expect(refused.status).toBe('refused');
    expect(loadDeadApis(dataDir).entries.map((one) => one.id)).toEqual(['AC-1.old-model']);
    expect(await settle([change()])).toEqual([]);
    expect((await readProposals(storeDir)).map((one) => one.status)).toEqual(['refused']);
    expect(loadDeadApis(dataDir).entries.map((one) => one.id)).toEqual(['AC-1.old-model']);
  });

  it('takes a hand-written entry off too, and refuses an id nothing has', async () => {
    await refuseEntry({ id: 'AC-1.old-model', reason: 'wrong', storeDir, dataDir });
    expect(loadDeadApis(dataDir).entries).toEqual([]);
    await expect(
      refuseEntry({ id: 'AC-9.nope', reason: 'wrong', storeDir, dataDir }),
    ).rejects.toThrow(UnknownEntryError);
  });
});

describe('the unlisted queue', () => {
  it("takes a scan's unlisted providers, even from a scan with nothing else to fix", async () => {
    const scan: ScanResult = {
      findings: [],
      unlistedProviders: ['Resend', 'postmark'],
      clean: true,
    };
    await enqueueUnlisted(storeDir, 'o/a', scan.unlistedProviders);
    const next = await nextInQueue(storeDir, 5, { dataDir, today: TODAY });
    expect(next.map((one) => one.provider)).toEqual(['postmark', 'resend']);
  });

  it('orders by distinct repos, and a repo enqueued twice counts once', async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['resend']);
    await enqueueUnlisted(storeDir, 'o/a', ['resend']);
    await enqueueUnlisted(storeDir, 'o/a', ['resend']);
    await enqueueUnlisted(storeDir, 'o/b', ['postmark']);
    await enqueueUnlisted(storeDir, 'o/c', ['postmark']);
    const next = await nextInQueue(storeDir, 5, { dataDir, today: TODAY });
    expect(next.map((one) => [one.provider, one.repos.length])).toEqual([
      ['postmark', 2],
      ['resend', 1],
    ]);
    expect((await nextInQueue(storeDir, 1, { dataDir, today: TODAY })).length).toBe(1);
  });

  it('reads a provider once, leaving out what the list holds, whatever the read found', async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['acme', 'resend', 'postmark']);
    await markRead(storeDir, 'resend', 'read', TODAY);
    const today = await nextInQueue(storeDir, 5, { dataDir, today: TODAY });
    expect(today.map((one) => one.provider)).toEqual(['postmark']);
    const tomorrow = await nextInQueue(storeDir, 5, { dataDir, today: '2026-11-06' });
    expect(tomorrow.map((one) => one.provider)).toEqual(['postmark']);
    expect((await readQueue(storeDir)).find((one) => one.provider === 'resend')?.lastRead).toEqual({
      day: TODAY,
      outcome: 'read',
    });
  });

  it('brings a failed read back tomorrow, and a read that ended early straight away', async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['resend', 'postmark']);
    await markRead(storeDir, 'resend', 'failed', TODAY);
    await markRead(storeDir, 'postmark', 'unfinished', TODAY);
    const today = await nextInQueue(storeDir, 5, { dataDir, today: TODAY });
    expect(today.map((one) => one.provider)).toEqual(['postmark']);
    const tomorrow = await nextInQueue(storeDir, 5, { dataDir, today: '2026-11-06' });
    expect(tomorrow.map((one) => one.provider)).toEqual(['postmark', 'resend']);
  });

  it('loses no update when scans enqueue at the same time', async () => {
    await Promise.all(
      ['one', 'two', 'three', 'four'].map((name) => enqueueUnlisted(storeDir, `o/${name}`, [name])),
    );
    expect((await readQueue(storeDir)).map((one) => one.provider).sort()).toEqual([
      'four',
      'one',
      'three',
      'two',
    ]);
  });

  it('merges hints, and leaves no temp file behind', async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['resend'], { resend: { packages: ['resend'] } });
    await enqueueUnlisted(storeDir, 'o/b', ['resend'], { resend: { hosts: ['api.resend.com'] } });
    const [item] = await readQueue(storeDir);
    expect(item.hints).toEqual({ packages: ['resend'], hosts: ['api.resend.com'] });
    expect(readdirSync(path.join(storeDir, 'queue'))).toEqual(['unlisted.json']);
  });

  it("doesn't mix the queue up with a provider's proposals", async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['queue']);
    await settleChanges({
      provider: 'queue',
      changes: [change({ source: { url: 'https://queue.dev/x', quote: QUOTE } })],
      today: TODAY,
      fetcher: fakeFetcher({ 'https://queue.dev/x': PAGE }).fetcher,
      storeDir,
      dataDir,
      hints: { hosts: ['queue.dev'] },
    });
    expect((await readQueue(storeDir)).map((one) => one.provider)).toEqual(['queue']);
    expect((await readProposals(storeDir)).map((one) => one.provider)).toEqual(['queue']);
  });
});

describe('a refresh run', () => {
  const run = (read: ReadSource, options: Parameters<typeof refresh>[0] = {}) =>
    refresh({
      providers: ['acme'],
      storeDir,
      cacheDir,
      dataDir,
      read,
      fetcher: fakeFetcher().fetcher,
      now: NOW,
      ...options,
    });

  it('reads once a day: the second refresh serves the cache, and costs nothing more', async () => {
    const read = fakeRead([change()]);
    const first = await run(read);
    expect(first.providers[0]).toMatchObject({
      provider: 'acme',
      outcome: 'read',
      costUsd: 0.25,
      proposed: 1,
      live: ['AC-100.widget-1'],
    });
    const second = await run(read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(second.providers[0]).toMatchObject({ outcome: 'cached', costUsd: 0.25, proposed: 0 });
    expect(second.spentUsd).toBe(0);
    const costs = await watchCostReport(cacheDir, TODAY);
    expect(costs.rows[0]).toMatchObject({ reads: 1, served: 1, costUsd: 0.25 });
  });

  it('reads once even when a change goes live from a page the list had never cited', async () => {
    const other = 'https://docs.acme.dev/deprecations';
    const read = fakeRead([change({ source: { url: other, quote: QUOTE } })]);
    const fetcher = fakeFetcher({ [other]: PAGE }).fetcher;
    const first = await run(read, { fetcher });
    expect(first.providers[0].live).toEqual(['AC-100.widget-1']);
    const second = await run(read, { fetcher });
    expect(read).toHaveBeenCalledTimes(1);
    expect(second.providers[0].outcome).toBe('cached');
    expect(second.spentUsd).toBe(0);
  });

  it('reads an unlisted provider once on the day its first entry goes live', async () => {
    const url = 'https://resend.com/changelog';
    const read = fakeRead([change({ provider: 'resend', source: { url, quote: QUOTE } })]);
    const fetcher = fakeFetcher({ [url]: PAGE }).fetcher;
    const first = await run(read, { providers: ['resend'], fetcher });
    expect(first.providers[0].live).toEqual(['RE-100.widget-1']);
    await run(read, { providers: ['resend'], fetcher });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('leads with the sources of announced shutdowns too', async () => {
    const other = 'https://docs.acme.dev/shutdowns';
    writeFileSync(
      path.join(dataDir, 'acme.json'),
      JSON.stringify({
        ...seed,
        future: [
          {
            id: 'AC-2.soon',
            provider: 'acme',
            what: 'soon',
            diesOn: '2027-01-01',
            source: { url: other, checkedOn: SEEDED_ON },
            matchers: [{ kind: 'string', value: 'soon-model' }],
          },
        ],
      }),
    );
    const read = fakeRead();
    await run(read);
    expect(read.mock.calls[0][1]).toEqual({ docsUrls: [PAGE_URL, other] });
  });

  it('reports a provider whose settle throws, and carries on to the next', async () => {
    const fetcher = {
      fetch: vi.fn().mockRejectedValue(new Error('no route to host')),
    } as unknown as Fetcher;
    const read = vi.fn<ReadSource>(async (provider) => ({
      changes: provider === 'acme' ? [change()] : [],
      finished: true,
      costUsd: 0.1,
    }));
    const report = await run(read, { providers: ['acme', 'other'], fetcher });
    expect(report.providers.map((row) => row.outcome)).toEqual(['failed', 'read']);
    expect(report.providers[0].note).toBe('no route to host');
    expect(report.spentUsd).toBeCloseTo(0.2);
    expect(refreshFinished(report)).toBe(false);
  });

  it('keeps reading a queued provider until a read finishes, once', async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['popular']);
    await enqueueUnlisted(storeDir, 'o/b', ['popular']);
    await enqueueUnlisted(storeDir, 'o/c', ['rare']);
    const read = fakeRead();
    const days = ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    for (const day of days) {
      await run(read, { providers: [], queue: 1, now: () => new Date(`${day}T12:00:00Z`) });
    }
    expect(read.mock.calls.map((call) => call[0])).toEqual(['popular', 'rare']);
  });

  it('counts only a finished read as done', async () => {
    const finished = await run(fakeRead());
    expect(refreshFinished(finished)).toBe(true);
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '0.5');
    expect(refreshFinished(await run(fakeRead(), { providers: ['capped'] }))).toBe(false);
  });

  it("shows a change that isn't a removal in the report", async () => {
    const report = await run(fakeRead([change({ kind: 'auth-change' })]));
    expect(report.providers[0]).toMatchObject({ proposed: 0, noted: [{ id: 'AC-100.widget-1' }] });
  });

  it('reads again on the next day', async () => {
    const read = fakeRead();
    await run(read);
    await run(read, { now: () => new Date('2026-11-06T01:00:00Z') });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses with no cap, before reading anything', async () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '');
    const read = fakeRead();
    await expect(run(read)).rejects.toThrow(/APTITUDE_AI_BUDGET_USD/);
    expect(read).not.toHaveBeenCalled();
    expect(readdirSync(root)).not.toContain('cache');
  });

  it('stops starting reads at the cap, and still serves what is cached', async () => {
    const read = fakeRead();
    await run(read, { providers: ['cached-one'] });
    read.mockClear();
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', String(READ_USD));
    const expensive = vi.fn<ReadSource>(async () => ({
      changes: [],
      finished: true,
      costUsd: READ_USD,
    }));
    const report = await run(expensive, { providers: ['one', 'two', 'cached-one', 'three'] });
    expect(expensive).toHaveBeenCalledTimes(1);
    expect(report.providers.map((row) => row.outcome)).toEqual([
      'read',
      'capped',
      'cached',
      'capped',
    ]);
    expect(report.providers[1].note).toMatch(/cap/);
    expect(report.spentUsd).toBe(READ_USD);
  });

  it('takes the head of the queue, led by its hints, and marks it read', async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['resend'], { resend: { packages: ['resend'] } });
    await enqueueUnlisted(storeDir, 'o/b', ['resend']);
    await enqueueUnlisted(storeDir, 'o/c', ['postmark']);
    const read = fakeRead();
    const report = await run(read, { providers: [], queue: 1 });
    expect(report.providers.map((row) => row.provider)).toEqual(['resend']);
    expect(read.mock.calls[0].slice(0, 2)).toEqual(['resend', { packages: ['resend'] }]);
    const next = await nextInQueue(storeDir, 5, { dataDir, today: TODAY });
    expect(next.map((one) => one.provider)).toEqual(['postmark']);
  });

  it('keeps a provider stopped at the cap in the queue', async () => {
    vi.stubEnv('APTITUDE_AI_BUDGET_USD', '0.5');
    await enqueueUnlisted(storeDir, 'o/a', ['resend']);
    const read = fakeRead();
    const report = await run(read, { providers: [], queue: 1 });
    expect(report.providers[0].outcome).toBe('capped');
    expect(read).not.toHaveBeenCalled();
    const next = await nextInQueue(storeDir, 5, { dataDir, today: TODAY });
    expect(next.map((one) => one.provider)).toEqual(['resend']);
  });

  it("leads a listed provider's read with the docs the list already knows", async () => {
    const read = fakeRead();
    await run(read);
    expect(read.mock.calls[0][1]).toEqual({ docsUrls: [PAGE_URL] });
  });

  it('reports a failed read and carries on, without counting it as nothing to do', async () => {
    const read = vi.fn<ReadSource>(async (provider) =>
      provider === 'bad'
        ? { changes: [], finished: false, costUsd: 0.1, error: new Error('no pages') }
        : { changes: [], finished: true, costUsd: 0.2 },
    );
    const report = await run(read, { providers: ['bad', 'good'] });
    expect(report.providers[0]).toMatchObject({
      outcome: 'failed',
      note: 'no pages',
      costUsd: 0.1,
    });
    expect(report.providers[1]).toMatchObject({ outcome: 'read', costUsd: 0.2 });
    expect(report.spentUsd).toBeCloseTo(0.3);
  });

  it("checks an unfinished read's changes, but reads again next time", async () => {
    const read = vi.fn<ReadSource>(async () => ({
      changes: [change()],
      finished: false,
      reason: 'run ended early',
      costUsd: 0.1,
    }));
    const first = await run(read);
    expect(first.providers[0]).toMatchObject({
      outcome: 'unfinished',
      note: 'run ended early',
      live: ['AC-100.widget-1'],
    });
    expect(refreshFinished(first)).toBe(false);
    await run(read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('leaves a queued read that ended early at the head of the queue, the same day', async () => {
    await enqueueUnlisted(storeDir, 'o/a', ['resend']);
    const read = vi.fn<ReadSource>(async () => ({
      changes: [],
      finished: false,
      reason: 'run ended early: out of budget',
      costUsd: 0.1,
    }));
    const report = await run(read, { providers: [], queue: 1 });
    expect(report.providers[0].outcome).toBe('unfinished');
    const next = await nextInQueue(storeDir, 5, { dataDir, today: TODAY });
    expect(next.map((one) => one.provider)).toEqual(['resend']);
  });

  it('never goes live on a dry run, whatever the read found', async () => {
    const before = loadDeadApis(dataDir).version;
    const report = await run(fakeRead([change()]), { dryRun: true });
    expect(report.providers[0].live).toEqual([]);
    expect(report.providers[0].pending[0].id).toBe('AC-100.widget-1');
    expect(loadDeadApis(dataDir).version).toBe(before);
  });

  it('feeds a rejected change through with its reason', async () => {
    const report = await run(fakeRead([change({ source: { url: PAGE_URL, quote: 'not there' } })]));
    expect(report.providers[0].rejected[0]).toEqual({
      id: 'AC-100.widget-1',
      reason: `the quote isn't on ${PAGE_URL}`,
    });
  });
});
