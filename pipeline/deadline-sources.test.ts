import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadDeadlineRegistry, type DeadlineRegistry } from './deadline-registry.ts';
import { checkSources, loadSourcePages, type SourceIndex } from './deadline-sources.ts';
import { DEPRECATION_SOURCES } from './deadline-sync.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const NOW = new Date('2026-10-29T00:00:00Z');

const OPENAI_PAGE = [
  '## Upcoming deprecations',
  '',
  '### 2026-06-11: GPT-5 and o3 model deprecations',
  '',
  '| Shutdown date | Model / system | Recommended replacement |',
  '| ------------- | -------------- | ----------------------- |',
  '| Dec 11, 2026  | `gpt-5` \\| `gpt-5-2025-08-07` | `gpt-5.6-sol` |',
  '| Jan 6, 2027   | `tts-1` | `gpt-realtime-2.1-mini` or `gpt-audio-1.5` |',
  '',
].join('\n');

function fixture(openai = OPENAI_PAGE) {
  const pages = { openai, anthropic: '', gemini: '' };
  const index: SourceIndex = {
    formatVersion: 1,
    pages: (['openai', 'anthropic', 'gemini'] as const).map((provider) => ({
      provider,
      url: DEPRECATION_SOURCES[provider].download,
      fetchedAt: '2026-10-29',
      sha256: sha(pages[provider]),
    })),
  };
  return { pages, index };
}

const entry = (versions: string[], date: string, replacement: string | null) => ({
  id: `openai-${date}-${versions[0]}`,
  provider: 'openai' as const,
  kind: 'model' as const,
  versions,
  date,
  summary: `OpenAI shuts down ${versions.join(', ')} on the API; requests to a shut-down model fail.`,
  replacement,
  source: DEPRECATION_SOURCES.openai.page,
  checkedAt: '2026-10-29',
});

describe('checkSources', () => {
  it('quotes the table row behind every replaced model', () => {
    const { pages, index } = fixture();
    const registry: DeadlineRegistry = {
      formatVersion: 1,
      deadlines: [entry(['gpt-5', 'gpt-5-2025-08-07'], '2026-12-11', 'gpt-5.6-sol')],
    };
    const report = checkSources(registry, index, pages, NOW, ['openai']);
    // The tts row has no entry yet, so the page does not reproduce the registry.
    expect(report.errors).toEqual([
      expect.stringContaining('does not reproduce registry entry openai-2027-01-06-tts-1'),
    ]);
    expect(report.evidence[0].quotes['gpt-5']).toContain('`gpt-5.6-sol`');
    expect(report.evidence[0].chosenAmong).toBeNull();
  });

  it('records a replacement a person chose among several', () => {
    const { pages, index } = fixture();
    const registry: DeadlineRegistry = {
      formatVersion: 1,
      deadlines: [
        entry(['gpt-5', 'gpt-5-2025-08-07'], '2026-12-11', 'gpt-5.6-sol'),
        entry(['tts-1'], '2027-01-06', 'gpt-audio-1.5'),
      ],
    };
    const report = checkSources(registry, index, pages, NOW, ['openai']);
    expect(report.errors).toEqual([]);
    expect(report.evidence[1].chosenAmong).toEqual(['gpt-realtime-2.1-mini', 'gpt-audio-1.5']);
  });

  it('fails a replacement the page never names for that model', () => {
    const { pages, index } = fixture();
    const registry: DeadlineRegistry = {
      formatVersion: 1,
      deadlines: [
        entry(['gpt-5', 'gpt-5-2025-08-07'], '2026-12-11', 'gpt-6-sol'),
        entry(['tts-1'], '2027-01-06', 'gpt-audio-1.5'),
      ],
    };
    const report = checkSources(registry, index, pages, NOW, ['openai']);
    expect(report.errors.join('\n')).toContain('no table row on the saved OpenAI page names gpt-5');
  });

  it('rejects a saved page edited after it was hashed', () => {
    const { pages, index } = fixture();
    const report = checkSources(
      { formatVersion: 1, deadlines: [] },
      index,
      { ...pages, openai: `${pages.openai}\n| edited |` },
      NOW,
      ['openai'],
    );
    expect(report.errors[0]).toBe('OpenAI: the saved page does not match its recorded SHA-256.');
  });

  it('accepts an undated alias only beside the dated snapshot a row proves', () => {
    const { pages, index } = fixture();
    const alias = {
      ...entry(['gpt-5', 'gpt-5-2025-08-07', 'gpt-5-20250807'], '2026-12-11', 'gpt-5.6-sol'),
    };
    const report = checkSources(
      {
        formatVersion: 1,
        deadlines: [alias, entry(['tts-1'], '2027-01-06', 'gpt-audio-1.5')],
      },
      index,
      pages,
      NOW,
      ['openai'],
    );
    // `gpt-5-20250807` is not on the page and has no undated form of its own: it fails.
    expect(report.errors.join('\n')).toContain('names gpt-5-20250807');
  });

  it('warns once a saved page is older than 30 days', () => {
    const { pages, index } = fixture();
    const report = checkSources(
      { formatVersion: 1, deadlines: [] },
      index,
      pages,
      new Date('2026-12-15T00:00:00Z'),
      ['openai'],
    );
    expect(report.warnings).toContain('OpenAI: the saved page is from 2026-10-29; sync it again.');
  });
});

it('reproduces every shipped AI model entry from the saved deprecation pages', async () => {
  const registry = await loadDeadlineRegistry(undefined, NOW);
  const { index, pages, changelogs } = await loadSourcePages();
  const report = checkSources(registry, index, pages, NOW, undefined, changelogs);
  expect(report.errors).toEqual([]);
  expect(report.evidence.length).toBeGreaterThan(80);
});

describe('shutdowns cited from a changelog', () => {
  const changelog = [
    '## September 29, 2025',
    '',
    '- The following Gemini 1.5 models are now shut down:',
    '  - `gemini-1.5-pro`',
    '  - `gemini-1.5-flash`',
    '',
  ].join('\n');
  // A deprecations page with one row, which the registry below already has.
  const page = [
    '| **Model** | **Release date** | **Shutdown date** | **Recommended replacement** |',
    '| --- | --- | --- | --- |',
    '| `gemini-2.0-flash` | February 5, 2025 | June 1, 2026 | `gemini-3.6-flash` |',
    '',
  ].join('\n');
  const index: SourceIndex = {
    formatVersion: 1,
    pages: [
      {
        provider: 'gemini',
        url: DEPRECATION_SOURCES.gemini.download,
        fetchedAt: '2026-10-29',
        sha256: sha(page),
      },
      {
        provider: 'gemini',
        role: 'changelog',
        url: 'https://ai.google.dev/gemini-api/docs/changelog.md.txt',
        fetchedAt: '2026-10-29',
        sha256: sha(changelog),
      },
    ],
  };
  const run = (versions: string[], replacement: string | null) =>
    checkSources(
      {
        formatVersion: 1,
        deadlines: [
          {
            id: 'gemini-2025-09-29-gemini-1-5',
            provider: 'gemini',
            kind: 'model',
            versions,
            date: '2025-09-29',
            summary: 'Shut down.',
            replacement,
            source: 'https://ai.google.dev/gemini-api/docs/changelog',
            checkedAt: '2026-10-29',
          },
          {
            id: 'gemini-2026-06-01-gemini-2-0-flash',
            provider: 'gemini',
            kind: 'model',
            versions: ['gemini-2.0-flash'],
            date: '2026-06-01',
            summary: 'Shut down.',
            replacement: 'gemini-3.6-flash',
            source: DEPRECATION_SOURCES.gemini.page,
            checkedAt: '2026-10-29',
          },
        ],
      },
      index,
      { gemini: page },
      NOW,
      ['gemini'],
      { gemini: changelog },
    );

  it('quotes the shutdown line for each listed model', () => {
    const report = run(['gemini-1.5-pro', 'gemini-1.5-flash'], null);
    expect(report.errors).toEqual([]);
    expect(
      report.evidence.find((item) => item.id.includes('1-5'))!.quotes['gemini-1.5-flash'],
    ).toBe('- The following Gemini 1.5 models are now shut down:');
  });

  it('rejects a replacement the changelog never names, and a model it does not list', () => {
    expect(run(['gemini-1.5-pro'], 'gemini-3.6-flash').errors).toEqual([
      'gemini-2025-09-29-gemini-1-5: a changelog names no replacement, so the entry must not.',
    ]);
    expect(run(['gemini-1.0-pro'], null).errors).toEqual([
      'gemini-2025-09-29-gemini-1-5: the saved gemini changelog does not list gemini-1.0-pro as shut down.',
    ]);
  });
});
