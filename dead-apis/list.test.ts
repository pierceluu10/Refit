import { describe, expect, it } from 'vitest';
import type { DeadApiEntry, FutureShutdown } from '../shared/types.ts';
import {
  buildList,
  DeadApiListError,
  entriesInForce,
  listProblems,
  loadDeadApis,
  readProviderFiles,
  type ProviderFile,
} from './list.ts';

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
        'gemini',
        'google-analytics',
        'groq',
        'openai',
        'stripe',
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
