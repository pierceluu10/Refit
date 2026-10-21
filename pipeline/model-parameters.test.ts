import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkModelParameters,
  loadModelParameters,
  type ModelParameterEntry,
} from './model-parameters.ts';
import { PipelineInputError } from './types.ts';

const NOW = new Date('2026-10-21T12:00:00Z');
const OVERVIEW = 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview';
const valid = (): ModelParameterEntry => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  parameters: { temperature: { accepts: 'default-only', default: 1 }, top_k: { accepts: 'none' } },
  source: OVERVIEW,
  defaultSource: 'https://platform.claude.com/docs/en/api/messages',
  checkedAt: '2026-10-21',
});
const table = (...models: unknown[]) => ({ formatVersion: 1, models });
const edit = (change: (entry: Record<string, any>) => void) => {
  const entry = valid() as unknown as Record<string, any>;
  change(entry);
  return table(entry);
};
const openai = (parameters: unknown) =>
  edit((e) => {
    e.provider = 'openai';
    e.model = 'o3';
    delete e.defaultSource;
    e.parameters = parameters;
  });

it('accepts a valid entry', () => {
  expect(checkModelParameters(table(valid()), NOW).errors).toEqual([]);
});

const rejected: [string, unknown][] = [
  ['missing source', edit((e) => delete e.source)],
  ['missing checkedAt', edit((e) => delete e.checkedAt)],
  ['http source', edit((e) => (e.source = OVERVIEW.replace('https', 'http')))],
  ['look-alike host', edit((e) => (e.source = 'https://developers.openai.com.evil.test/x'))],
  ['suffix host', edit((e) => (e.source = 'https://evil-platform.claude.com/x'))],
  ['credentials', edit((e) => (e.source = 'https://u:p@platform.claude.com/x'))],
  ['port', edit((e) => (e.source = 'https://platform.claude.com:8443/x'))],
  ['impossible date', edit((e) => (e.checkedAt = '2026-02-31'))],
  ['future date', edit((e) => (e.checkedAt = '2026-10-22'))],
  ['unknown provider', edit((e) => (e.provider = 'google'))],
  ['unknown entry key', edit((e) => (e.extra = 1))],
  ['unknown top-level key', { ...table(valid()), extra: 1 }],
  ['unknown spec key', edit((e) => (e.parameters.top_k.extra = 1))],
  ['top_k under openai', openai({ top_k: { accepts: 'none' } })],
  ['max_tokens under anthropic', edit((e) => (e.parameters = { max_tokens: { accepts: 'none' } }))],
  ['bad accepts', edit((e) => (e.parameters.top_k.accepts = 'some'))],
  ['default-only without default', edit((e) => delete e.parameters.temperature.default)],
  ['non-numeric default', edit((e) => (e.parameters.temperature.default = 'x'))],
  ['default on any', edit((e) => (e.parameters.top_k = { accepts: 'any', default: 1 }))],
  ['min above max', edit((e) => (e.parameters.top_k = { accepts: 'any', min: 2, max: 1 }))],
  ['min on default-only', edit((e) => (e.parameters.temperature.min = 0))],
  ['renamedTo on any', edit((e) => (e.parameters.top_k = { accepts: 'any', renamedTo: 'top_p' }))],
  ['bad renamedTo', edit((e) => (e.parameters.top_k.renamedTo = 'max-tokens!'))],
  ['renamedTo equals name', edit((e) => (e.parameters.top_k.renamedTo = 'top_k'))],
  ['default without defaultSource', edit((e) => delete e.defaultSource)],
  [
    'look-alike defaultSource',
    edit((e) => (e.defaultSource = 'https://platform.claude.com.evil.test/x')),
  ],
  [
    'defaultSource without default',
    edit((e) => {
      e.parameters = { top_k: { accepts: 'none' } };
    }),
  ],
  ['empty parameters', edit((e) => (e.parameters = {}))],
  ['duplicate model', table(valid(), valid())],
  ['formatVersion 2', { ...table(valid()), formatVersion: 2 }],
];

it.each(rejected)('rejects %s', (_name, value) => {
  expect(checkModelParameters(value, NOW).errors.length).toBeGreaterThan(0);
});

it('rejects the whole file when one entry is bad', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'refit-parameters-'));
  try {
    const path = join(directory, 'table.json');
    const bad = { ...valid(), model: 'other', source: 'https://developers.openai.com.evil.test/x' };
    await writeFile(path, JSON.stringify(table(valid(), bad)));
    await expect(loadModelParameters(path, NOW)).rejects.toBeInstanceOf(PipelineInputError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
