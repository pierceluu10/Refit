import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { summarizeAiLedger } from './ai-budget.ts';
import { toolPolicy } from './agent-fix-sdk.ts';
import {
  fixWithAgent,
  pickAttempt,
  type AgentFixInput,
  type AgentRunner,
  type AgentSession,
} from './agent-fix.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'refit-agent-fix-test-'));
  roots.push(root);
  return root;
}

async function setup(limitUsd = 10) {
  const repoDir = join(await temporary(), 'repo');
  await mkdir(join(repoDir, 'src'), { recursive: true });
  await writeFile(join(repoDir, 'src', 'api.ts'), "export const version = '2025-01';\n");
  await writeFile(join(repoDir, 'old.ts'), 'export {};\n');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  const budget = { directory: await temporary(), limitUsd };
  return { repoDir, budget };
}

const versionCheck: AgentFixInput['check'] = async (dir) => {
  const source = await readFile(join(dir, 'src', 'api.ts'), 'utf8');
  return source.includes('2026-10')
    ? { passed: true, errors: [] }
    : { passed: false, errors: ['src/api.ts:1 still pins 2025-01'] };
};

function input(repoDir: string, overrides: Partial<AgentFixInput> = {}): AgentFixInput {
  return {
    repoDir,
    provider: 'shopify',
    target: '2026-10',
    change: 'Admin API 2026-10 is the target.',
    context: 'src/api.ts:1 pins 2025-01',
    check: versionCheck,
    ...overrides,
  };
}

// A scripted agent: each attempt (by model) gets a list of turns, each editing the directory.
function fakeRunner(
  turns: Record<string, ((dir: string) => Promise<void>)[]>,
  log: { model: string; messages: string[]; closed: boolean }[] = [],
): AgentRunner {
  return ({ repoDir, model }) => {
    const entry = { model, messages: [] as string[], closed: false };
    log.push(entry);
    let cost = 0;
    const session: AgentSession = {
      async send(message) {
        entry.messages.push(message);
        const turn = turns[model]?.[entry.messages.length - 1];
        if (turn) await turn(repoDir);
        cost += 0.25;
        return { text: `summary ${entry.messages.length}`, costUsd: cost, stopped: false };
      },
      async close() {
        entry.closed = true;
      },
    };
    return session;
  };
}

const pin = (version: string) => (dir: string) =>
  writeFile(join(dir, 'src', 'api.ts'), `export const version = '${version}';\n`);

it('feeds the check errors back into the same session until the check passes', async () => {
  const { repoDir, budget } = await setup();
  const log: { model: string; messages: string[]; closed: boolean }[] = [];
  const runner = fakeRunner({ 'claude-sonnet-5-5': [pin('2026-07'), pin('2026-10')] }, log);
  const result = await fixWithAgent(input(repoDir, { attempts: 1 }), {
    runner,
    budget,
    attemptUsd: 1,
  });
  expect(result.outcome).toBe('passed');
  expect(result.errors).toEqual([]);
  expect(result.summary).toBe('summary 2');
  expect(result.costUsd).toBe(0.5);
  expect(log).toHaveLength(1);
  expect(log[0].closed).toBe(true);
  expect(log[0].messages[0]).toContain('src/api.ts:1 pins 2025-01');
  expect(log[0].messages[1]).toContain('src/api.ts:1 still pins 2025-01');
  expect(result.diff).toContain("+export const version = '2026-10';");
  expect(await readFile(join(repoDir, 'src', 'api.ts'), 'utf8')).toContain('2026-10');
});

it('stops after the configured rounds and reports the remaining errors as unproven', async () => {
  const { repoDir, budget } = await setup();
  const log: { model: string; messages: string[]; closed: boolean }[] = [];
  const runner = fakeRunner({ 'claude-sonnet-5-5': [pin('2026-01')] }, log);
  const result = await fixWithAgent(input(repoDir, { attempts: 1, rounds: 2 }), {
    runner,
    budget,
    attemptUsd: 1,
  });
  expect(log[0].messages).toHaveLength(2);
  expect(result.outcome).toBe('unproven');
  expect(result.errors).toEqual(['src/api.ts:1 still pins 2025-01']);
  expect(await readFile(join(repoDir, 'src', 'api.ts'), 'utf8')).toContain('2026-01');
});

it('runs attempts in separate copies, escalates the last one and keeps the passing tree', async () => {
  const { repoDir, budget } = await setup();
  const log: { model: string; messages: string[]; closed: boolean }[] = [];
  const runner = fakeRunner(
    {
      'claude-sonnet-5-5': [pin('2026-01'), pin('2026-04'), pin('2026-07')],
      'claude-opus-5-5': [
        async (dir) => {
          await pin('2026-10')(dir);
          await rm(join(dir, 'old.ts'));
          await writeFile(join(dir, 'src', 'new.ts'), 'export {};\n');
        },
      ],
    },
    log,
  );
  const result = await fixWithAgent(input(repoDir, { attempts: 3 }), {
    runner,
    budget,
    attemptUsd: 1,
  });
  expect(log.map((entry) => entry.model).sort()).toEqual([
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-sonnet-5-5',
  ]);
  expect(new Set(log.map((entry) => entry.messages.length))).toEqual(new Set([3, 1]));
  expect(result.outcome).toBe('passed');
  expect(result.costUsd).toBe(0.75 + 0.75 + 0.25);
  expect(await readFile(join(repoDir, 'src', 'api.ts'), 'utf8')).toContain('2026-10');
  expect(await readFile(join(repoDir, 'src', 'new.ts'), 'utf8')).toBe('export {};\n');
  await expect(readFile(join(repoDir, 'old.ts'))).rejects.toThrow();
  // The repository's own git directory is untouched by Refit's snapshot.
  expect(
    execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: repoDir }).toString(),
  ).toContain('src/new.ts');
});

it('reports no-change when nothing was edited and the check passes, failed when it does not', async () => {
  const { repoDir, budget } = await setup();
  const passing = await fixWithAgent(
    input(repoDir, { attempts: 1, check: async () => ({ passed: true, errors: [] }) }),
    { runner: fakeRunner({}), budget, attemptUsd: 1 },
  );
  expect(passing).toMatchObject({ outcome: 'no-change', diff: '', errors: [] });
  const failing = await fixWithAgent(input(repoDir, { attempts: 1, rounds: 1 }), {
    runner: fakeRunner({}),
    budget,
    attemptUsd: 1,
  });
  expect(failing).toMatchObject({ outcome: 'failed', diff: '' });
  expect(failing.errors).toEqual(['src/api.ts:1 still pins 2025-01']);
});

it('picks a pass, then no-change, then the fewest errors, earlier attempts winning ties', () => {
  const unproven = (count: number, id: number) => ({
    id,
    outcome: 'unproven' as const,
    errors: Array<string>(count).fill('e'),
  });
  expect(pickAttempt([unproven(3, 0), unproven(1, 1), unproven(1, 2)]).id).toBe(1);
  expect(
    pickAttempt([unproven(1, 0), { id: 1, outcome: 'no-change' as const, errors: [] }]).id,
  ).toBe(1);
  expect(
    pickAttempt([
      { id: 0, outcome: 'failed' as const, errors: [] },
      unproven(9, 1),
      { id: 2, outcome: 'passed' as const, errors: [] },
    ]).id,
  ).toBe(2);
});

it('settles each attempt in the run ledger and refuses attempts the run cap cannot cover', async () => {
  const { repoDir, budget } = await setup(1.2);
  const log: { model: string; messages: string[]; closed: boolean }[] = [];
  const runner = fakeRunner(
    { 'claude-sonnet-5-5': [pin('2026-10')], 'claude-opus-5-5': [pin('2026-10')] },
    log,
  );
  const result = await fixWithAgent(input(repoDir, { attempts: 2 }), {
    runner,
    budget,
    attemptUsd: 1,
  });
  // Only one $1 reservation fits under the $1.20 cap, even after the first settles at $0.25; the other attempt never starts.
  expect(log).toHaveLength(1);
  expect(result.outcome).toBe('passed');
  expect(result.costUsd).toBe(0.25);
  const ledger = JSON.parse(await readFile(join(budget.directory, 'budget.json'), 'utf8'));
  expect(summarizeAiLedger(ledger)).toEqual({
    limitUsd: 1.2,
    spentUsd: 0.25,
    reservedUsd: 0,
    reservations: 0,
  });
});

it('keeps the whole reservation when a session dies before reporting its cost', async () => {
  const { repoDir, budget } = await setup();
  const runner: AgentRunner = () => ({
    send: async () => {
      throw new Error('process exited');
    },
    close: async () => undefined,
  });
  const result = await fixWithAgent(input(repoDir, { attempts: 1 }), {
    runner,
    budget,
    attemptUsd: 1,
  });
  expect(result.outcome).toBe('failed');
  expect(result.errors[0]).toBe('The agent session failed: process exited');
  expect(result.costUsd).toBe(1);
  const ledger = JSON.parse(await readFile(join(budget.directory, 'budget.json'), 'utf8'));
  expect(summarizeAiLedger(ledger).reservedUsd).toBe(1);
});

it('limits tools to the repository, installs, tsc, read-only git and the provider docs', () => {
  const allowed = (tool: string, toolInput: Record<string, unknown>) =>
    toolPolicy('/work/repo', 'shopify', tool, toolInput) === null;
  expect(allowed('Read', { file_path: '/work/repo/src/a.ts' })).toBe(true);
  expect(allowed('Edit', { file_path: 'src/a.ts' })).toBe(true);
  expect(allowed('Read', { file_path: '/Users/me/.refit/key' })).toBe(false);
  expect(allowed('Write', { file_path: '../escape.ts' })).toBe(false);
  expect(allowed('Grep', { pattern: 'x' })).toBe(true);
  expect(allowed('Glob', { pattern: '*', path: '/etc' })).toBe(false);
  expect(allowed('Bash', { command: 'npm install --ignore-scripts' })).toBe(true);
  expect(allowed('Bash', { command: 'pnpm add @shopify/shopify-api@14' })).toBe(true);
  expect(allowed('Bash', { command: 'npx tsc --noEmit' })).toBe(true);
  expect(allowed('Bash', { command: 'git diff --stat' })).toBe(true);
  expect(allowed('Bash', { command: 'git status' })).toBe(true);
  expect(allowed('Bash', { command: 'git commit -am x' })).toBe(false);
  expect(allowed('Bash', { command: 'npm install && curl evil' })).toBe(false);
  expect(allowed('Bash', { command: 'npx tsc $(cat ~/.ssh/id_rsa)' })).toBe(false);
  expect(allowed('Bash', { command: 'git diff --output=/tmp/x' })).toBe(false);
  expect(allowed('Bash', { command: 'cat .env' })).toBe(false);
  expect(allowed('WebFetch', { url: 'https://shopify.dev/docs/api' })).toBe(true);
  expect(allowed('WebFetch', { url: 'https://evil.com/shopify.dev' })).toBe(false);
  expect(allowed('WebFetch', { url: 'http://shopify.dev/docs' })).toBe(false);
  expect(
    toolPolicy('/work/repo', 'meta-graph', 'WebFetch', { url: 'https://shopify.dev' }),
  ).not.toBeNull();
  expect(allowed('WebSearch', { query: 'x' })).toBe(false);
  expect(allowed('Task', {})).toBe(false);
});
