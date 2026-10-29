import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { FINE_TUNED_QUOTE, FINE_TUNED_SCHEDULE_QUOTE, modelAlerts } from './model-alerts.ts';

const NOW = new Date('2026-10-29T00:00:00Z');
const registry: DeadlineRegistry = {
  formatVersion: 1,
  deadlines: [
    {
      id: 'openai-2027-01-14-gpt-4o-2024-08-06',
      provider: 'openai',
      kind: 'model',
      versions: ['gpt-4o-mini-2024-07-18', 'gpt-4o-2024-08-06'],
      date: '2027-01-14',
      summary: 'OpenAI shuts down GPT-4o snapshots.',
      replacement: 'gpt-6-luna',
      source: 'https://developers.openai.com/api/docs/deprecations',
      checkedAt: '2026-10-29',
    },
    {
      id: 'gemini-2026-01-14-text-embedding-004',
      provider: 'gemini',
      kind: 'model',
      versions: ['text-embedding-004'],
      date: '2026-01-14',
      summary: 'Google shuts down text-embedding-004.',
      replacement: 'gemini-embedding-2',
      source: 'https://ai.google.dev/gemini-api/docs/deprecations',
      checkedAt: '2026-10-29',
    },
  ],
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-model-alerts-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('modelAlerts', () => {
  it('alerts on a fine-tuned model whose base retires, and never on the base alone', async () => {
    const root = await repository({
      'src/chat.ts': [
        "const tuned = 'ft:gpt-4o-mini-2024-07-18:acme:support:9xYz1';",
        "const base = 'gpt-4o-2024-08-06';",
      ].join('\n'),
    });
    const { alerts } = await modelAlerts(root, registry, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'fine-tuned',
      file: 'src/chat.ts',
      line: 1,
      model: 'ft:gpt-4o-mini-2024-07-18:acme:support:9xYz1',
      retiring: 'gpt-4o-mini-2024-07-18',
      replacement: 'gpt-6-luna',
      days: 77,
      quote: FINE_TUNED_QUOTE,
    });
    expect(alerts[0].reason).toContain('needs a new fine-tuning job');
  });

  it('alerts on an embedding model in code, Gemini prefix included', async () => {
    const root = await repository({
      'lib/embed.js': "await ai.models.embedContent({ model: 'models/text-embedding-004' });",
    });
    const { alerts } = await modelAlerts(root, registry, NOW);
    expect(alerts.map((alert) => [alert.kind, alert.model, alert.days])).toEqual([
      ['embedding', 'text-embedding-004', -288],
    ]);
    expect(alerts[0].reason).toContain('re-embedded');
  });

  it('alerts on configuration values and names where code reads them', async () => {
    const root = await repository({
      '.env.example': 'OPENAI_MODEL=gpt-4o-2024-08-06 # chat\nOTHER=1\n',
      'config/app.yaml': 'llm:\n  model: "gpt-4o-2024-08-06"\n',
      'config/models.json': '["gpt-4o-2024-08-06", "gpt-6-luna"]\n',
      'package-lock.json': '{ "model": "gpt-4o-2024-08-06" }',
      'src/env.ts': 'export const model = process.env.OPENAI_MODEL;\n',
    });
    const { alerts } = await modelAlerts(root, registry, NOW);
    expect(
      alerts.map((alert) => [alert.kind, alert.file, alert.line, alert.key, alert.readAt]),
    ).toEqual([
      ['configuration', '.env.example', 1, 'OPENAI_MODEL', ['src/env.ts:1']],
      ['configuration', 'config/app.yaml', 2, 'model', []],
    ]);
    expect(alerts[0].reason).toContain('Refit does not edit configuration');
  });

  it('skips build output and dependencies', async () => {
    const root = await repository({
      'node_modules/x/index.js': "const m = 'text-embedding-004';",
      'dist/app.js': "const m = 'text-embedding-004';",
    });
    expect((await modelAlerts(root, registry, NOW)).alerts).toEqual([]);
  });
});

it('quotes OpenAI fine-tuning sentences that are on the saved page', async () => {
  const page = await readFile(
    new URL('../docs/benchmarks/deprecation-pages/openai.md', import.meta.url),
    'utf8',
  );
  expect(page).toContain(FINE_TUNED_QUOTE);
  expect(page).toContain(FINE_TUNED_SCHEDULE_QUOTE);
});
