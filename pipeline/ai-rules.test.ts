import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkAiRuleTables, collapse, loadAiRuleTables, parseAiRuleTable } from './ai-rules.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const page = {
  url: 'https://github.com/openai/openai-node/blob/master/MIGRATION.md',
  file: 'docs/ai-docs/pages/example.md',
  capturedAt: '2026-10-29',
};
const rule = {
  rule: 'example-rule',
  family: 'method-rename',
  status: 'auto',
  page: 'example',
  quote: 'client.files.delete();',
  checkedAt: '2026-10-29',
  origin: 'docs',
  summary: 'Renames del.',
  data: { old: 'files.del', new: 'files.delete' },
};
const table = (overrides: Record<string, unknown> = {}, rules = [rule]) => ({
  formatVersion: 1,
  provider: 'openai',
  kind: 'sdk-major',
  pages: { example: page },
  rules,
  ...overrides,
});

it('accepts a rule quoting an official page and checks the quote on the saved copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-rules-'));
  roots.push(root);
  await mkdir(join(root, 'docs/ai-docs/pages'), { recursive: true });
  await writeFile(join(root, page.file), 'Before\n\n// After\nclient.files.delete();\n');
  const parsed = parseAiRuleTable(table(), 'example.json');
  expect(await checkAiRuleTables([parsed], { root })).toEqual([]);
  const moved = parseAiRuleTable(table({}, [{ ...rule, quote: 'client.files.remove();' }]), 'x');
  expect(await checkAiRuleTables([moved], { root })).toEqual([
    expect.objectContaining({
      rule: 'example-rule',
      problem: expect.stringContaining('not on the saved page'),
    }),
  ]);
  const live = await checkAiRuleTables([parsed], {
    root,
    live: async () => 'the page no longer says it',
  });
  expect(live).toEqual([
    expect.objectContaining({ problem: expect.stringContaining('no longer on') }),
  ]);
  const unreachable = await checkAiRuleTables([parsed], {
    root,
    live: async () => {
      throw new Error('offline');
    },
  });
  expect(unreachable).toEqual([
    expect.objectContaining({ problem: expect.stringContaining('could not be read') }),
  ]);
});

it('refuses unofficial pages, editing Gemini rules, generated rules without provenance and short quotes', () => {
  expect(() =>
    parseAiRuleTable(
      table({ pages: { example: { ...page, url: 'https://blog.example.com/openai' } } }),
      'x',
    ),
  ).toThrow(/official openai/);
  expect(() =>
    parseAiRuleTable(
      table({ pages: { example: { ...page, url: 'https://github.com/someone/openai-node' } } }),
      'x',
    ),
  ).toThrow(/official openai/);
  expect(() =>
    parseAiRuleTable(
      table({
        provider: 'gemini',
        pages: { example: { ...page, url: 'https://ai.google.dev/gemini-api/docs/migrate' } },
      }),
      'x',
    ),
  ).toThrow(/limited to the documented SDK swap/);
  expect(() => parseAiRuleTable(table({}, [{ ...rule, origin: 'generated' }]), 'x')).toThrow(
    /generatedBy/,
  );
  expect(() => parseAiRuleTable(table({}, [{ ...rule, quote: 'short' }]), 'x')).toThrow(/quote/);
  expect(() => parseAiRuleTable(table({}, [rule, rule]), 'x')).toThrow(/duplicate/);
});

it('collapses whitespace the way rendered Markdown does', () => {
  expect(collapse('a\n  b\t\tc ')).toBe('a b c');
});

it('every shipped rule quotes its saved page', async () => {
  const tables = await loadAiRuleTables();
  expect(tables.map((item) => `${item.provider}/${item.kind}`)).toEqual(
    expect.arrayContaining(['openai/sdk-major', 'anthropic/sdk-major']),
  );
  expect(await checkAiRuleTables(tables)).toEqual([]);
});
