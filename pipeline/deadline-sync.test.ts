import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { checkDeadlineRegistry, type DeadlineRegistry } from './deadline-registry.ts';
import {
  ANTHROPIC_DEPRECATIONS,
  GEMINI_DEPRECATIONS,
  parseAnthropicDeprecations,
  parseGeminiDeprecations,
  syncAnthropicDeadlines,
  syncGeminiDeadlines,
} from './deadline-sync.ts';

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

it('reads the announcement tables and fails loudly on a row it does not recognize', () => {
  expect(parseAnthropicDeprecations(PAGE)).toEqual([
    { date: '2026-11-30', model: 'claude-sonnet-4-5-20250929', replacement: 'claude-sonnet-5-5' },
    { date: '2026-06-15', model: 'claude-sonnet-4-20250514', replacement: 'claude-sonnet-5-5' },
    { date: '2026-06-15', model: 'claude-opus-4-20250514', replacement: 'claude-opus-4-8' },
    { date: '2025-07-21', model: 'claude-2.0', replacement: 'claude-opus-4-8' },
    { date: '2025-07-21', model: 'claude-2.1', replacement: 'claude-opus-4-8' },
  ]);
  expect(() =>
    parseAnthropicDeprecations(
      PAGE.replace('June 15, 2026   | `claude-opus', 'Soon | `claude-opus'),
    ),
  ).toThrow(/Unrecognized row/);
  expect(() => parseAnthropicDeprecations('# Nothing here')).toThrow(/No deprecation table/);
});

it('adds new retirements, updates moved ones in place and keeps aliases, dates and order', () => {
  const kept = {
    id: 'anthropic-2026-11-30-claude-sonnet-4-5',
    provider: 'anthropic' as const,
    kind: 'model' as const,
    versions: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    date: '2026-11-30',
    summary: 'A summary a person wrote, naming the alias.',
    replacement: 'claude-sonnet-5-5',
    source: ANTHROPIC_DEPRECATIONS,
    checkedAt: '2026-10-20',
  };
  const registry: DeadlineRegistry = {
    formatVersion: 1,
    deadlines: [
      {
        id: 'openai-gpt-4',
        provider: 'openai',
        kind: 'model',
        versions: ['gpt-4'],
        date: '2026-10-23',
        summary: 'OpenAI shuts down gpt-4.',
        replacement: 'gpt-5.6-sol',
        source: 'https://developers.openai.com/api/docs/deprecations',
        checkedAt: '2026-10-15',
      },
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
  const sync = syncAnthropicDeadlines(registry, parseAnthropicDeprecations(PAGE), '2026-10-21');
  // In page order; the registry appends them by date.
  expect(sync.added).toEqual([
    'anthropic-2026-06-15-claude-sonnet-4',
    'anthropic-2025-07-21-claude-2',
  ]);
  expect(sync.changed).toEqual(['anthropic-2026-06-01-claude-opus-4']);
  expect(sync.missing).toEqual(['anthropic-2024-11-06-claude-1']);
  expect(sync.registry.deadlines.map((entry) => [entry.id, entry.date, entry.checkedAt])).toEqual([
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
    source: ANTHROPIC_DEPRECATIONS,
  });
  expect(checkDeadlineRegistry(sync.registry, new Date('2026-10-21T00:00:00Z')).errors).toEqual([]);
});

it('leaves the shipped registry unchanged against the page it was written from', async () => {
  const registry = JSON.parse(await readFile('data/deadlines.json', 'utf8')) as DeadlineRegistry;
  const anthropic = registry.deadlines.filter((entry) => entry.provider === 'anthropic');
  // Rebuild the page's rows from the shipped entries, as the page listed them on 2026-10-20.
  const rows = anthropic.flatMap((entry) =>
    entry.versions
      .filter((version) => version !== 'claude-sonnet-4-5')
      .map((model) => ({ date: entry.date, model, replacement: entry.replacement! })),
  );
  const sync = syncAnthropicDeadlines(registry, rows, '2026-10-21');
  expect([sync.added, sync.changed, sync.missing]).toEqual([[], [], []]);
  expect(sync.registry).toEqual(registry);
});

it('stops when the page splits one registry entry across retirement dates', () => {
  const registry: DeadlineRegistry = {
    formatVersion: 1,
    deadlines: [
      {
        id: 'anthropic-2025-07-21-claude-2.0',
        provider: 'anthropic',
        kind: 'model',
        versions: ['claude-2.0', 'claude-2.1'],
        date: '2025-07-21',
        summary: 'Claude 2.',
        replacement: 'claude-opus-4-8',
        source: ANTHROPIC_DEPRECATIONS,
        checkedAt: '2026-10-20',
      },
    ],
  };
  const page = PAGE.replace('| July 21, 2025   | `claude-2.1`', '| August 4, 2025  | `claude-2.1`');
  expect(page).not.toBe(PAGE);
  expect(() =>
    syncAnthropicDeadlines(registry, parseAnthropicDeprecations(page), '2026-10-21'),
  ).toThrow(
    "Anthropic's page splits registry entry anthropic-2025-07-21-claude-2.0 across retirement dates or replacements; update it by hand.",
  );
});

// The shape of Google's Gemini API deprecations page (read 2026-10-22): one HTML table per model
// family with a header row of cells, "Preview models" separator rows, and a managed agents table.
const GEMINI_PAGE = `<h2>Gemini 2.0 models</h2>
<table class="pricing-table"><thead><tr>
<td><b>Model</b></td><td><b>Release date</b></td><td><b>Shutdown date</b></td><td><b>Recommended replacement</b></td>
</tr></thead><tbody>
<tr><td><code translate="no">gemini-2.0-flash</code></td><td>February 5, 2025</td><td>June 1, 2026</td><td><code>gemini-3.6-flash</code></td></tr>
<tr><td><code>gemini-2.0-flash-001</code></td><td>February 5, 2025</td><td>June 1, 2026</td><td><code>gemini-3.6-flash</code></td></tr>
<tr><td><code>gemini-3.8-flash</code></td><td>September 2, 2026</td><td>No shutdown date announced</td><td></td></tr>
<tr><td><code>gemini-3.5-flash</code></td><td>May 19, 2026</td><td>N/A</td><td><code>gemini-3.6-flash</code> (routes automatically)</td></tr>
<tr><td colspan="4"><b>Preview models</b></td></tr>
<tr><td><code>gemini-2.5-flash-preview-tts</code></td><td>May 20, 2025</td><td>November 17, 2026</td><td><code>gemini-3.8-flash-tts</code> or <code>gemini-3.8-flash-lite-tts</code></td></tr>
</tbody></table>
<h2>Managed agents</h2>
<table><thead><tr><td>Agent</td><td>Release date</td><td>Shutdown date</td><td>Recommended replacement</td></tr></thead>
<tr><td>deep-research-pro-preview-12-2025</td><td>December 11, 2025</td><td>October 23, 2026</td><td>deep-research-preview-04-2026</td></tr></table>`;

it('reads the dated rows of the Gemini model tables and fails loudly on a row it does not recognize', () => {
  expect(parseGeminiDeprecations(GEMINI_PAGE)).toEqual([
    { date: '2026-06-01', model: 'gemini-2.0-flash', replacement: 'gemini-3.6-flash' },
    { date: '2026-06-01', model: 'gemini-2.0-flash-001', replacement: 'gemini-3.6-flash' },
    { date: '2026-11-17', model: 'gemini-2.5-flash-preview-tts', replacement: null },
  ]);
  expect(() =>
    parseGeminiDeprecations(
      GEMINI_PAGE.replace(
        'June 1, 2026</td><td><code>gemini-3.6',
        'Mid 2026</td><td><code>gemini-3.6',
      ),
    ),
  ).toThrow(
    "Unrecognized row in Google's Gemini deprecations table: gemini-2.0-flash | February 5, 2025 | Mid 2026 | gemini-3.6-flash",
  );
  expect(() => parseGeminiDeprecations('<p>moved</p>')).toThrow(/No dated shutdown/);
});

it('adds Gemini entries per date and replacement, leaving the SDK entry alone', () => {
  const sdk = {
    id: 'gemini-2025-11-30-google-generative-ai',
    provider: 'gemini' as const,
    kind: 'sdk' as const,
    versions: ['@google/generative-ai'],
    date: '2025-11-30',
    summary: 'Old SDK.',
    replacement: '@google/genai',
    source: 'https://github.com/google-gemini/deprecated-generative-ai-js/blob/main/README.md',
    checkedAt: '2026-10-21',
  };
  const sync = syncGeminiDeadlines(
    { formatVersion: 1, deadlines: [sdk] },
    parseGeminiDeprecations(GEMINI_PAGE),
    '2026-10-22',
  );
  expect([sync.added, sync.changed, sync.missing]).toEqual([
    ['gemini-2026-06-01-gemini-2-0-flash', 'gemini-2026-11-17-gemini-2-5-flash-preview-tts'],
    [],
    [],
  ]);
  expect(sync.registry.deadlines[0]).toBe(sdk);
  expect(sync.registry.deadlines[1]).toEqual({
    id: 'gemini-2026-06-01-gemini-2-0-flash',
    provider: 'gemini',
    kind: 'model',
    versions: ['gemini-2.0-flash', 'gemini-2.0-flash-001'],
    date: '2026-06-01',
    summary:
      'Google shuts down gemini-2.0-flash, gemini-2.0-flash-001 on the Gemini API no earlier than this date; requests to a shut-down model fail. The Vertex AI (Gemini Enterprise Agent Platform) dates differ.',
    replacement: 'gemini-3.6-flash',
    source: GEMINI_DEPRECATIONS,
    checkedAt: '2026-10-22',
  });
  expect(sync.registry.deadlines[2].replacement).toBeNull();
  expect(checkDeadlineRegistry(sync.registry, new Date('2026-10-22')).errors).toEqual([]);
  // A second read of the same page changes nothing.
  const again = syncGeminiDeadlines(
    sync.registry,
    parseGeminiDeprecations(GEMINI_PAGE),
    '2026-11-01',
  );
  expect([again.added, again.changed]).toEqual([[], []]);
});
