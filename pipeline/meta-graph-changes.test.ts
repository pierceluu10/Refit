import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import {
  CHANGE_KINDS,
  checkMetaGraphChanges,
  compareVersions,
  DEFAULT_META_GRAPH_CHANGES,
  loadMetaGraphChanges,
  type MetaGraphChange,
  type MetaGraphVersion,
} from './meta-graph-changes.ts';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/refit.mjs', import.meta.url));
const NOW = new Date('2026-10-20T12:00:00Z');
const SOURCE = 'https://developers.facebook.com/docs/graph-api/changelog/version21.0';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function version(overrides: Partial<MetaGraphVersion> = {}): MetaGraphVersion {
  return {
    version: 'v21.0',
    released: '2024-10-02',
    status: 'reviewed',
    source: SOURCE,
    checkedAt: '2026-10-20',
    note: null,
    ...overrides,
  };
}

function change(overrides: Partial<MetaGraphChange> = {}): MetaGraphChange {
  return {
    id: 'meta-graph-v21-0-page-field',
    version: 'v21.0',
    kind: 'field-removed',
    node: 'Page',
    edge: null,
    path: null,
    name: 'old_field',
    replacement: null,
    appliesToAll: null,
    summary: 'Page.old_field is removed.',
    quote: 'The old_field field on Page is removed.',
    source: `${SOURCE}#pages`,
    checkedAt: '2026-10-20',
    ...overrides,
  };
}

function list(versions: unknown[], changes: unknown[] = []) {
  return { formatVersion: 1, provider: 'meta-graph', versions, changes };
}

describe('the committed change list', () => {
  it('is valid, covers every Meta version in the deadline registry and lists no change unread', async () => {
    const read = new Date('2026-10-29T12:00:00Z');
    const value = JSON.parse(await readFile(DEFAULT_META_GRAPH_CHANGES, 'utf8'));
    const registry = await loadDeadlineRegistry(undefined, read);
    const registryVersions = registry.deadlines
      .filter((entry) => entry.provider === 'meta-graph')
      .flatMap((entry) => entry.versions);
    const report = checkMetaGraphChanges(value, read, registryVersions);
    expect(report.errors).toEqual([]);
    expect(report.missing).toEqual([]);
    // v10.0, the oldest version benchmark repositories pin, to v26.0 were read in full.
    expect(report.unread).toEqual([]);
    expect(value.versions.map((entry: { version: string }) => entry.version)).toEqual(
      Array.from({ length: 17 }, (_, index) => `v${10 + index}.0`),
    );
    for (const entry of value.versions)
      expect(entry.note).toMatch(/^Read in full on \d{4}-\d{2}-\d{2}/);
    expect(value.changes.length).toBeGreaterThan(500);
    for (const entry of value.changes) {
      expect(entry.source).toMatch(/^https:\/\/developers\.facebook\.com\/(docs|documentation)\//);
      expect(entry.quote.length).toBeGreaterThan(0);
    }
    // Platform changelogs and out-of-cycle changes are covered too.
    expect(
      value.changes.some((entry: { source: string }) => entry.source.includes('whatsapp')),
    ).toBe(true);
    expect(value.changes.some((entry: { version: string | null }) => entry.version === null)).toBe(
      true,
    );
    expect(await loadMetaGraphChanges(DEFAULT_META_GRAPH_CHANGES, read)).toMatchObject({
      provider: 'meta-graph',
    });
  });
});

describe('checkMetaGraphChanges', () => {
  it('accepts a reviewed version with one change of each kind', () => {
    const changes = CHANGE_KINDS.map((kind, index) =>
      change({
        id: `change-${index}`,
        kind,
        edge: /^(edge|endpoint)-/.test(kind) ? 'feed' : null,
        path: kind.startsWith('endpoint-') ? '/instagram_oembed' : null,
        name: /^(field|metric|parameter|breakdown|webhook|error|permission|product)-/.test(kind)
          ? 'name'
          : null,
      }),
    );
    expect(checkMetaGraphChanges(list([version()], changes), NOW)).toEqual({
      errors: [],
      unread: [],
      missing: [],
    });
  });

  it('rejects a change from a page nobody read, or from a version with no record', () => {
    const report = checkMetaGraphChanges(
      list(
        [version({ status: 'unread', note: 'Could not be read.' })],
        [change(), change({ id: 'other', version: 'v22.0' })],
      ),
      NOW,
    );
    expect(report.errors).toEqual([
      'meta-graph-v21-0-page-field: v21.0 is not reviewed, so it cannot list changes.',
      'other: v22.0 has no record in versions.',
    ]);
    expect(report.unread).toEqual(['v21.0']);
  });

  it('accepts only Meta developer documentation as a source', () => {
    const report = checkMetaGraphChanges(
      list(
        [version({ source: 'https://example.com/changelog' })],
        [change({ source: 'http://developers.facebook.com/docs/graph-api/changelog' })],
      ),
      NOW,
    );
    expect(report.errors).toEqual([
      'v21.0: source must be a developers.facebook.com https URL.',
      'meta-graph-v21-0-page-field: source must be a developers.facebook.com https URL.',
    ]);
  });

  it('requires what each kind of change names', () => {
    const report = checkMetaGraphChanges(
      list(
        [version()],
        [
          change({ id: 'a', kind: 'metric-removed', name: null }),
          change({ id: 'b', kind: 'edge-changed', name: null }),
          change({ id: 'c', kind: 'endpoint-removed', name: null }),
          change({ id: 'd', kind: 'parameter-changed', name: '' }),
          change({ id: 'e', kind: 'edge-removed', edge: 'feed', path: 'feed' }),
          change({ id: 'f', kind: 'renamed' as never }),
        ],
      ),
      NOW,
    );
    expect(report.errors).toEqual([
      'a: a metric-removed change needs the metric name.',
      'b: an edge change needs edge.',
      'c: an endpoint change needs a path or an edge.',
      'd: name must be text or null.',
      'd: a parameter-changed change needs the parameter name.',
      'e: path must start with / and hold only path characters.',
      `f: kind must be one of ${CHANGE_KINDS.join(', ')}.`,
    ]);
  });

  it('rejects unknown and missing fields, duplicates, bad dates and unexplained unread pages', () => {
    const { node: _node, ...withoutNode } = change({ id: 'no-node' });
    const report = checkMetaGraphChanges(
      {
        ...list(
          [
            version(),
            version(),
            version({ version: '21', checkedAt: '2026-02-30' }),
            version({ version: 'v22.0', status: 'unread', note: null, checkedAt: '2026-10-21' }),
            { ...version({ version: 'v23.0' }), extra: true },
          ],
          [
            change(),
            change(),
            withoutNode,
            change({ id: 'Bad ID', summary: ' ', checkedAt: '2026-1-1' }),
          ],
        ),
        comment: 'x',
      },
      NOW,
    );
    expect(report.errors).toEqual([
      'unknown top-level fields comment.',
      'v21.0: listed twice.',
      '21: version must look like v19.0.',
      '21: checkedAt must be a real YYYY-MM-DD date.',
      'v22.0: checkedAt 2026-10-21 is in the future.',
      'v22.0: an unread version needs a note saying why.',
      'v23.0: unknown fields extra.',
      'meta-graph-v21-0-page-field: duplicate id.',
      'no-node: missing fields node.',
      'Bad ID: id must be lowercase letters, digits and hyphens.',
      'Bad ID: summary is required.',
      'Bad ID: checkedAt must be a real YYYY-MM-DD date.',
    ]);
  });

  it('rejects a document of the wrong shape or provider', () => {
    for (const value of [null, [], { formatVersion: 2 }, { ...list([]), provider: 'shopify' }])
      expect(checkMetaGraphChanges(value, NOW).errors).toEqual([
        'The change list requires formatVersion: 1, provider: "meta-graph", and versions and changes arrays.',
      ]);
  });

  it('reports deadline registry versions the list does not cover, in version order', () => {
    const report = checkMetaGraphChanges(list([version()]), NOW, ['v9.0', 'v21.0', 'v13.0']);
    expect(report.missing).toEqual(['v9.0', 'v13.0']);
  });
});

it('orders versions numerically', () => {
  expect(['v13.0', 'v9.0', 'v21.0', 'v13.1'].sort(compareVersions)).toEqual([
    'v9.0',
    'v13.0',
    'v13.1',
    'v21.0',
  ]);
});

it('refuses to load a list with any error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-changes-'));
  roots.push(root);
  const path = join(root, 'changes.json');
  await writeFile(path, JSON.stringify(list([version({ status: 'unread', note: null })])));
  await expect(loadMetaGraphChanges(path, NOW)).rejects.toThrow(
    'Meta Graph API change list is invalid: v21.0: an unread version needs a note saying why.',
  );
});

it('checks the list from the CLI and exits 1 on an invalid file', async () => {
  const valid = await execute(process.execPath, [CLI, 'meta-graph', '--check-changes']);
  expect(valid.stdout).toContain('Meta Graph API change list is valid');
  const root = await mkdtemp(join(tmpdir(), 'refit-meta-graph-changes-'));
  roots.push(root);
  const path = join(root, 'changes.json');
  await writeFile(path, JSON.stringify(list([version()], [change({ version: 'v30.0' })])));
  const invalid = await execute(process.execPath, [
    CLI,
    'meta-graph',
    '--check-changes',
    '--changes',
    path,
    '--json',
  ]).catch((error: { code: number; stdout: string }) => error);
  expect(invalid).toMatchObject({ code: 1 });
  const report = JSON.parse(invalid.stdout);
  expect(report.errors).toEqual(['meta-graph-v21-0-page-field: v30.0 has no record in versions.']);
  // The registry's Meta versions v13.0 to v25.0 have no record in this small file.
  expect(report.missing).toContain('v13.0');
}, 60_000);
