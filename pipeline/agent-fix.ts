import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  aiBudgetConfiguration,
  aiBudgetLimit,
  reserveAiAmount,
  type AiBudget,
} from './ai-budget.ts';
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_ESCALATION_MODEL } from './anthropic.ts';

// The agent fixer every provider hands its migrations to (docs/GUT-PLAN.md): Claude works in a copy
// of the repository, Refit's deterministic check judges each pass and its errors go back to the
// same session, and the best of several parallel attempts is left in repoDir.
export type AgentFixInput = {
  repoDir: string; // sandbox copy; the agent edits it in place
  provider: 'shopify' | 'meta-graph' | 'stripe';
  target: string; // e.g. Admin API '2026-10', Graph 'v24.0'
  change: string; // what changed, quoted from Refit's provider data
  context: string; // the old stop's reason and findings, files and lines
  check: (repoDir: string) => Promise<{ passed: boolean; errors: string[] }>; // deterministic judge
  attempts?: number; // best-of-N, default 3
  rounds?: number; // feedback rounds per attempt, default 3
};
export type AgentFixResult = {
  outcome: 'passed' | 'unproven' | 'no-change' | 'failed';
  diff: string;
  errors: string[]; // remaining judge errors when not passed
  summary: string; // what the agent changed, what it could not verify, behaviour changes
  costUsd: number;
};

// One coding-agent session in one directory. `send` returns when the agent finishes that turn;
// costUsd is the session's running total.
export interface AgentSession {
  send(message: string): Promise<{ text: string; costUsd: number; stopped: boolean }>;
  close(): Promise<void>;
}
export type AgentRunner = (options: {
  repoDir: string;
  model: string;
  provider: AgentFixInput['provider'];
  maxBudgetUsd: number;
}) => AgentSession;

export type AgentFixOptions = {
  runner?: AgentRunner;
  // The run-level ledger; REFIT_AI_BUDGET_* when unset. There is no per-repository cap.
  budget?: AiBudget;
  // What one attempt reserves in the ledger and may spend; REFIT_AGENT_ATTEMPT_USD, default 3.
  attemptUsd?: number;
};

export const DOCS_DOMAINS: Record<AgentFixInput['provider'], string[]> = {
  shopify: ['shopify.dev'],
  'meta-graph': ['developers.facebook.com'],
  stripe: ['docs.stripe.com'],
};
const PROVIDER_NAMES: Record<AgentFixInput['provider'], string> = {
  shopify: 'Shopify',
  'meta-graph': 'Meta Graph API',
  stripe: 'Stripe',
};
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_ROUNDS = 3;
const DEFAULT_ATTEMPT_USD = 3;
// The SDK's budget stop is checked between turns, so leave headroom inside the reservation.
const SESSION_SHARE = 0.85;
const MAX_ERROR_CHARS = 20_000;
const GIT_BUFFER = 512 * 1024 * 1024;
const run = promisify(execFile);
// The file ledger refuses a second writer instead of waiting, so this process takes turns.
let ledgerTurn: Promise<unknown> = Promise.resolve();
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const next = ledgerTurn.then(task, task);
  ledgerTurn = next.catch(() => undefined);
  return next;
}

export async function fixWithAgent(
  input: AgentFixInput,
  options: AgentFixOptions = {},
): Promise<AgentFixResult> {
  const attempts = Math.max(1, input.attempts ?? DEFAULT_ATTEMPTS);
  const rounds = Math.max(1, input.rounds ?? DEFAULT_ROUNDS);
  const budget = options.budget ?? aiBudgetConfiguration(process.env);
  const attemptUsd =
    options.attemptUsd ??
    aiBudgetLimit(
      process.env.REFIT_AGENT_ATTEMPT_USD,
      'REFIT_AGENT_ATTEMPT_USD',
      DEFAULT_ATTEMPT_USD,
    );
  const runner = options.runner ?? (await import('./agent-fix-sdk.ts')).sdkRunner;
  const model = process.env.ANTHROPIC_MODEL?.trim() || ANTHROPIC_DEFAULT_MODEL;
  const escalation = process.env.ANTHROPIC_ESCALATION_MODEL?.trim() || ANTHROPIC_ESCALATION_MODEL;
  const repoDir = resolve(input.repoDir);
  const work = await mkdtemp(join(tmpdir(), 'refit-agent-fix-'));
  try {
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, index) =>
        attempt(input, {
          index,
          repoDir,
          work,
          rounds,
          budget,
          attemptUsd,
          runner,
          model: attempts > 1 && index === attempts - 1 ? escalation : model,
        }),
      ),
    );
    const winner = pickAttempt(results);
    if (winner.files.length) await copyChanges(winner.dir, repoDir, winner.files);
    return {
      outcome: winner.outcome,
      diff: winner.diff,
      errors: winner.outcome === 'passed' || winner.outcome === 'no-change' ? [] : winner.errors,
      summary: winner.summary,
      costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

type Attempt = AgentFixResult & { dir: string; files: Change[] };
type Change = { status: string; path: string };

const RANK: Record<AgentFixResult['outcome'], number> = {
  passed: 0,
  'no-change': 1,
  unproven: 2,
  failed: 3,
};

// The attempt that passed, otherwise the one with the fewest remaining errors; earlier attempts
// (the cheaper model) win ties.
export function pickAttempt<T extends Pick<AgentFixResult, 'outcome' | 'errors'>>(results: T[]): T {
  return results.reduce((best, result) => {
    const order = RANK[result.outcome] - RANK[best.outcome];
    if (order) return order < 0 ? result : best;
    return result.outcome === 'unproven' && result.errors.length < best.errors.length
      ? result
      : best;
  });
}

async function attempt(
  input: AgentFixInput,
  setup: {
    index: number;
    repoDir: string;
    work: string;
    rounds: number;
    budget: AiBudget;
    attemptUsd: number;
    runner: AgentRunner;
    model: string;
  },
): Promise<Attempt> {
  const dir = join(setup.work, `attempt-${setup.index}`, 'repo');
  const gitDir = join(setup.work, `attempt-${setup.index}`, 'base.git');
  const failed = (errors: string[], costUsd = 0): Attempt => ({
    outcome: 'failed',
    diff: '',
    errors,
    summary: '',
    costUsd,
    dir,
    files: [],
  });
  try {
    await cp(setup.repoDir, dir, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await snapshot(dir, gitDir);
  } catch (error) {
    return failed([`Could not copy the repository for the agent: ${message(error)}`]);
  }
  let settle: Awaited<ReturnType<typeof reserveAiAmount>>;
  try {
    settle = await inTurn(() => reserveAiAmount(setup.budget, setup.attemptUsd));
  } catch (error) {
    return failed([message(error)]);
  }
  const session = setup.runner({
    repoDir: dir,
    model: setup.model,
    provider: input.provider,
    maxBudgetUsd: setup.attemptUsd * SESSION_SHARE,
  });
  let reply: { text: string; costUsd: number; stopped: boolean } | undefined;
  let verdict: { passed: boolean; errors: string[] } = { passed: false, errors: [] };
  let crashed: string | undefined;
  try {
    let next = prompt(input);
    for (let round = 1; ; round++) {
      reply = await session.send(next);
      verdict = await judge(input, dir);
      if (verdict.passed || reply.stopped || round >= setup.rounds) break;
      next = feedback(verdict.errors);
    }
  } catch (error) {
    crashed = `The agent session failed: ${message(error)}`;
  } finally {
    await session.close().catch(() => undefined);
  }
  // A session that never reported its cost keeps its whole reservation, as unpriced requests do.
  let costUsd = setup.attemptUsd;
  if (reply)
    costUsd = await inTurn(() => settle(reply!.costUsd)).then(
      (settled) => settled.costUsd,
      () => reply!.costUsd,
    );
  let diff = '';
  let files: Change[] = [];
  try {
    ({ diff, files } = await changes(dir, gitDir));
  } catch (error) {
    return failed([`Could not read the agent's changes: ${message(error)}`], costUsd);
  }
  const errors = crashed ? [crashed, ...verdict.errors] : verdict.errors;
  const passed = verdict.passed && !crashed;
  return {
    outcome: files.length ? (passed ? 'passed' : 'unproven') : passed ? 'no-change' : 'failed',
    diff,
    errors,
    summary: reply?.text.trim() ?? '',
    costUsd,
    dir,
    files,
  };
}

async function judge(input: AgentFixInput, dir: string) {
  try {
    return await input.check(dir);
  } catch (error) {
    return { passed: false, errors: [`Refit's check failed to run: ${message(error)}`] };
  }
}

export function prompt(input: AgentFixInput) {
  const name = PROVIDER_NAMES[input.provider];
  return `This repository uses the ${name} API. Migrate it to ${name} ${input.target}.

What changed, quoted from Refit's provider data:
${input.change.trim() || '(none recorded)'}

What Refit found in this repository (its earlier stop reasons and findings, with files and lines):
${input.context.trim() || '(nothing recorded)'}

How to work:
- Always attempt the migration. Do not stop at the findings above; they are where to start, not a reason to decline.
- Keep behaviour the same. Where a change unavoidably alters behaviour, make the smallest one and say so.
- Do not restructure code, delete features or loosen types just to satisfy a checker.
- You may read and edit files in this repository, install dependencies with its own package manager, run tsc, git diff and git status, and read ${DOCS_DOMAINS[input.provider].join(', ')}.
- If nothing needs to change, change nothing and say why.

Finish with a summary in three parts: what you changed, what you could not verify, and any behaviour change.`;
}

export function feedback(errors: string[]) {
  let text = errors.join('\n');
  if (text.length > MAX_ERROR_CHARS) text = `${text.slice(0, MAX_ERROR_CHARS)}\n[truncated]`;
  return `Refit's check still fails on the repository as you left it. Its exact errors:

${text || '(the check reported no error text)'}

Fix the cause, keeping behaviour the same and changing nothing unrelated. Finish again with the full summary of all your changes so far: what you changed, what you could not verify, and any behaviour change.`;
}

// Refit records the starting tree in its own git directory, so the repository's own history,
// index and uncommitted head-start edits stay untouched and the diff is only the agent's work.
async function snapshot(dir: string, gitDir: string) {
  await git(dir, gitDir, ['init', '-q']);
  await mkdir(join(gitDir, 'info'), { recursive: true });
  await writeFile(join(gitDir, 'info', 'exclude'), 'node_modules/\n');
  await git(dir, gitDir, ['add', '-A']);
  await git(dir, gitDir, [
    '-c',
    'user.name=Refit',
    '-c',
    'user.email=refit@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '--no-verify',
    '-m',
    'before the agent',
  ]);
}

async function changes(dir: string, gitDir: string) {
  await git(dir, gitDir, ['add', '-A']);
  const diff = await git(dir, gitDir, ['diff', '--cached', '--binary', '--no-renames', 'HEAD']);
  const listed = (
    await git(dir, gitDir, ['diff', '--cached', '--name-status', '--no-renames', '-z', 'HEAD'])
  )
    .split('\0')
    .filter(Boolean);
  const files: Change[] = [];
  for (let index = 0; index + 1 < listed.length; index += 2)
    files.push({ status: listed[index], path: listed[index + 1] });
  return { diff, files };
}

async function copyChanges(from: string, to: string, files: Change[]) {
  for (const { status, path } of files) {
    const target = join(to, path);
    if (!target.startsWith(to + sep)) continue;
    if (status === 'D') await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await cp(join(from, path), target, { verbatimSymlinks: true });
    }
  }
}

async function git(dir: string, gitDir: string, args: string[]) {
  const { stdout } = await run('git', ['--git-dir', gitDir, '--work-tree', dir, ...args], {
    cwd: dir,
    maxBuffer: GIT_BUFFER,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
