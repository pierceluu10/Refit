import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BehindItem, DependencyUsage } from '../../shared/types.ts';
import {
  nameMatches,
  scoreFindings,
  scoreInventory,
  type LabelRepo,
  type Labels,
} from './f1-score.ts';

const label: LabelRepo = {
  repo: 'o/r',
  commit: 'abc',
  dependencies: [
    { id: 'node', kind: 'runtime', names: ['node'], class: 'required' },
    { id: 'checkout', kind: 'ci', names: ['actions/checkout'], class: 'required' },
    {
      id: 'pay',
      kind: 'regulated-surface',
      names: [],
      class: 'required',
      files: ['pages/checkout.js'],
    },
    { id: 'acceptable', kind: 'any', names: ['jest'], class: 'acceptable' },
  ],
  transitive: ['ms'],
  findings: [
    { id: 'node-eol', class: 'required', match: [{ deps: ['node'] }], deadline: '2025-04-30' },
    { id: 'werk', class: 'required', match: [{ deps: ['werkzeug'] }], deadline: null },
    {
      id: 'rule',
      class: 'required',
      match: [{ kinds: ['regulation'], title: 'cookie' }],
      deadline: null,
    },
  ],
};
const dep = (name: string, kind = 'library', file = 'package.json') =>
  ({ repo: 'o/r', kind, name, declaredIn: [{ file }] }) as DependencyUsage;
const row = (dependency: string, kind: string, title: string, deadline?: string, status = 'open') =>
  ({
    repo: 'o/r',
    dependency: dep(dependency),
    change: { dependency, kind, title },
    deadline,
    status,
  }) as unknown as BehindItem;

describe('F1 scoring', () => {
  it('matches aliases with a version or path after them', () => {
    expect(nameMatches('node:18', 'node')).toBe(true);
    expect(nameMatches('actions/checkout@v2', 'actions/checkout')).toBe(true);
    expect(nameMatches('nodemon', 'node')).toBe(false);
    expect(nameMatches('typing_inspect', 'typing-inspect')).toBe(true);
  });

  it('counts required hits, surfaces by file, transitive names and extras', () => {
    const score = scoreInventory(label, [
      dep('node', 'runtime'),
      dep('node:18', 'container-image'),
      dep('payment page', 'regulated-surface', 'pages/checkout.js'),
      dep('jest'),
      dep('ms'),
      dep('left-pad'),
    ]);
    expect(score).toMatchObject({
      required: 3,
      found: 2,
      transitive: 1,
      missed: ['checkout'],
      extra: ['library:left-pad'],
    });
    expect(score.precision).toBeCloseTo(4 / 5);
  });

  it('scores findings, duplicates and deadlines, and ignores not-affected rows', () => {
    const score = scoreFindings(label, [
      row('node', 'runtime-eol', 'Node 18 EOL', '2025-04-30'),
      row('node:18', 'container-image-eol', 'node:18 image EOL', '2025-04-30'),
      row('werkzeug', 'dependency-major', 'Werkzeug 3', '2023-09-30'),
      row('cookies', 'regulation', 'Cookie consent before tracking'),
      row('stripe', 'sdk-major', 'stripe 12'),
      row('express', 'security-fix', 'not here', undefined, 'not-affected'),
    ]);
    expect(score).toMatchObject({
      found: 3,
      open: 5,
      notAffected: 1,
      duplicates: 1,
      deadlinesRight: 2,
    });
    expect(score.precision).toBeCloseTo(4 / 5);
    expect(score.deadlines.find((d) => d.id === 'werk')?.verdict).toBe('wrong');
  });

  it('every committed label has a source or note and a known class', () => {
    const labels = JSON.parse(
      readFileSync(new URL('./labels/f1-labels.json', import.meta.url), 'utf8'),
    ) as Labels & { repos: (LabelRepo & { findings: { source?: unknown; note?: string }[] })[] };
    expect(labels.repos).toHaveLength(8);
    for (const repo of labels.repos) {
      for (const finding of repo.findings) {
        expect(['required', 'acceptable']).toContain(finding.class);
        if (finding.class === 'required') expect(finding.source ?? finding.note).toBeTruthy();
      }
    }
  });
});
