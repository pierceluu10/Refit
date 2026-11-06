import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Obligation } from '../shared/types.ts';
import { listObligations, saveObligations } from './obligations.ts';

// Illustrative obligations.
const obligation = (id: string, requirement: string): Obligation => ({
  id,
  rule: { name: 'Example rule', url: 'https://example.com/rule', quote: '(illustrative)' },
  requirement,
  appliesTo: 'forms',
  inCode: 'labels',
  checkable: [],
  needsHuman: ['whether the business is in scope'],
});

describe('stored obligations', () => {
  it('answers [] before any read, keeps earlier ids and lets the newest read win', async () => {
    const env = { REFIT_AUDIT_DIR: await mkdtemp(join(tmpdir(), 'refit-obligations-')) };
    expect(await listObligations(env)).toEqual([]);
    await saveObligations([obligation('a', 'old'), obligation('b', 'kept')], env);
    await saveObligations([obligation('a', 'new')], env);
    const stored = await listObligations(env);
    expect(stored.map((o) => [o.id, o.requirement])).toEqual([
      ['a', 'new'],
      ['b', 'kept'],
    ]);
  });
});
