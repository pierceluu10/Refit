// Scores scans against F1's hand-written labels: inventory and finding precision and recall, duplicate
// rows, deadlines, and how much two runs differ.
// Usage: node inventory/evaluation/f1-score.ts <labels.json> <run dir> [<second run dir>]
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BehindItem, DependencyUsage } from '../../shared/types.ts';

export type LabelDependency = {
  id: string;
  kind: string;
  names: string[];
  class: 'required' | 'acceptable';
  files?: string[];
};
export type Clause = { deps?: string[]; kinds?: string[]; title?: string };
export type LabelFinding = {
  id: string;
  class: 'required' | 'acceptable';
  match: Clause[];
  deadline: string | null;
};
export type LabelRepo = {
  repo: string;
  commit: string;
  dependencies: LabelDependency[];
  transitive: string[];
  findings: LabelFinding[];
};
export type Labels = { repos: LabelRepo[] };
export type ScanResult = {
  repo: string;
  costUsd: number;
  // An inventory-only run (inventory/cli.ts --dependencies) has no findings to score.
  inventoryOnly?: boolean;
  dependencies: DependencyUsage[];
  report: { items: (BehindItem & { reason?: string })[]; errors: string[] };
};

const norm = (name: string) => name.trim().toLowerCase().replace(/[_.]/g, '-');
// 'node:18', 'actions/checkout@v2' and 'github/codeql-action/init' all start with an alias and a separator.
export function nameMatches(name: string, alias: string): boolean {
  const n = norm(name);
  const a = norm(alias);
  return n === a || [':', '@', '/', ' '].some((sep) => n.startsWith(a + sep));
}
const fileOf = (place: string) => place.split(':')[0];

function dependencyLabel(labels: LabelDependency[], dep: DependencyUsage) {
  return labels.find(
    (label) =>
      label.names.some((alias) => nameMatches(dep.name, alias)) ||
      (label.files !== undefined &&
        dep.kind === label.kind &&
        dep.declaredIn.some((place) => label.files!.includes(fileOf(place.file)))),
  );
}

export function scoreInventory(label: LabelRepo, deps: DependencyUsage[]) {
  const required = label.dependencies.filter((d) => d.class === 'required');
  const hit = new Set<string>();
  const extra: string[] = [];
  let correct = 0;
  let transitive = 0;
  for (const dep of deps) {
    const match = dependencyLabel(label.dependencies, dep);
    if (match) {
      correct++;
      if (match.class === 'required') hit.add(match.id);
    } else if (label.transitive.some((name) => norm(name) === norm(dep.name))) transitive++;
    else extra.push(`${dep.kind}:${dep.name}`);
  }
  const judged = correct + extra.length;
  return {
    required: required.length,
    found: hit.size,
    recall: required.length ? hit.size / required.length : 1,
    precision: judged ? correct / judged : 1,
    reported: deps.length,
    transitive,
    missed: required.filter((d) => !hit.has(d.id)).map((d) => d.id),
    extra,
  };
}

function clauseMatches(clause: Clause, item: BehindItem): boolean {
  const names = [item.change.dependency, item.dependency.name].filter(Boolean);
  if (clause.deps && !clause.deps.some((alias) => names.some((n) => nameMatches(n, alias))))
    return false;
  if (clause.kinds && !clause.kinds.includes(item.change.kind)) return false;
  if (clause.title && !new RegExp(clause.title, 'i').test(item.change.title)) return false;
  return true;
}

export const findingLabel = (labels: LabelFinding[], item: BehindItem) =>
  labels.find((label) => label.match.some((clause) => clauseMatches(clause, item)));

export function scoreFindings(label: LabelRepo, items: BehindItem[]) {
  const open = items.filter((item) => item.status !== 'not-affected');
  const required = label.findings.filter((f) => f.class === 'required');
  const rows = new Map<string, BehindItem[]>();
  const extra: string[] = [];
  for (const item of open) {
    const match = findingLabel(label.findings, item);
    if (match) rows.set(match.id, [...(rows.get(match.id) ?? []), item]);
    else extra.push(`${item.change.kind}:${item.change.dependency}: ${item.change.title}`);
  }
  const hits = required.filter((f) => rows.has(f.id));
  // A deadline is right when one of the label's rows carries the labeled date, or none when the label has none.
  const deadlines = hits.map((f) => {
    const dates = rows.get(f.id)!.map((item) => item.deadline ?? null);
    const verdict = dates.includes(f.deadline)
      ? 'right'
      : dates.every((d) => d === null)
        ? 'missing'
        : 'wrong';
    return { id: f.id, verdict, labeled: f.deadline, reported: [...new Set(dates)] };
  });
  const duplicates = [...rows.values()].reduce((sum, list) => sum + list.length - 1, 0);
  return {
    required: required.length,
    found: hits.length,
    recall: required.length ? hits.length / required.length : 1,
    precision: open.length ? (open.length - extra.length) / open.length : 1,
    open: open.length,
    notAffected: items.length - open.length,
    duplicates,
    deadlinesRight: deadlines.filter((d) => d.verdict === 'right').length,
    deadlines,
    missed: required.filter((f) => !rows.has(f.id)).map((f) => f.id),
    extra,
    hitIds: hits.map((f) => f.id),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export function scoreRun(labels: Labels, results: ScanResult[]) {
  return results.map((result) => {
    const label = labels.repos.find((r) => r.repo === result.repo);
    if (!label) throw new Error(`no labels for ${result.repo}`);
    return {
      repo: result.repo,
      costUsd: result.costUsd,
      errors: result.report.errors.length,
      inventoryOnly: result.inventoryOnly === true,
      inventory: scoreInventory(label, result.dependencies),
      findings: scoreFindings(label, result.inventoryOnly ? [] : result.report.items),
      depNames: new Set(result.dependencies.map((d) => norm(d.name))),
    };
  });
}

function totals(scores: ReturnType<typeof scoreRun>) {
  const sum = (f: (s: (typeof scores)[number]) => number) => scores.reduce((a, s) => a + f(s), 0);
  const scanned = scores.filter((s) => !s.inventoryOnly);
  const fsum = (f: (s: (typeof scores)[number]) => number) => scanned.reduce((a, s) => a + f(s), 0);
  const invJudged = sum((s) => s.inventory.reported - s.inventory.transitive);
  const invCorrect = sum(
    (s) => s.inventory.reported - s.inventory.transitive - s.inventory.extra.length,
  );
  return {
    costUsd: sum((s) => s.costUsd),
    errors: sum((s) => s.errors),
    invRecall: sum((s) => s.inventory.found) / sum((s) => s.inventory.required),
    invPrecision: invJudged ? invCorrect / invJudged : 1,
    findRecall:
      fsum((s) => s.findings.found) /
      Math.max(
        fsum((s) => s.findings.required),
        1,
      ),
    findPrecision:
      fsum((s) => s.findings.open - s.findings.extra.length) /
      Math.max(
        fsum((s) => s.findings.open),
        1,
      ),
    open: fsum((s) => s.findings.open),
    duplicates: fsum((s) => s.findings.duplicates),
    deadlinesRight: fsum((s) => s.findings.deadlinesRight),
    found: fsum((s) => s.findings.found),
    required: fsum((s) => s.findings.required),
  };
}

export function formatScores(scores: ReturnType<typeof scoreRun>): string {
  const t = totals(scores);
  return [
    '| repo | cost | inventory recall | inventory precision | finding recall | finding precision | open rows | duplicates | deadlines right | errors |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...scores.map((s) =>
      s.inventoryOnly
        ? `| ${s.repo} (inventory only) | $${s.costUsd.toFixed(2)} | ${s.inventory.found}/${s.inventory.required} | ${pct(s.inventory.precision)} | - | - | - | - | - | ${s.errors} |`
        : `| ${s.repo} | $${s.costUsd.toFixed(2)} | ${s.inventory.found}/${s.inventory.required} | ${pct(s.inventory.precision)} | ${s.findings.found}/${s.findings.required} | ${pct(s.findings.precision)} | ${s.findings.open} | ${s.findings.duplicates} | ${s.findings.deadlinesRight}/${s.findings.found} | ${s.errors} |`,
    ),
    `| **all** | $${t.costUsd.toFixed(2)} | ${pct(t.invRecall)} | ${pct(t.invPrecision)} | ${t.found}/${t.required} = ${pct(t.findRecall)} | ${pct(t.findPrecision)} | ${t.open} | ${t.duplicates} | ${t.deadlinesRight}/${t.found} | ${t.errors} |`,
  ].join('\n');
}

// How much two runs on the same repos differ: dependency names and required findings found by only one.
export function compareRuns(
  a: ReturnType<typeof scoreRun>,
  b: ReturnType<typeof scoreRun>,
): string {
  const lines = [
    '| repo | dependency names in both / either | required findings only in run 1 | only in run 2 |',
    '| --- | --- | --- | --- |',
  ];
  for (const sa of a) {
    const sb = b.find((s) => s.repo === sa.repo);
    if (!sb) continue;
    const both = [...sa.depNames].filter((n) => sb.depNames.has(n)).length;
    const either = new Set([...sa.depNames, ...sb.depNames]).size;
    const onlyA = sa.findings.hitIds.filter((id) => !sb.findings.hitIds.includes(id));
    const onlyB = sb.findings.hitIds.filter((id) => !sa.findings.hitIds.includes(id));
    lines.push(
      `| ${sa.repo} | ${both}/${either} | ${onlyA.join(', ') || '-'} | ${onlyB.join(', ') || '-'} |`,
    );
  }
  return lines.join('\n');
}

export function formatDetails(scores: ReturnType<typeof scoreRun>): string {
  return scores
    .map((s) =>
      [
        `### ${s.repo}`,
        `- inventory missed: ${s.inventory.missed.join(', ') || 'none'}`,
        `- inventory not in labels: ${s.inventory.extra.join(', ') || 'none'}`,
        `- findings missed: ${s.findings.missed.join(', ') || 'none'}`,
        `- findings not in labels: ${s.findings.extra.join(' | ') || 'none'}`,
        `- deadlines: ${s.findings.deadlines.map((d) => `${d.id} ${d.verdict} (labeled ${d.labeled ?? 'none'}, reported ${d.reported.join('/') || 'none'})`).join('; ') || 'none'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

async function loadRun(labels: Labels, dir: string): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const { repo } of labels.repos) {
    const text = await readFile(join(dir, `${repo.replace('/', '__')}.json`), 'utf8').catch(
      () => undefined,
    );
    if (text) results.push(JSON.parse(text) as ScanResult);
  }
  return results;
}

if (import.meta.main) {
  const [labelsPath, runA, runB] = process.argv.slice(2);
  const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as Labels;
  const a = scoreRun(labels, await loadRun(labels, runA));
  console.log(`## ${runA}\n\n${formatScores(a)}\n\n${formatDetails(a)}`);
  if (runB) {
    const b = scoreRun(labels, await loadRun(labels, runB));
    console.log(
      `\n## ${runB}\n\n${formatScores(b)}\n\n${formatDetails(b)}\n\n## Run to run\n\n${compareRuns(a, b)}`,
    );
  }
}
