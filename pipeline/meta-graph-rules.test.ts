import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEFAULT_META_GRAPH_CHANGES, type MetaGraphChange } from './meta-graph-changes.ts';
import {
  checkMetaGraphEvidence,
  pageLabel,
  quoteProblems,
  readMetaGraphEvidence,
} from './meta-graph-rules.ts';

const PAGE =
  'Version 22.0\n\nThe `instagram_actor_id` field is deprecated.\nUse `instagram_user_id` instead.';
const SOURCE = 'https://developers.facebook.com/docs/graph-api/changelog/version22.0';

function change(overrides: Partial<MetaGraphChange> = {}): MetaGraphChange {
  return {
    id: 'meta-graph-v22-0-field-removed-instagram-actor-id',
    version: 'v22.0',
    kind: 'field-removed',
    node: 'Ad Creative',
    edge: null,
    path: null,
    name: 'instagram_actor_id',
    replacement: 'instagram_user_id',
    appliesToAll: null,
    summary: 'instagram_actor_id is replaced by instagram_user_id.',
    quote: 'The `instagram_actor_id` field is deprecated. Use `instagram_user_id` instead.',
    source: SOURCE,
    checkedAt: '2026-10-29',
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}) {
  const entry = change();
  return {
    rule: `${entry.id}-replacement`,
    family: 'field-replacement',
    change: entry.id,
    from: 'instagram_actor_id',
    to: 'instagram_user_id',
    source: SOURCE,
    quote: entry.quote,
    checkedAt: '2026-10-29',
    status: 'review',
    origin: 'mined',
    ...overrides,
  };
}

const table = (rules: unknown[]) => [
  {
    file: 'v22.0.json',
    table: { formatVersion: 1, provider: 'meta-graph', version: 'v22.0', rules },
  },
];
const pages = new Map([['graph-api-v22.0', PAGE]]);

describe('Meta Graph evidence', () => {
  it('maps a source to its saved page under either documentation prefix', () => {
    expect(pageLabel(SOURCE)).toBe('graph-api-v22.0');
    expect(pageLabel('https://developers.facebook.com/docs/instagram-platform/changelog')).toBe(
      'instagram-platform',
    );
    expect(
      pageLabel(
        'https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog#x',
      ),
    ).toBe('whatsapp');
  });

  it('requires the quote in the page, naming the change and its replacement', () => {
    expect(quoteProblems(change(), PAGE)).toEqual([]);
    expect(quoteProblems(change({ quote: 'The field is deprecated.' }), PAGE)).toEqual([
      'the quote is not in the saved page',
      'the quote does not name instagram_actor_id',
      'the quote does not name the replacement instagram_user_id',
    ]);
    expect(quoteProblems(change({ quote: '' }), PAGE)).toEqual(['no quote']);
  });

  it('accepts a rule that answers its change and refuses one that does not', () => {
    expect(checkMetaGraphEvidence([change()], table([rule()]), pages)).toEqual([]);
    expect(checkMetaGraphEvidence([change()], table([]), pages)).toEqual([
      `${change().id}: names a replacement but has no rule.`,
    ]);
    expect(
      checkMetaGraphEvidence([change()], table([rule({ to: 'instagram_id' })]), pages),
    ).toContain(
      `${change().id}-replacement: from and to must be the change's subject and replacement.`,
    );
    expect(
      checkMetaGraphEvidence(
        [change({ source: 'https://developers.facebook.com/docs/x' })],
        [],
        pages,
      ),
    ).toContain(`${change().id}: no saved page for https://developers.facebook.com/docs/x.`);
  });

  it('backs every committed change and rule with its saved page', async () => {
    const { changes } = JSON.parse(await readFile(DEFAULT_META_GRAPH_CHANGES, 'utf8'));
    const { pages, tables } = await readMetaGraphEvidence();
    expect(checkMetaGraphEvidence(changes, tables, pages)).toEqual([]);
    expect(tables.length).toBeGreaterThan(0);
  });
});
