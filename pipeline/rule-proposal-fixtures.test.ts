import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEASUREMENT_LISTS } from './ai-misses.ts';
import { loadAiRuleTables } from './ai-rules.ts';
import { loadParameterChanges } from './model-parameter-changes.ts';
import { checkFixture, readFixtures } from './rule-proposal-fixtures.ts';
import { LEDGER, parseLedger } from './rule-proposals.ts';

// Every accepted proposal's synthetic fixture (data/rule-proposals/fixtures), run against the
// shipped tables, and the committed ledger's own rules.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('rule proposal ledger', () => {
  it('parses, and every decision names who made it, why, and for an acceptance its fixture', async () => {
    const ledger = parseLedger(JSON.parse(await readFile(`${ROOT}${LEDGER}`, 'utf8')));
    const fixtures = new Set((await readFixtures(ROOT)).map((fixture) => fixture.proposal));
    for (const entry of ledger.proposals) {
      if (entry.status === 'accepted') expect(fixtures, entry.id).toContain(entry.id);
      // Measurement sets are never mined, so no evidence row comes from one.
      for (const item of entry.evidence)
        expect(MEASUREMENT_LISTS.has(item.list), entry.id).toBe(false);
    }
  });
});

describe('accepted rule fixtures', async () => {
  const fixtures = await readFixtures(ROOT);
  it.skipIf(fixtures.length > 0)('has none until a proposal is accepted', () => {
    expect(fixtures).toEqual([]);
  });
  it.each(fixtures.map((fixture) => [fixture.proposal, fixture] as const))(
    '%s: the accepted rule does what its proposal showed',
    async (_, fixture) => {
      const tables = await loadAiRuleTables();
      const parameters = await loadParameterChanges();
      const ids = new Set([
        ...tables.flatMap((table) => table.rules.map((rule) => rule.rule)),
        ...parameters.changes.map((change) => change.id),
        ...JSON.parse(await readFile(`${ROOT}data/deadlines.json`, 'utf8')).deadlines.map(
          (deadline: { id: string }) => deadline.id,
        ),
      ]);
      expect(
        await checkFixture(fixture, { tables, parameters, known: (id) => ids.has(id) }),
      ).toEqual([]);
    },
  );
});
