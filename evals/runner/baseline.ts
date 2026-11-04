// The plain-Claude baseline (round 3). Both sides get the same job from the same start: a repo,
// in the same sandbox with the same install and codegen, on the same date. Refit runs its whole
// pipeline (inventory, watch, match, harness); plain Claude gets one prompt and plain file, shell
// and web tools, and must find on its own what changed and what to fix. Both are graded alike:
// by the repo's own checks, and by a blind judge that reads both diffs as A and B.
//
//   node evals/runner/baseline.ts --in <iteration dir> --out <dir> --budget-usd <cap> --concurrency <n>
//   node evals/runner/baseline.ts --in <iteration dir> --out <dir> --report-only
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeAgentSession } from '../../harness/agent.ts';
import { compareChecks, installCommand, runChecks } from '../../harness/checks.ts';
import { BudgetLedger } from '../../harness/ledger.ts';
import { MODEL, TURN_RESERVE_USD, prepareBaseline } from '../../harness/run.ts';
import { createSandbox } from '../../harness/sandbox.ts';
import { filesFromDiff } from '../../harness/pr.ts';
import { buildTools } from '../../harness/tools.ts';
import { createBudget } from '../../orchestrator/budget.ts';
import type { RunRecord } from '../../shared/types.ts';
import { anthropicModelClient, type ModelClient } from '../reviewer/model.ts';
import { loadDevSet } from '../sets/index.ts';
import { gitCheckout } from './checkout.ts';
import type { RepoResult } from './types.ts';

/** Plain file, shell and web tools: what any coding agent has. The session adds web search. */
export const BASELINE_TOOLS = [
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'search',
  'shell',
  'install',
  'diff',
  'fetch_url',
];
const SYSTEM = 'You are a software engineer. Work in the repository with the tools you have.';
const REPO_USD = 5;
const JUDGE_MODEL = 'claude-opus-5-5';
const MAX_SIDE_CHARS = 30_000;

export function baselinePrompt(date: string): string {
  return [
    `Today is ${date}.`,
    'Find the external APIs and SDKs this repository uses. Check whether any of them has changed in a way that affects this code: deprecations, retirements, removed or renamed parameters, models or endpoints, new required versions. Then update the repository for every change that breaks it now or within 90 days; list later deprecations without editing for them.',
    'If nothing affects it, change nothing and say so. When you are done, say what you changed and why.',
  ].join('\n\n');
}

type Checks = RunRecord['checks'];

/**
 * Passes the repo's own checks: a real diff, no own check newly failing, and one of them passing.
 * Read from the before/after summaries both sides keep, so both are graded by the same rule.
 */
export function passesChecks(diff: string, checks: Checks, own: Set<string>): boolean {
  const mine = checks.filter((check) => own.has(check.name));
  const count = (summary: string) => Number(summary.match(/fail \((\d+)\)/)?.[1] ?? 0);
  const broke = mine.some(
    (check) =>
      check.after !== 'pass' &&
      (check.before === 'pass' || count(check.after) > count(check.before)),
  );
  return diff.trim() !== '' && !broke && mine.some((check) => check.after === 'pass');
}

/** What a side did, as the checks see it. */
export type ChecksGrade = 'passes' | 'fails' | 'no-change' | 'no-repo-checks';

export type JudgeSide = {
  handled: { change: string; correct: boolean; note: string }[];
  breaks: string[];
};
export type Judgement = {
  refit: JudgeSide;
  claude: JudgeSide;
  better: 'refit' | 'claude' | 'tie';
  why: string;
  costUsd: number;
};

export type BaselineRow = {
  set: string;
  repo: string;
  refit: { checks: ChecksGrade; costUsd: number; tasks: number; verified: number };
  claude: {
    checks: ChecksGrade;
    costUsd: number;
    prepCostUsd: number;
    diffLines: number;
    stopReason?: string;
    /** Checkout to graded result, as Refit's durationMs counts a whole repo. */
    durationMs?: number;
    finalText: string;
    transcriptPath: string;
    error?: string;
  };
  judge?: Judgement;
};

/** Refit's cost of producing the fix: inventory, watch, match and harness. Learning and review are not fixing. */
export function refitFixCost(result: RepoResult): number {
  const parts = result.costByPart ?? {};
  return ['inventory', 'watch', 'match', 'harness'].reduce(
    (sum, part) => sum + (parts[part] ?? 0),
    0,
  );
}

const attemptedTasks = (result: RepoResult) =>
  result.tasks.filter((task) => ['verified', 'needs-review'].includes(task.record?.outcome ?? ''));

export function refitSide(
  result: RepoResult,
  own: Set<string>,
): { grade: ChecksGrade; diff: string; text: string } {
  const attempted = attemptedTasks(result);
  if (attempted.length === 0) {
    return {
      grade: 'no-change',
      diff: '',
      text: `Found no change affecting this repo. ${(result.matchReasoning ?? '').slice(0, 1500)}`,
    };
  }
  const records = attempted.map((task) => task.record as RunRecord);
  const grade: ChecksGrade =
    own.size === 0
      ? 'no-repo-checks'
      : records.every((record) => passesChecks(record.diff, record.checks, own))
        ? 'passes'
        : 'fails';
  // One PR per change: each diff is shown under the change it answers.
  const diff = attempted
    .map((task) => `### PR for: ${task.change?.title ?? task.taskId}\n${task.record?.diff ?? ''}`)
    .join('\n\n');
  // The agent's own words on what it did, as plain Claude gives its own: the PR body's headings
  // and footer would tell the judge which attempt is which.
  const text = attempted
    .map((task) => {
      const summary = (task.record as { summary?: string }).summary ?? '';
      const said = summary.slice(summary.indexOf('Verdict:')).replace(/^Verdict: \S+\.\s*/, '');
      return `### ${task.change?.title ?? task.taskId}\n${said.split('\nUnproven:')[0]?.slice(0, 1500) ?? ''}`;
    })
    .join('\n\n');
  return { grade, diff, text };
}

const JUDGE_SYSTEM = `You compare two attempts, A and B, at the same job on the same repository: find the external APIs and SDKs it uses, check whether any changed in a way that affects the code (deprecations, retirements, removed parameters, models or endpoints, new required versions), and update the code for every change that breaks it now or within 90 days of the run. A deprecation that takes effect later only needs to be named, not edited for; editing for it is not a fault, but not needed either.

Each attempt gives its own explanation and its diff. An attempt may change nothing. Read both. For each attempt, list every API change it handles (one entry per change) and whether its handling is correct and complete, and anything it breaks or changes that no API change required. Then say which attempt does the job better, or tie.

A test that checks the change is not a fault, whichever attempt adds it, as long as it doesn't break anything; judge the code change itself.

Your knowledge of provider APIs may be older than these changes. When an attempt cites a change you can't confirm, judge whether its code is consistent with what it cites; don't call it invented on memory alone. A change one attempt finds and the other misses counts for the one that found it, if the code really uses the changed API.

Reply with one JSON object and nothing else.`;

const SIDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['handled', 'breaks'],
  properties: {
    handled: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['change', 'correct', 'note'],
        properties: {
          change: { type: 'string' },
          correct: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    breaks: { type: 'array', items: { type: 'string' } },
  },
};
const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['a', 'b', 'better', 'why'],
  properties: {
    a: SIDE_SCHEMA,
    b: SIDE_SCHEMA,
    better: { type: 'string', enum: ['A', 'B', 'tie'] },
    why: { type: 'string' },
  },
};

/** Which side is A, fixed per repo so a rerun shows the judge the same order. */
export const refitIsA = (repo: string) =>
  (createHash('sha256').update(repo).digest()[0] ?? 0) % 2 === 0;

export async function judge(
  client: ModelClient,
  repo: string,
  refit: { text: string; diff: string },
  claude: { text: string; diff: string },
): Promise<Judgement> {
  const aIsRefit = refitIsA(repo);
  const [a, b] = aIsRefit ? [refit, claude] : [claude, refit];
  const side = (label: string, s: { text: string; diff: string }) =>
    `## Attempt ${label}\n\n### Its explanation\n${s.text.slice(0, 6000) || '(none)'}\n\n### Its diff\n${s.diff.slice(0, MAX_SIDE_CHARS) || '(no change)'}`;
  const response = await client.complete({
    system: JUDGE_SYSTEM,
    prompt: `Repository: ${repo}\n\n${side('A', a)}\n\n${side('B', b)}`,
    maxTokens: 6000,
    jsonSchema: JUDGE_SCHEMA,
  });
  const parsed = JSON.parse(response.text) as {
    a: JudgeSide;
    b: JudgeSide;
    better: 'A' | 'B' | 'tie';
    why: string;
  };
  const better =
    parsed.better === 'tie' ? 'tie' : (parsed.better === 'A') === aIsRefit ? 'refit' : 'claude';
  return {
    refit: aIsRefit ? parsed.a : parsed.b,
    claude: aIsRefit ? parsed.b : parsed.a,
    better,
    why: parsed.why,
    costUsd: response.costUsd,
  };
}

/** The repo's own checks, from its screen record: everything but the harness's fallback. */
export function ownChecks(screenDir: string, set: string, repo: string): Set<string> {
  const dir = join(screenDir, set);
  const file = existsSync(dir)
    ? readdirSync(dir).find((name) => name.startsWith(`${repo.replace('/', '__')}@`))
    : undefined;
  if (!file) return new Set();
  const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    checks: { name: string; fallback?: boolean }[];
  };
  return new Set(record.checks.filter((check) => !check.fallback).map((check) => check.name));
}

/** Plain Claude's attempt at one repo, kept with its diff so it can be judged later, on its own. */
export type ClaudeRun = BaselineRow['claude'] & { set: string; repo: string; diff: string };

type RepoAt = { set: string; repo: string; commit: string; provider: string };

/** Runs plain Claude on one repo. Needs nothing of Refit's, so it can run before or beside it. */
async function runClaude(
  entry: RepoAt,
  screenDir: string,
  date: string,
  budget: ReturnType<typeof createBudget>,
): Promise<ClaudeRun> {
  const own = ownChecks(screenDir, entry.set, entry.repo);
  const run: ClaudeRun = {
    set: entry.set,
    repo: entry.repo,
    diff: '',
    checks: 'no-change',
    costUsd: 0,
    prepCostUsd: 0,
    diffLines: 0,
    finalText: '',
    transcriptPath: '',
  };
  const started = Date.now();
  const hold = await budget.reserve(`baseline ${entry.repo}`, REPO_USD + 1);
  const ledger = new BudgetLedger(hold.usd);
  try {
    const copy = await gitCheckout()({ repo: entry.repo, commit: entry.commit });
    try {
      const sandbox = await createSandbox(copy.repoDir);
      try {
        const prepared = await prepareBaseline(sandbox, ledger);
        run.prepCostUsd = ledger.spentUsd;
        // Its own folder per run: a rerun must not append to an earlier run's transcript.
        const outDir = mkdtempSync(join(tmpdir(), `baseline-${entry.repo.replace(/\W+/g, '-')}-`));
        const transcriptPath = join(outDir, 'transcript.jsonl');
        run.transcriptPath = transcriptPath;
        const tools = buildTools({
          sandbox,
          // The tools need a task to exist; plain Claude is told nothing of it.
          task: {
            id: `baseline:${entry.repo}`,
            repo: entry.repo,
            change: {
              provider: entry.provider,
              id: 'baseline',
              kind: 'other',
              title: '',
              source: { url: '', quote: '' },
              affects: {},
            },
            usages: [],
            priority: 0,
          },
          toolPack: { provider: entry.provider, tools: [], playbooks: {} },
          retrieveRecipes: async () => [],
          checks: prepared.checks,
          onFinish: () => {},
        }).filter((tool) => BASELINE_TOOLS.includes(tool.name));
        const session = await claudeAgentSession({
          model: MODEL,
          systemPrompt: SYSTEM,
          prompt: baselinePrompt(date),
          tools,
          sandbox,
          ledger,
          budgetUsd: Math.min(REPO_USD, ledger.remainingUsd - TURN_RESERVE_USD),
          maxTurns: 120,
          log: (event) =>
            writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`, { flag: 'a' }),
        });
        run.stopReason = session.stopReason;
        run.finalText = session.finalText.slice(0, 6000);
        const after = await runChecks(sandbox, prepared.checks);
        const checks = compareChecks(prepared.before, after).map(
          ({ name, before, after: now }) => ({ name, before, after: now }),
        );
        run.diff = await sandbox.diff();
        run.diffLines = run.diff.trim() ? run.diff.split('\n').length : 0;
        run.checks = !run.diff.trim()
          ? 'no-change'
          : own.size === 0
            ? 'no-repo-checks'
            : passesChecks(run.diff, checks, own)
              ? 'passes'
              : 'fails';
        run.costUsd = ledger.spentUsd;
      } finally {
        await sandbox.dispose();
      }
    } finally {
      await copy.cleanup().catch(() => undefined);
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    hold.settle(ledger.spentUsd);
  }
  run.durationMs = Date.now() - started;
  return run;
}

/** Pairs Refit's result with plain Claude's run of the same repo and has the judge read both. */
async function compareRepo(
  result: RepoResult,
  claude: ClaudeRun,
  screenDir: string,
  judgeClient: ModelClient,
): Promise<BaselineRow> {
  const own = ownChecks(screenDir, result.set, result.repo);
  const refit = refitSide(result, own);
  const attempted = attemptedTasks(result);
  const { set: _set, repo: _repo, diff: claudeDiff, ...claudeSide } = claude;
  const row: BaselineRow = {
    set: result.set,
    repo: result.repo,
    refit: {
      checks: refit.grade,
      costUsd: refitFixCost(result),
      tasks: attempted.length,
      verified: attempted.filter((task) => task.record?.outcome === 'verified').length,
    },
    claude: claudeSide,
  };
  if (row.claude.error) return row;
  // Nothing to compare when neither side changed anything.
  row.judge =
    refit.diff.trim() || claudeDiff.trim()
      ? await judge(judgeClient, result.repo, refit, {
          text: row.claude.finalText,
          diff: claudeDiff,
        }).catch(() => undefined)
      : {
          refit: { handled: [], breaks: [] },
          claude: { handled: [], breaks: [] },
          better: 'tie',
          why: 'Neither side changed anything.',
          costUsd: 0,
        };
  return row;
}

/** Whether a side's diff leaves the code broken, by the same neutral check for both sides. */
export type CodeCheck = {
  status: 'clean' | 'broken' | 'no-change' | 'unverifiable' | 'did-not-apply' | 'error';
  problems: string[];
  checked: string[];
};

/**
 * Refit's recorded diffs pass the secret scrubber, which also rewrites lines the change didn't
 * touch, so the patch no longer matches the file. Context and removed lines are the repo's own
 * text: they are restored from the original file. An added line the scrubber rewrote stays as
 * recorded, since that is what the PR would carry.
 */
export function unredact(diff: string, original: (file: string) => string[] | undefined): string {
  let lines: string[] | undefined;
  let at = 0;
  return diff
    .split('\n')
    .map((line) => {
      const file = line.match(/^--- a\/(.+)$/)?.[1];
      if (file !== undefined) {
        lines = original(file);
        return line;
      }
      if (line.startsWith('--- ')) lines = undefined;
      const hunk = line.match(/^@@ -(\d+)/);
      if (hunk) {
        at = Number(hunk[1]) - 1;
        return line;
      }
      if (line.startsWith(' ') || (line.startsWith('-') && !line.startsWith('---'))) {
        const real = lines?.[at];
        at += 1;
        return line.includes('[redacted]') && real !== undefined ? `${line[0]}${real}` : line;
      }
      return line;
    })
    .join('\n');
}

/** A syntax or load check for one changed file, when its language has a cheap one. */
export function syntaxCheck(file: string): { name: string; command: string } | undefined {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  if (/\.(?:c|m)?js$/.test(file))
    return { name: `syntax ${file}`, command: `node --check ${quoted}` };
  if (/\.py$/.test(file))
    return { name: `syntax ${file}`, command: `python3 -m py_compile ${quoted}` };
  if (/\.json$/.test(file) && !/(?:^|\/)tsconfig[^/]*\.json$/.test(file)) {
    return {
      name: `syntax ${file}`,
      command: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" ${quoted}`,
    };
  }
  return undefined;
}

/**
 * Applies a side's diffs to a fresh, prepared copy and runs the repo's checks (the harness's
 * fallback type check included) and a syntax check of every changed file, before and after. Any
 * failure the change added means the code is broken. Plain compute: the only model call is the
 * same setup planner both sides' runs had.
 */
async function checkCode(
  entry: RepoAt,
  diffs: string[],
  budget: ReturnType<typeof createBudget>,
): Promise<CodeCheck> {
  // A binary file (bytecode the checks compiled) can't be applied from a text diff and is no
  // part of the change; its entry is left out.
  const textOnly = (diff: string) =>
    diff
      .split(/(?=^diff --git )/m)
      .filter((file) => !/^(?:Binary files .* differ|GIT binary patch)$/m.test(file))
      .join('');
  const changes = diffs.map(textOnly).filter((diff) => diff.trim());
  if (changes.length === 0) return { status: 'no-change', problems: [], checked: [] };
  const hold = await budget.reserve(`code check ${entry.repo}`, 1);
  const ledger = new BudgetLedger(hold.usd);
  try {
    const copy = await gitCheckout()({ repo: entry.repo, commit: entry.commit });
    try {
      const sandbox = await createSandbox(copy.repoDir);
      try {
        const prepared = await prepareBaseline(sandbox, ledger);
        const files = [...new Set(changes.flatMap(filesFromDiff))];
        const syntax = files.flatMap((file) => syntaxCheck(file) ?? []);
        const existing = syntax.filter((check) =>
          existsSync(join(sandbox.dir, check.name.slice(7))),
        );
        const before = [...prepared.before, ...(await runChecks(sandbox, existing))];
        // Running the checks builds files (dist/); each diff goes onto the prepared copy, after a reset.
        // Each diff is one PR and merges on its own against the original, so each is applied to
        // the prepared copy by itself: two of a repo's PRs may edit the same lines.
        const checks = [...prepared.checks, ...syntax];
        const problems: string[] = [];
        let reinstalled = false;
        for (const [i, scrubbed] of changes.entries()) {
          await sandbox.reset?.();
          // reset() leaves node_modules alone: a previous PR's install must not leak into this one.
          if (reinstalled) {
            await sandbox.exec(installCommand(prepared.pm, prepared.pmVersion));
            reinstalled = false;
          }
          const diff = unredact(scrubbed, (file) => {
            try {
              return readFileSync(join(sandbox.dir, file), 'utf8').split('\n');
            } catch {
              return undefined;
            }
          });
          const patch = join(mkdtempSync(join(tmpdir(), 'code-check-')), `${i}.patch`);
          writeFileSync(patch, diff.endsWith('\n') ? diff : `${diff}\n`);
          const failed = await new Promise<string | undefined>((done) =>
            execFile(
              'git',
              ['apply', '--whitespace=nowarn', patch],
              { cwd: sandbox.dir },
              (error, _out, err) =>
                done(error ? String(err || error.message).slice(0, 300) : undefined),
            ),
          );
          if (failed) return { status: 'did-not-apply', problems: [failed], checked: [] };
          // A change to the dependencies needs them installed, as the PR's own CI would.
          if (
            prepared.pm !== 'none' &&
            /^diff --git a\/\S*(?:package\.json|lock|requirements[^/\s]*\.txt|pyproject\.toml)\b/m.test(
              diff,
            )
          ) {
            await sandbox.exec(installCommand(prepared.pm, prepared.pmVersion));
            reinstalled = true;
          }
          const after = await runChecks(sandbox, checks);
          const label = changes.length > 1 ? `PR ${i + 1} of ${changes.length}: ` : '';
          // Broken means a check that passed before fails after. One that already failed (a build
          // short of env vars, say) can't tell either way, and its error text varies run to run.
          for (const run of after.filter((candidate) => !candidate.ok)) {
            const was = before.find((candidate) => candidate.name === run.name);
            if (was && !was.ok) continue;
            problems.push(
              `${label}${run.name}: ${run.failures.slice(0, 2).join('; ')}`.slice(0, 300),
            );
          }
        }
        // Checks that passed before are the only ones that can show a break.
        const usable = checks.filter(
          (check) =>
            before.some((run) => run.name === check.name && run.ok) ||
            !before.some((run) => run.name === check.name),
        );
        return {
          status: problems.length ? 'broken' : usable.length ? 'clean' : 'unverifiable',
          problems,
          checked: usable.map((check) => check.name),
        };
      } finally {
        await sandbox.dispose();
      }
    } finally {
      await copy.cleanup().catch(() => undefined);
    }
  } catch (error) {
    return {
      status: 'error',
      problems: [error instanceof Error ? error.message : String(error)],
      checked: [],
    };
  } finally {
    hold.settle(ledger.spentUsd);
  }
}

export function formatComparison(rows: BaselineRow[]): string {
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
  const judged = rows.filter((row) => row.judge);
  const wins = (side: 'refit' | 'claude' | 'tie') =>
    judged.filter((row) => row.judge?.better === side).length;
  const count = (side: 'refit' | 'claude', pick: (s: JudgeSide) => number) =>
    judged.reduce((sum, row) => sum + (row.judge ? pick(row.judge[side]) : 0), 0);
  const correct = (side: 'refit' | 'claude') =>
    count(side, (s) => s.handled.filter((h) => h.correct).length);
  const handled = (side: 'refit' | 'claude') => count(side, (s) => s.handled.length);
  const breaks = (side: 'refit' | 'claude') => count(side, (s) => s.breaks.length);
  const graded = (side: 'refit' | 'claude', grade: ChecksGrade) =>
    rows.filter((row) => row[side].checks === grade).length;
  const checked = (side: 'refit' | 'claude') =>
    `${graded(side, 'passes')} of ${graded(side, 'passes') + graded(side, 'fails')}`;
  const cost = (side: 'refit' | 'claude') =>
    rows.reduce((sum, row) => sum + row[side].costUsd, 0) / (rows.length || 1);
  const judgeCost = judged.reduce((sum, row) => sum + (row.judge?.costUsd ?? 0), 0);
  return [
    '# Refit vs plain Claude',
    '',
    `Both start from the repo alone, in the same sandbox with the same setup. Refit runs its whole pipeline; plain Claude (${MODEL}) gets one prompt and plain file, shell and web tools, and finds the changes itself. A blind judge (${JUDGE_MODEL}) reads both diffs as A and B, in an order fixed per repo.`,
    '',
    '| | Refit | Plain Claude |',
    '| --- | --- | --- |',
    `| Judge prefers | ${wins('refit')} of ${judged.length} (${pct(wins('refit'), judged.length)}) | ${wins('claude')} of ${judged.length} (${pct(wins('claude'), judged.length)}) |`,
    `| Ties | ${wins('tie')} | ${wins('tie')} |`,
    `| API changes handled correctly / handled | ${correct('refit')} / ${handled('refit')} | ${correct('claude')} / ${handled('claude')} |`,
    `| Things broken or changed without need | ${breaks('refit')} | ${breaks('claude')} |`,
    `| Repo's own checks pass (changed repos with checks) | ${checked('refit')} | ${checked('claude')} |`,
    `| Changed a repo with no checks of its own | ${graded('refit', 'no-repo-checks')} | ${graded('claude', 'no-repo-checks')} |`,
    `| Changed nothing | ${graded('refit', 'no-change')} | ${graded('claude', 'no-change')} |`,
    `| Cost of the fix per repo | $${cost('refit').toFixed(2)} | $${cost('claude').toFixed(2)} |`,
    '',
    `${rows.length} repos. Refit's cost is inventory, watch, match and harness; memory learning and the advisory review are left out. The judge cost $${judgeCost.toFixed(2)}.`,
    '',
    '| Set | Repo | Refit | Claude | Judge | Why |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| ${row.set} | ${row.repo} | ${row.refit.tasks} tasks, ${row.refit.verified} verified, checks ${row.refit.checks}, $${row.refit.costUsd.toFixed(2)} | ${row.claude.error ? `error: ${row.claude.error.slice(0, 50)}` : `checks ${row.claude.checks}, $${row.claude.costUsd.toFixed(2)}`} | ${row.judge?.better ?? '-'} | ${(row.judge?.why ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 220)} |`,
    ),
    '',
  ].join('\n');
}

function repoResults(inDir: string): RepoResult[] {
  const out: RepoResult[] = [];
  for (const set of readdirSync(inDir)) {
    const dir = join(inDir, set);
    if (!/^[a-z0-9-]+$/.test(set) || !existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => /^\d+-.*\.json$/.test(name))) {
      out.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as RepoResult);
    }
  }
  // Repos Refit changed first, so the comparisons that matter most land first.
  return out.sort(
    (a, b) => attemptedTasks(b).length - attemptedTasks(a).length || a.repo.localeCompare(b.repo),
  );
}

async function main(argv: string[]) {
  const flag = (name: string) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const inDir = resolve(flag('in') ?? 'evals/reports/round-3/iter-1');
  const outDir = resolve(flag('out') ?? 'evals/reports/round-3/baseline-iter-1');
  const screenDir = resolve(flag('screen') ?? join(inDir, '..', 'screen'));
  mkdirSync(outDir, { recursive: true });
  if (argv.includes('--report-only')) {
    const rows = readdirSync(outDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(outDir, name), 'utf8')) as BaselineRow);
    const report = formatComparison(rows);
    writeFileSync(join(outDir, 'COMPARISON.md'), report);
    console.log(report);
    return;
  }
  const budgetUsd = Number(flag('budget-usd'));
  const concurrency = Number(flag('concurrency') ?? 2);
  if (!(budgetUsd > 0)) throw new Error('--budget-usd is required and must be above zero');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY for the baseline.');
  const date = flag('date') ?? new Date().toISOString().slice(0, 10);
  const budget = createBudget(budgetUsd);
  const judgeClient = anthropicModelClient({ budget, model: JUDGE_MODEL });
  // Plain Claude's runs are kept apart from the comparisons, so they can run beside Refit's.
  const claudeDir = join(outDir, 'claude');
  mkdirSync(claudeDir, { recursive: true });
  const claudeFile = (set: string, repo: string) =>
    join(claudeDir, `${set}__${repo.replace('/', '__')}.json`);
  const claudeFor = async (entry: RepoAt): Promise<ClaudeRun> => {
    const file = claudeFile(entry.set, entry.repo);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ClaudeRun;
    const run = await runClaude(entry, screenDir, date, budget);
    if (!run.error) writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
    return run;
  };
  if (argv.includes('--verify')) {
    // The same neutral code check on both sides' diffs, for every repo both have finished.
    const verifyDir = join(outDir, 'verify');
    mkdirSync(verifyDir, { recursive: true });
    // Each side is checked on its own, as soon as it exists: plain Claude's runs don't wait for Refit's.
    const results = new Map(
      repoResults(inDir).map((result) => [`${result.set}/${result.repo}`, result]),
    );
    const pairs = readdirSync(claudeDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(claudeDir, name), 'utf8')) as ClaudeRun)
      .map((claude) => ({ claude, result: results.get(`${claude.set}/${claude.repo}`) }));
    const entryOf = (claude: ClaudeRun): RepoAt => {
      const set = loadDevSet(claude.set);
      const found = set.repos.find((entry) => entry.repo === claude.repo);
      if (!found) throw new Error(`${claude.repo} is not in ${claude.set}`);
      return { set: set.name, repo: claude.repo, commit: found.commit, provider: set.provider };
    };
    let at = 0;
    const checker = async () => {
      while (at < pairs.length) {
        const { result, claude } = pairs[at++] as (typeof pairs)[number];
        const base = join(verifyDir, `${claude.set}__${claude.repo.replace('/', '__')}`);
        const entry = entryOf(claude);
        const jobs: Promise<void>[] = [];
        if (!existsSync(`${base}.claude.json`)) {
          jobs.push(
            checkCode(entry, [claude.diff], budget).then((check) => {
              writeFileSync(`${base}.claude.json`, `${JSON.stringify(check, null, 2)}\n`);
              console.log(`${claude.repo}: code check Claude ${check.status}`);
            }),
          );
        }
        if (result && !existsSync(`${base}.refit.json`)) {
          const diffs = attemptedTasks(result).map((task) => task.record?.diff ?? '');
          jobs.push(
            checkCode(entry, diffs, budget).then((check) => {
              writeFileSync(`${base}.refit.json`, `${JSON.stringify(check, null, 2)}\n`);
              console.log(`${claude.repo}: code check Refit ${check.status}`);
            }),
          );
        }
        await Promise.all(jobs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, checker));
    console.log(`Spent $${budget.spentUsd().toFixed(2)} of $${budgetUsd}`);
    return;
  }
  if (argv.includes('--claude-only')) {
    // Plain Claude alone, on chosen repos of the sets: nothing of Refit's is read.
    const repos = new Set((flag('repos') ?? '').split(',').filter(Boolean));
    const entries = (flag('sets') ?? '')
      .split(',')
      .filter(Boolean)
      .flatMap((name) => {
        const set = loadDevSet(name);
        return set.repos
          .filter((entry) => repos.has(entry.repo))
          .map((entry) => ({
            set: set.name,
            repo: entry.repo,
            commit: entry.commit,
            provider: typeof entry.provider === 'string' ? entry.provider : set.provider,
          }));
      });
    let at = 0;
    const runner = async () => {
      while (at < entries.length) {
        const entry = entries[at++] as RepoAt;
        const run = await claudeFor(entry);
        console.log(
          `${entry.repo}: Claude ${run.error ? `error ${run.error.slice(0, 80)}` : `checks ${run.checks} ($${run.costUsd.toFixed(2)})`}`,
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, runner));
    console.log(`Spent $${budget.spentUsd().toFixed(2)} of $${budgetUsd}`);
    return;
  }
  const todo = repoResults(inDir).filter((result) => result.verdict !== 'error');
  const rows: BaselineRow[] = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const result = todo[next++] as RepoResult;
      const file = join(outDir, `${result.set}__${result.repo.replace('/', '__')}.json`);
      if (existsSync(file)) {
        rows.push(JSON.parse(readFileSync(file, 'utf8')) as BaselineRow);
        continue;
      }
      const claude = await claudeFor(result);
      const row = await compareRepo(result, claude, screenDir, judgeClient);
      writeFileSync(file, `${JSON.stringify(row, null, 2)}\n`);
      rows.push(row);
      console.log(
        `${row.repo}: Refit ${row.refit.tasks} tasks (checks ${row.refit.checks}), Claude ${row.claude.error ? `error ${row.claude.error.slice(0, 80)}` : `checks ${row.claude.checks} ($${row.claude.costUsd.toFixed(2)})`}, judge ${row.judge?.better ?? '-'}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  const report = formatComparison(rows);
  writeFileSync(join(outDir, 'COMPARISON.md'), report);
  console.log(report);
  console.log(`Spent $${budget.spentUsd().toFixed(2)} of $${budgetUsd}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
