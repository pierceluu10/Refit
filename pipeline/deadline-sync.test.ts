import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  checkDeadlineRegistry,
  type DeadlineEntry,
  type DeadlineRegistry,
} from './deadline-registry.ts';
import {
  ANTHROPIC_DEPRECATIONS,
  DEPRECATION_SOURCES,
  OPENAI_DEPRECATIONS,
  parseAnthropicDeprecations,
  parseGeminiDeprecations,
  parseOpenAiDeprecations,
  syncDeadlines,
  type SyncProvider,
} from './deadline-sync.ts';

// Copies of the providers' pages as served on 2026-10-22; see fixtures/deprecations/README.md.
const fixture = (provider: SyncProvider) =>
  readFile(`pipeline/fixtures/deprecations/${provider}.md`, 'utf8');

const shipped = async () =>
  JSON.parse(await readFile('data/deadlines.json', 'utf8')) as DeadlineRegistry;

const empty = (): DeadlineRegistry => ({ formatVersion: 1, deadlines: [] });

const entry = (fields: Partial<DeadlineEntry> & Pick<DeadlineEntry, 'id'>): DeadlineEntry => ({
  provider: 'openai',
  kind: 'model',
  versions: [],
  date: '2026-10-23',
  summary: 'A summary a person wrote.',
  replacement: null,
  source: OPENAI_DEPRECATIONS,
  checkedAt: '2026-10-20',
  ...fields,
});

const row = (date: string, model: string, replacements: string[], note: string | null = null) => ({
  date,
  model,
  replacements,
  note,
});

// The shape of Anthropic's model deprecations page (checked 2026-10-20): a model status table,
// then one table per announcement. Only the announcement tables are read.
const PAGE = `## Model status

| API model name             | Current state | Deprecated         | Tentative retirement date          |
| :------------------------- | :------------ | :----------------- | :--------------------------------- |
| claude-sonnet-4-5-20250929 | Deprecated    | September 30, 2026 | November 30, 2026                  |

### 2026-09-30: Claude Sonnet 4.5 model

| Retirement date   | Deprecated model             | Recommended replacement |
| ----------------- | ---------------------------- | ----------------------- |
| November 30, 2026 | \`claude-sonnet-4-5-20250929\` | \`claude-sonnet-5-5\`     |

### 2026-04-14: Claude Sonnet 4 and Claude Opus 4 models

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| June 15, 2026   | \`claude-sonnet-4-20250514\` | \`claude-sonnet-5-5\`     |
| June 15, 2026   | \`claude-opus-4-20250514\`   | \`claude-opus-4-8\`       |

### 2025-01-21: Claude 2 models

| Retirement date | Deprecated model | Recommended replacement |
| --------------- | ---------------- | ----------------------- |
| July 21, 2025   | \`claude-2.0\`     | \`claude-opus-4-8\`       |
| July 21, 2025   | \`claude-2.1\`     | \`claude-opus-4-8\`       |
`;

describe('Anthropic', () => {
  it('reads the announcement tables and fails loudly on a row it does not recognize', () => {
    expect(parseAnthropicDeprecations(PAGE)).toEqual({
      rows: [
        row('2026-11-30', 'claude-sonnet-4-5-20250929', ['claude-sonnet-5-5']),
        row('2026-06-15', 'claude-sonnet-4-20250514', ['claude-sonnet-5-5']),
        row('2026-06-15', 'claude-opus-4-20250514', ['claude-opus-4-8']),
        row('2025-07-21', 'claude-2.0', ['claude-opus-4-8']),
        row('2025-07-21', 'claude-2.1', ['claude-opus-4-8']),
      ],
      skipped: [],
    });
    expect(() =>
      parseAnthropicDeprecations(
        PAGE.replace('June 15, 2026   | `claude-opus', 'Soon | `claude-opus'),
      ),
    ).toThrow(/Unrecognized row/);
    expect(() =>
      parseAnthropicDeprecations(PAGE.replace('| `claude-2.1`     |', '| claude-2.1     |')),
    ).toThrow(/Unrecognized row/);
    expect(() =>
      parseAnthropicDeprecations(PAGE.replace('| July 21, 2025   |', '| February 30, 2025 |')),
    ).toThrow(/Unrecognized row/);
    expect(() => parseAnthropicDeprecations('# Nothing here')).toThrow(/No deprecation table/);
  });

  it('reads every row of the saved page', async () => {
    const page = parseAnthropicDeprecations(await fixture('anthropic'));
    expect(page.rows).toHaveLength(20);
    expect(page.rows).toContainEqual(
      row('2026-11-30', 'claude-sonnet-4-5-20250929', ['claude-sonnet-5-5']),
    );
  });

  it('adds new retirements, updates moved ones in place and keeps aliases, dates and order', () => {
    const kept = entry({
      id: 'anthropic-2026-11-30-claude-sonnet-4-5',
      provider: 'anthropic',
      versions: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
      date: '2026-11-30',
      summary: 'A summary a person wrote, naming the alias.',
      replacement: 'claude-sonnet-5-5',
      source: ANTHROPIC_DEPRECATIONS,
    });
    const registry: DeadlineRegistry = {
      formatVersion: 1,
      deadlines: [
        entry({ id: 'openai-gpt-4', versions: ['gpt-4'], checkedAt: '2026-10-15' }),
        kept,
        // Its date moved on the page.
        {
          ...kept,
          id: 'anthropic-2026-06-01-claude-opus-4',
          versions: ['claude-opus-4-20250514'],
          date: '2026-06-01',
          replacement: 'claude-opus-4-8',
          summary: 'Old.',
        },
        // No longer on the page: kept for review.
        {
          ...kept,
          id: 'anthropic-2024-11-06-claude-1',
          versions: ['claude-1.0'],
          date: '2024-11-06',
          replacement: 'claude-haiku-4-5-20251001',
          summary: 'Claude 1.',
        },
      ],
    };
    const sync = syncDeadlines(
      registry,
      DEPRECATION_SOURCES.anthropic,
      parseAnthropicDeprecations(PAGE).rows,
      '2026-10-21',
    );
    // In page order; the registry appends them by date.
    expect(sync.added).toEqual([
      'anthropic-2026-06-15-claude-sonnet-4',
      'anthropic-2025-07-21-claude-2',
    ]);
    expect(sync.changed).toEqual(['anthropic-2026-06-01-claude-opus-4']);
    expect(sync.rechecked).toEqual([]);
    expect(sync.missing).toEqual(['anthropic-2024-11-06-claude-1']);
    expect(sync.registry.deadlines.map((item) => [item.id, item.date, item.checkedAt])).toEqual([
      ['openai-gpt-4', '2026-10-23', '2026-10-15'],
      ['anthropic-2026-11-30-claude-sonnet-4-5', '2026-11-30', '2026-10-20'],
      ['anthropic-2026-06-01-claude-opus-4', '2026-06-15', '2026-10-21'],
      ['anthropic-2024-11-06-claude-1', '2024-11-06', '2026-10-20'],
      ['anthropic-2025-07-21-claude-2', '2025-07-21', '2026-10-21'],
      ['anthropic-2026-06-15-claude-sonnet-4', '2026-06-15', '2026-10-21'],
    ]);
    // The unchanged entry keeps its alias and summary.
    expect(sync.registry.deadlines[1]).toBe(kept);
    expect(sync.registry.deadlines.at(-2)).toMatchObject({
      versions: ['claude-2.0', 'claude-2.1'],
      replacement: 'claude-opus-4-8',
      summary:
        'Anthropic retires claude-2.0, claude-2.1 on the Claude API; requests to a retired model fail.',
      source: ANTHROPIC_DEPRECATIONS,
    });
    expect(checkDeadlineRegistry(sync.registry, new Date('2026-10-21T00:00:00Z')).errors).toEqual(
      [],
    );
  });

  it('leaves the shipped registry unchanged against the page it was written from', async () => {
    const registry = await shipped();
    const anthropic = registry.deadlines.filter((item) => item.provider === 'anthropic');
    // Rebuild the page's rows from the shipped entries, as the page listed them on 2026-10-20.
    const rows = anthropic.flatMap((item) =>
      item.versions
        .filter((version) => version !== 'claude-sonnet-4-5')
        .map((model) => row(item.date, model, [item.replacement!])),
    );
    // The earliest check, so no entry is stale.
    const today = anthropic.map((item) => item.checkedAt).sort()[0];
    const sync = syncDeadlines(registry, DEPRECATION_SOURCES.anthropic, rows, today);
    expect([sync.added, sync.changed, sync.rechecked, sync.missing]).toEqual([[], [], [], []]);
    expect(sync.registry).toEqual(registry);
  });

  it('stops when the page splits one registry entry across retirement dates', () => {
    const registry: DeadlineRegistry = {
      formatVersion: 1,
      deadlines: [
        entry({
          id: 'anthropic-2025-07-21-claude-2.0',
          provider: 'anthropic',
          versions: ['claude-2.0', 'claude-2.1'],
          date: '2025-07-21',
          replacement: 'claude-opus-4-8',
          source: ANTHROPIC_DEPRECATIONS,
        }),
      ],
    };
    const page = PAGE.replace(
      '| July 21, 2025   | `claude-2.1`',
      '| August 4, 2025  | `claude-2.1`',
    );
    expect(page).not.toBe(PAGE);
    expect(() =>
      syncDeadlines(
        registry,
        DEPRECATION_SOURCES.anthropic,
        parseAnthropicDeprecations(page).rows,
        '2026-10-21',
      ),
    ).toThrow(
      "Anthropic's page splits registry entry anthropic-2025-07-21-claude-2.0 across retirement dates or replacements; update it by hand.",
    );
  });
});

describe('OpenAI', () => {
  it('reads every shutdown table of the saved page and says why it skips the rest', async () => {
    const page = parseOpenAiDeprecations(await fixture('openai'));
    expect(page.rows).toHaveLength(144);
    expect(new Set(page.rows.map((item) => item.model)).size).toBe(144);
    for (const expected of [
      // A display name around the snapshots.
      row('2027-01-14', 'gpt-4o-2024-08-06', ['gpt-6-luna']),
      row('2027-01-14', 'gpt-4o-2024-11-20', ['gpt-6-luna']),
      row('2027-01-14', 'gpt-4.1-mini-2025-04-14', ['gpt-6-luna']),
      // A short month name.
      row('2027-04-01', 'gpt-5.3-codex', ['gpt-6-sol']),
      // A snapshot and its aliases, separated by an escaped pipe.
      row('2026-10-23', 'gpt-4-0613', ['gpt-5.6-sol']),
      row('2026-10-23', 'gpt-4', ['gpt-5.6-sol']),
      row('2026-10-23', 'gpt-4-completions', ['gpt-5.6-sol']),
      // An ISO date written with non-breaking hyphens, aliases that point to the snapshot, and a
      // recommendation with a wildcard kept as a note.
      row('2026-03-26', 'gpt-4-0125-preview', ['gpt-5'], 'gpt-5 or gpt-4.1*'),
      row('2026-03-26', 'gpt-4-turbo-preview-completions', ['gpt-5'], 'gpt-5 or gpt-4.1*'),
      // A firm date in a later announcement replaces the earlier "at earliest" row.
      row('2026-03-26', 'gpt-4-0314', ['gpt-5'], 'gpt-5 or gpt-4.1*'),
      // Alternatives.
      row('2027-02-26', 'whisper-1', ['gpt-live-transcribe', 'gpt-transcribe']),
      // A required setting.
      row('2026-12-11', 'o3-pro-2025-06-10', ['gpt-5.6-sol'], 'gpt-5.6-sol (reasoning.mode: pro)'),
      row('2026-10-23', 'o1-pro', ['gpt-5.6-sol'], 'gpt-5.6-sol (reasoning.mode: pro)'),
      // No model at all.
      row('2026-10-01', 'gpt-5.4-cyber', [], 'The most capable cyber model available to you'),
      row('2026-09-24', 'sora-2', []),
      // Listed by two announcements: the 2023-07-06 one replaces the 2023-03-20 one.
      row('2024-01-04', 'code-davinci-002', ['gpt-3.5-turbo-instruct']),
    ])
      expect(page.rows).toContainEqual(expected);
    const reason = {
      api: 'an API or request header, not a model',
      endpoint: 'an endpoint, not a model',
      fineTuned: 'the fine-tuned models of a base model, whose IDs start with ft:',
      training: 'new fine-tuning training only; the model is not shut down',
      word: 'a plain word that, as a quoted string, also names unrelated things',
    };
    expect(page.skipped).toEqual([
      { date: '2027-02-26', text: '/v1/audio/translations', reason: reason.endpoint },
      { date: '2026-10-23', text: 'ft-o4-mini-2025-04-16', reason: reason.fineTuned },
      { date: '2026-10-23', text: 'ft-gpt-3.5-turbo', reason: reason.fineTuned },
      { date: '2026-10-23', text: 'ft-gpt-4', reason: reason.fineTuned },
      { date: '2026-10-23', text: 'ft-gpt-4.1-nano-2025-04-14', reason: reason.fineTuned },
      { date: '2026-10-23', text: 'ft-babbage-002', reason: reason.fineTuned },
      { date: '2026-10-23', text: 'ft-davinci-002', reason: reason.fineTuned },
      { date: '2026-09-24', text: 'Videos API', reason: reason.api },
      { date: '2026-05-12', text: 'OpenAI-Beta: realtime=v1', reason: reason.api },
      { date: '2026-08-26', text: 'Assistants API', reason: reason.api },
      { date: '2024-12-18', text: 'OpenAI-Beta: assistants=v1', reason: reason.api },
      {
        date: '2024-10-28',
        text: 'New fine-tuning training on babbage-002',
        reason: reason.training,
      },
      {
        date: '2024-10-28',
        text: 'New fine-tuning training on davinci-002',
        reason: reason.training,
      },
      { date: '2024-01-04', text: '/v1/fine-tunes', reason: reason.endpoint },
      { date: '2024-01-04', text: 'ada', reason: reason.word },
      { date: '2024-01-04', text: 'babbage', reason: reason.word },
      { date: '2024-01-04', text: 'curie', reason: reason.word },
      { date: '2024-01-04', text: 'davinci', reason: reason.word },
      { date: '2024-01-04', text: '/v1/edits', reason: reason.endpoint },
      { date: '2022-12-03', text: '/v1/engines', reason: reason.endpoint },
      { date: '2022-12-03', text: '/v1/search', reason: reason.endpoint },
      { date: '2022-12-03', text: '/v1/classifications', reason: reason.endpoint },
      { date: '2022-12-03', text: '/v1/answers', reason: reason.endpoint },
    ]);
  });

  const TABLE = `### 2026-10-14: GPT-4 series model deprecations

| Shutdown date    | Model / system                                | Recommended replacement |
| ---------------- | --------------------------------------------- | ----------------------- |
| January 14, 2027 | GPT-4o (\`gpt-4o-2024-08-06\`)                  | \`gpt-6-luna\`            |

### 2023-06-13: Updated chat models

| Shutdown date          | Legacy model | Legacy model price | Recommended replacement |
| ---------------------- | ------------ | ------------------ | ----------------------- |
| at earliest 2024-06-13 | \`gpt-4-0314\` | $30.00 / 1M        | \`gpt-4o\`                |
`;

  it('skips a model whose only date is "at earliest" and fails on any row or table it does not recognize', () => {
    expect(parseOpenAiDeprecations(TABLE)).toEqual({
      rows: [row('2027-01-14', 'gpt-4o-2024-08-06', ['gpt-6-luna'])],
      skipped: [{ date: null, text: 'gpt-4-0314', reason: 'no firm shutdown date' }],
    });
    for (const [from, to] of [
      // An unknown date.
      ['| January 14, 2027 |', '| Early 2027 |'],
      // A model outside backticks.
      ['GPT-4o (`gpt-4o-2024-08-06`)', 'GPT-4o (gpt-4o-2024-08-06)'],
      // An unknown model cell form.
      ['GPT-4o (`gpt-4o-2024-08-06`)', '`gpt-4o-2024-08-06` and later'],
      // A missing cell.
      ['| `gpt-6-luna`            |', '|'],
    ])
      expect(() => parseOpenAiDeprecations(TABLE.replace(from, to)), from).toThrow(
        /Unrecognized row in OpenAI's deprecation table/,
      );
    expect(() =>
      parseOpenAiDeprecations(TABLE.replace('| Model / system ', '| Product        ')),
    ).toThrow(/Unrecognized table on OpenAI's deprecations page/);
    expect(() => parseOpenAiDeprecations('# Nothing here')).toThrow(/No deprecation table/);
  });

  it('fails when one announcement lists a model twice with different rows', () => {
    const twice = TABLE.replace(
      '| January 14, 2027 | GPT-4o (`gpt-4o-2024-08-06`)                  | `gpt-6-luna`            |',
      [
        '| January 14, 2027 | `gpt-4o-2024-08-06` | `gpt-6-luna` |',
        '| January 21, 2027 | `gpt-4o-2024-08-06` | `gpt-6-luna` |',
      ].join('\n'),
    );
    expect(() => parseOpenAiDeprecations(twice)).toThrow(
      "OpenAI's deprecations page lists gpt-4o-2024-08-06 twice under one announcement with a different date or replacement.",
    );
  });
});

describe('Gemini API', () => {
  it('reads the model tables of the saved page and skips managed agents', async () => {
    const page = parseGeminiDeprecations(await fixture('gemini'));
    expect(page.rows).toHaveLength(52);
    const models = page.rows.map((item) => item.model);
    // No shutdown date announced, and an endpoint that keeps routing (N/A).
    expect(models).not.toContain('gemini-3.8-flash');
    expect(models).not.toContain('gemini-3.7-flash');
    for (const expected of [
      row('2027-05-07', 'gemini-3.1-flash-lite', ['gemini-3.5-flash-lite']),
      // Under a "Preview models" group row.
      row('2026-03-09', 'gemini-3-pro-preview', ['gemini-3.1-pro-preview']),
      row('2026-11-17', 'gemini-2.5-pro-preview-tts', [
        'gemini-3.8-flash-tts',
        'gemini-3.8-flash-lite-tts',
      ]),
      row(
        '2026-06-30',
        'veo-3.0-generate-001',
        ['gemini-omni-1.1-flash'],
        'gemini-omni-1.1-flash or the GA models on the Gemini Enterprise Agent Platform',
      ),
    ])
      expect(page.rows).toContainEqual(expected);
    expect(page.skipped).toEqual([
      {
        date: '2026-10-23',
        text: 'deep-research-pro-preview-12-2025',
        reason: 'a managed agent, not a model',
      },
      {
        date: '2026-10-05',
        text: 'antigravity-preview-05-2026',
        reason: 'a managed agent, not a model',
      },
    ]);
  });

  const TABLE = `## Gemini 3 models

| **Model** | **Release date** | **Shutdown date** | **Recommended replacement** |
| --- | --- | --- | --- |
| \`gemini-3.8-flash\` | September 2, 2026 | No shutdown date announced |   |
| Preview models ||||
| \`gemini-3-pro-preview\` | November 18, 2025 | March 9, 2026 | \`gemini-3.1-pro-preview\` |
`;

  it('fails on any row or table it does not recognize', () => {
    expect(parseGeminiDeprecations(TABLE).rows).toEqual([
      row('2026-03-09', 'gemini-3-pro-preview', ['gemini-3.1-pro-preview']),
    ]);
    for (const [from, to] of [
      ['| March 9, 2026 |', '| Q1 2026 |'],
      ['| `gemini-3-pro-preview` |', '| Gemini 3 Pro Preview |'],
      ['| `gemini-3.1-pro-preview` |', '|'],
    ])
      expect(() => parseGeminiDeprecations(TABLE.replace(from, to)), from).toThrow(
        /Unrecognized row in the Gemini API's deprecation table/,
      );
    expect(() => parseGeminiDeprecations(TABLE.replace('**Model**', '**Product**'))).toThrow(
      /Unrecognized table on the Gemini API's deprecations page/,
    );
    expect(() => parseGeminiDeprecations(TABLE.split('| Preview')[0])).toThrow(
      /No deprecation table/,
    );
  });
});

describe('syncDeadlines', () => {
  it('builds a valid registry from each saved page and finds nothing new on a second run', async () => {
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      const source = DEPRECATION_SOURCES[provider];
      const page = source.parse(await fixture(provider));
      const first = syncDeadlines(empty(), source, page.rows, '2026-10-22');
      expect(first.registry.deadlines.length, provider).toBe(first.added.length);
      expect(first.registry.deadlines.flatMap((item) => item.versions).sort(), provider).toEqual(
        page.rows.map((item) => item.model).sort(),
      );
      expect(
        checkDeadlineRegistry(first.registry, new Date('2026-10-22T00:00:00Z')).errors,
        provider,
      ).toEqual([]);
      const second = syncDeadlines(first.registry, source, page.rows, '2026-10-22');
      expect([second.added, second.changed, second.rechecked, second.missing], provider).toEqual([
        [],
        [],
        [],
        [],
      ]);
      expect(second.registry, provider).toEqual(first.registry);
    }
  });

  it('names a replacement only for a single recommended model with nothing beside it', () => {
    const { registry } = syncDeadlines(
      empty(),
      DEPRECATION_SOURCES.openai,
      [
        row('2026-10-23', 'gpt-4.1-nano', ['gpt-5.6-luna']),
        row('2027-02-26', 'whisper-1', ['gpt-live-transcribe', 'gpt-transcribe']),
        row('2026-10-23', 'o1-pro', ['gpt-5.6-sol'], 'gpt-5.6-sol (reasoning.mode: pro)'),
        row('2026-09-24', 'sora-2', []),
      ],
      '2026-10-22',
    );
    expect(
      registry.deadlines.map(({ id, replacement, summary }) => ({ id, replacement, summary })),
    ).toEqual([
      {
        id: 'openai-2026-09-24-sora-2',
        replacement: null,
        summary: 'OpenAI shuts down sora-2 on the API; requests to a shut-down model fail.',
      },
      {
        id: 'openai-2026-10-23-gpt-4-1-nano',
        replacement: 'gpt-5.6-luna',
        summary: 'OpenAI shuts down gpt-4.1-nano on the API; requests to a shut-down model fail.',
      },
      {
        id: 'openai-2026-10-23-o1-pro',
        replacement: null,
        summary:
          'OpenAI shuts down o1-pro on the API; requests to a shut-down model fail. The page recommends: gpt-5.6-sol (reasoning.mode: pro).',
      },
      {
        id: 'openai-2027-02-26-whisper-1',
        replacement: null,
        summary:
          'OpenAI shuts down whisper-1 on the API; requests to a shut-down model fail. The page recommends: gpt-live-transcribe or gpt-transcribe.',
      },
    ]);
  });

  it("keeps a person's pick among the page's alternatives, and drops it when the page stops offering it", () => {
    const picked = entry({
      id: 'openai-2027-02-26-whisper-1',
      versions: ['whisper-1'],
      date: '2027-02-26',
      replacement: 'gpt-transcribe',
    });
    const offered = [row('2027-02-26', 'whisper-1', ['gpt-live-transcribe', 'gpt-transcribe'])];
    const kept = syncDeadlines(
      { formatVersion: 1, deadlines: [picked] },
      DEPRECATION_SOURCES.openai,
      offered,
      '2026-10-22',
    );
    expect([kept.changed, kept.registry.deadlines]).toEqual([[], [picked]]);
    const withdrawn = syncDeadlines(
      { formatVersion: 1, deadlines: [picked] },
      DEPRECATION_SOURCES.openai,
      [row('2027-02-26', 'whisper-1', ['gpt-live-transcribe', 'gpt-realtime-2'])],
      '2026-10-22',
    );
    expect(withdrawn.changed).toEqual(['openai-2027-02-26-whisper-1']);
    expect(withdrawn.registry.deadlines[0].replacement).toBeNull();
    // A note may carry a required setting, so it never leaves a replacement in place.
    const noted = syncDeadlines(
      { formatVersion: 1, deadlines: [{ ...picked, replacement: 'gpt-live-transcribe' }] },
      DEPRECATION_SOURCES.openai,
      [row('2027-02-26', 'whisper-1', ['gpt-live-transcribe'], 'gpt-live-transcribe (beta)')],
      '2026-10-22',
    );
    expect(noted.registry.deadlines[0].replacement).toBeNull();
  });

  it('moves checkedAt on an unchanged entry only once it is stale', () => {
    const fresh = entry({
      id: 'openai-fresh',
      versions: ['gpt-4.1-nano'],
      replacement: 'gpt-5.6-luna',
      checkedAt: '2026-09-22',
    });
    const stale = entry({
      id: 'openai-stale',
      versions: ['o3-mini'],
      replacement: 'gpt-5.6-sol',
      checkedAt: '2026-09-21',
    });
    const sync = syncDeadlines(
      { formatVersion: 1, deadlines: [fresh, stale] },
      DEPRECATION_SOURCES.openai,
      [
        row('2026-10-23', 'gpt-4.1-nano', ['gpt-5.6-luna']),
        row('2026-10-23', 'o3-mini', ['gpt-5.6-sol']),
      ],
      '2026-10-22',
    );
    expect([sync.added, sync.changed, sync.rechecked]).toEqual([[], [], ['openai-stale']]);
    expect(sync.registry.deadlines).toEqual([fresh, { ...stale, checkedAt: '2026-10-22' }]);
  });

  it("touches only the source provider's model entries", () => {
    const sdk = entry({
      id: 'openai-old-sdk',
      kind: 'sdk',
      versions: ['gpt-4.1-nano'],
      date: '2025-01-01',
      checkedAt: '2026-01-01',
    });
    const anthropic = entry({
      id: 'anthropic-gpt-4.1-nano',
      provider: 'anthropic',
      versions: ['gpt-4.1-nano'],
      date: '2025-01-01',
      source: ANTHROPIC_DEPRECATIONS,
      checkedAt: '2026-01-01',
    });
    const sync = syncDeadlines(
      { formatVersion: 1, deadlines: [sdk, anthropic] },
      DEPRECATION_SOURCES.openai,
      [row('2026-10-23', 'gpt-4.1-nano', ['gpt-5.6-luna'])],
      '2026-10-22',
    );
    expect([sync.added, sync.changed, sync.rechecked, sync.missing]).toEqual([
      ['openai-2026-10-23-gpt-4-1-nano'],
      [],
      [],
      [],
    ]);
    expect(sync.registry.deadlines.slice(0, 2)).toEqual([sdk, anthropic]);
  });
});
