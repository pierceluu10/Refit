// Stand-ins for the orchestrator and its agents in the MVP smoke test. They exist to drive memory, the
// reviewer and scoring end to end with $0 spent; they don't model how the real agents decide anything. Nothing in a fixture
// runs: the fakes only read files and edit a temporary copy.
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type {
  BehindItem,
  DependencyUsage,
  ExternalChange,
  ExternalTask,
  RunRecord,
  RunRepoJob,
  ScanRepo,
} from '../../shared/types.ts';

/** Simulated cost per call, so cost accounting has numbers to add up. No real money moves. */
export const MVP_SIMULATED_COST_USD = { scan: 0.004, task: 0.01 };

const example = (url: string) => ({ url, quote: 'Example quote for the smoke test.' });

/**
 * Illustrative changes the fake watcher reports, keyed by dependency name. Example data for the
 * smoke test, not real watcher output; the dates and targets are placeholders.
 */
export const FAKE_EXTERNAL_CHANGES: ExternalChange[] = [
  {
    provider: 'nodejs',
    id: 'example-node-18-eol',
    kind: 'runtime-eol',
    dependencyKind: 'runtime',
    dependency: 'node',
    title: 'Example: Node.js 18 is end of life',
    effectiveDate: '2025-04-30',
    fromVersions: ['18'],
    toVersion: '22',
    severity: 'deadline',
    source: example('https://nodejs.org/en/about/previous-releases'),
    affects: { versions: ['18'] },
  },
  {
    provider: 'python',
    id: 'example-python-3.9-eol',
    kind: 'runtime-eol',
    dependencyKind: 'runtime',
    dependency: 'python',
    title: 'Example: Python 3.9 is end of life',
    effectiveDate: '2025-10-31',
    fromVersions: ['3.9'],
    toVersion: '3.13',
    severity: 'deadline',
    source: example('https://devguide.python.org/versions/'),
    affects: { versions: ['3.9'] },
  },
  {
    provider: 'openai',
    id: 'example-gpt-3.5-turbo-0613-retired',
    kind: 'model-retirement',
    dependencyKind: 'ai-model',
    dependency: 'gpt-3.5-turbo-0613',
    title: 'Example: gpt-3.5-turbo-0613 is retired',
    effectiveDate: '2024-09-13',
    toVersion: 'gpt-4.1-mini',
    severity: 'deadline',
    source: example('https://platform.openai.com/docs/deprecations'),
    affects: { operations: ['chat.completions.create'] },
  },
  {
    provider: 'github-actions',
    id: 'example-actions-checkout-v2',
    kind: 'ci-deprecation',
    dependencyKind: 'ci',
    dependency: 'actions/checkout',
    title: 'Example: actions/checkout@v2 runs on a retired Node runtime',
    fromVersions: ['v2'],
    toVersion: 'v4',
    severity: 'notice',
    source: example('https://github.blog/changelog/'),
    affects: { versions: ['v2'] },
  },
  {
    provider: 'nextjs',
    id: 'example-next-12-major',
    kind: 'framework-major',
    dependencyKind: 'framework',
    dependency: 'next',
    title: 'Example: Next.js 12 is no longer supported',
    fromVersions: ['12'],
    toVersion: '15',
    severity: 'breaking',
    source: example('https://nextjs.org/docs/app/guides/upgrading'),
    affects: { versions: ['12'] },
  },
  {
    provider: 'kubernetes',
    id: 'example-ingress-extensions-v1beta1',
    kind: 'k8s-version',
    dependencyKind: 'infrastructure',
    dependency: 'extensions/v1beta1',
    title: 'Example: Ingress in extensions/v1beta1 is removed',
    toVersion: 'networking.k8s.io/v1',
    severity: 'breaking',
    source: example('https://kubernetes.io/docs/reference/using-api/deprecation-guide/'),
    affects: {},
  },
  {
    provider: 'aws-lambda',
    id: 'example-lambda-nodejs16',
    kind: 'serverless-runtime',
    dependencyKind: 'infrastructure',
    dependency: 'nodejs16.x',
    title: 'Example: the nodejs16.x Lambda runtime is deprecated',
    toVersion: 'nodejs22.x',
    severity: 'deadline',
    source: example('https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html'),
    affects: {},
  },
  // Judged not affected by the fake match: the repo is already past the versions it names.
  {
    provider: 'flask',
    id: 'example-flask-1-advisory',
    kind: 'security-fix',
    dependencyKind: 'framework',
    dependency: 'flask',
    title: 'Example: advisory for Flask 1.x',
    fromVersions: ['1'],
    toVersion: '2.3',
    severity: 'security',
    source: example('https://osv.dev/'),
    affects: { versions: ['1'] },
  },
];

type Found = Omit<DependencyUsage, 'repo' | 'declaredIn'> & {
  declaredIn: { file: string; line: number; text: string }[];
};

function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesIn(full) : [full];
  });
}

/**
 * A fake inventory: a few line patterns over the fixture's files. The real inventory is an agent
 * (P2); this only gives the smoke run dependencies to match.
 */
export function fakeInventory(dir: string, repo: string): DependencyUsage[] {
  const found = new Map<string, Found>();
  const add = (dep: Omit<Found, 'declaredIn'>, file: string, line: number, text: string) => {
    const entry = found.get(dep.name) ?? { ...dep, declaredIn: [] };
    entry.declaredIn.push({ file, line, text: text.trim() });
    found.set(dep.name, entry);
  };
  const patterns: [RegExp, (m: RegExpMatchArray) => Omit<Found, 'declaredIn'>][] = [
    [/"node":\s*">=(\d+)/, (m) => ({ kind: 'runtime', name: 'node', version: m[1] })],
    [/^FROM node:(\d+)/, (m) => ({ kind: 'runtime', name: 'node', version: m[1] })],
    [
      /requires-python = ">=(\d+\.\d+)/,
      (m) => ({ kind: 'runtime', name: 'python', version: m[1] }),
    ],
    [
      /"next":\s*"(\d+)[\d.]*"/,
      (m) => ({ kind: 'framework', name: 'next', version: m[1], ecosystem: 'npm' }),
    ],
    [
      /"flask==([\d.]+)"/,
      (m) => ({ kind: 'framework', name: 'flask', version: m[1], ecosystem: 'pypi' }),
    ],
    [
      /uses: (actions\/checkout)@(v\d+)/,
      (m) => ({ kind: 'ci', name: m[1], version: m[2], ecosystem: 'github-actions' }),
    ],
    [/model: '([\w.-]+)'/, (m) => ({ kind: 'ai-model', name: m[1], ecosystem: 'openai' })],
    [/^apiVersion: (extensions\/v1beta1)/, (m) => ({ kind: 'infrastructure', name: m[1] })],
    [/runtime: (nodejs\d+\.x)/, (m) => ({ kind: 'infrastructure', name: m[1] })],
  ];
  for (const path of filesIn(dir)) {
    const file = relative(dir, path);
    if (file === 'README.md') continue;
    const text = readFileSync(path, 'utf8');
    // Whole-file version files: .nvmrc, .python-version.
    if (file === '.nvmrc')
      add({ kind: 'runtime', name: 'node', version: text.trim() }, file, 1, text);
    if (file === '.python-version')
      add({ kind: 'runtime', name: 'python', version: text.trim() }, file, 1, text);
    text.split('\n').forEach((line, index) => {
      for (const [pattern, toDep] of patterns) {
        const match = line.match(pattern);
        if (match) add(toDep(match), file, index + 1, line);
      }
    });
  }
  return [...found.values()].map((dep) => ({ repo, ...dep }));
}

const major = (version?: string) => version?.match(/^v?(\d+(?:\.\d+)?)/)?.[1];

/** A fake match: a change applies when it names the dependency and, if it names versions, this one. */
function applies(change: ExternalChange, dep: DependencyUsage): boolean | string {
  if (change.dependency !== dep.name) return false;
  if (!change.fromVersions?.length) return true;
  const have = dep.version;
  if (change.fromVersions.some((from) => have === from || major(have) === from)) return true;
  return `${dep.name} is at ${have}, which "${change.title}" does not name (${change.fromVersions.join(', ')}).`;
}

const SEVERITY_RANK = { security: 0, deadline: 1, breaking: 2, notice: 3 } as const;

/** The stand-in for O1's scanRepo: fake inventory → fake watcher → fake match. */
export function createFakeScanRepo(
  changes: ExternalChange[] = FAKE_EXTERNAL_CHANGES,
  now = () => new Date(),
): ScanRepo {
  return async (repo, dir) => {
    const deps = fakeInventory(dir, repo);
    const items: BehindItem[] = [];
    const tasks: ExternalTask[] = [];
    for (const dep of deps) {
      for (const change of changes) {
        const verdict = applies(change, dep);
        if (verdict === false) continue;
        if (verdict !== true) {
          items.push({
            repo,
            dependency: { ...dep, notes: verdict },
            change,
            status: 'not-affected',
          });
          continue;
        }
        items.push({
          repo,
          dependency: dep,
          change,
          deadline: change.effectiveDate,
          status: 'open',
        });
        tasks.push({
          id: `${repo}#${change.id}`,
          repo,
          change,
          usages: [],
          dependencies: [dep],
          ...(change.effectiveDate && { deadline: change.effectiveDate }),
          priority: 0,
          notes: `Fake match: ${dep.name} ${dep.version ?? ''} is declared in ${dep.declaredIn.length} place(s).`,
        });
      }
    }
    tasks.sort(
      (a, b) =>
        (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') ||
        SEVERITY_RANK[a.change.severity ?? 'notice'] - SEVERITY_RANK[b.change.severity ?? 'notice'],
    );
    tasks.forEach((task, index) => (task.priority = index + 1));
    return {
      report: {
        repo,
        scannedAt: now().toISOString(),
        items,
        costUsd: MVP_SIMULATED_COST_USD.scan,
        errors: [],
      },
      tasks,
    };
  };
}

// Kinds whose fix the fake harness can't prove with the repo's own checks: a live model call, a
// cluster, a cloud runtime, a framework's behaviour. It opens them as needs-review and says why.
const UNPROVEN: Record<string, string> = {
  'model-retirement': 'No live call was made with the replacement model; its output may differ.',
  'k8s-version':
    'The manifest was not applied to a cluster; the new Ingress backend shape is unchecked.',
  'serverless-runtime': 'The function was not deployed on the new runtime.',
  'framework-major': 'A framework major changes behaviour the repo’s few tests do not cover.',
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A range such as ">=18 <19" becomes ">=22"; otherwise the version and any minor and patch after it.
function bump(line: string, from: string, to: string): string {
  const range = new RegExp(`>=${escape(from)}(?:\\.\\d+)*,?\\s*<[\\d.]+`);
  if (range.test(line)) return line.replace(range, `>=${to}`);
  return line.replace(new RegExp(`${escape(from)}(?:\\.\\d+)*`), to);
}

/** The stand-in for O2's runExternalTask: edits each declared version in a copy and writes a diff. */
export async function fakeRunExternalTask(task: ExternalTask, repoDir: string): Promise<RunRecord> {
  const copy = mkdtempSync(join(tmpdir(), 'refit-mvp-smoke-'));
  cpSync(repoDir, copy, { recursive: true });
  const { change } = task;
  const hunks: string[] = [];
  const missed: string[] = [];
  for (const dep of task.dependencies) {
    const from = dep.version ?? dep.name;
    const to = change.toVersion;
    for (const place of dep.declaredIn) {
      const path = join(copy, place.file);
      const lines = readFileSync(path, 'utf8').split('\n');
      const index = (place.line ?? 1) - 1;
      const before = lines[index] ?? '';
      const after = to ? bump(before, from, to) : before;
      if (after === before) {
        missed.push(`${place.file}:${place.line ?? 1}`);
        continue;
      }
      lines[index] = after;
      writeFileSync(path, lines.join('\n'));
      hunks.push(
        `diff --git a/${place.file} b/${place.file}\n--- a/${place.file}\n+++ b/${place.file}\n@@ -${index + 1} +${index + 1} @@\n-${before}\n+${after}\n`,
      );
    }
  }
  const unproven = UNPROVEN[change.kind];
  const outcome: RunRecord['outcome'] =
    hunks.length === 0 || unproven || missed.length ? 'needs-review' : 'verified';
  const notes = [
    unproven,
    missed.length ? `Could not edit ${missed.join(', ')}; a person should check them.` : '',
    hunks.length === 0 ? 'The fake harness found nothing to edit; this needs a person.' : '',
  ].filter(Boolean);
  return {
    taskId: task.id,
    outcome,
    diff: hunks.join(''),
    // Labelled fake: the smoke run never executes the fixture's checks.
    checks: [
      {
        name: 'fake:test',
        before: `pass (fake, ${change.dependency} ${task.dependencies[0]?.version ?? ''})`,
        after: `pass (fake, ${change.toVersion ?? 'new'})`,
      },
    ],
    costUsd: MVP_SIMULATED_COST_USD.task,
    transcriptPath: '',
    ...(notes.length && { note: notes.join(' ') }),
  } as RunRecord;
}

/** The stand-in for O1's runRepoJob: scan, run every task, open a PR for each one with a diff. */
export function createFakeRunRepoJob(
  scanRepo: ScanRepo,
  runExternalTask = fakeRunExternalTask,
): RunRepoJob {
  return async ({ repo, dir, openPullRequest, dryRun }) => {
    const { tasks } = await scanRepo(repo, dir);
    const records: RunRecord[] = [];
    for (const task of tasks) {
      let record = await runExternalTask(task, dir);
      if (!dryRun && record.diff && record.outcome !== 'not-affected') {
        // OpenPullRequest takes a MigrationTask; an ExternalTask goes to the same opener (P1 owns it).
        const pr = await openPullRequest(task as never, record, dir);
        record = { ...record, pr };
      }
      records.push(record);
    }
    return records;
  };
}
