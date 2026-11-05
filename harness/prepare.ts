// The repo's own codegen, run before the baseline. Install scripts stay off for dependencies, so a
// client the repo's postinstall or prepare would generate (Prisma's, GraphQL's, protobuf's) is
// missing and its checks fail before any edit. A model reads the repo's scripts and config and names
// the steps and any placeholder env its checks need; the harness runs them inside the sandbox, and
// the PR lists them.
import { query } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { usageCostUsd, type BudgetLedger } from './ledger.ts';
import { redactSecrets } from './secrets.ts';
import type { CheckCommand, Sandbox } from './types.ts';

// Haiku: reading scripts for codegen steps needs no more, and Sonnet's plan was a quarter of a fix's cost.
export const PREPARE_MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 3000;
const STEP_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 2000;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.pnpm-store',
  'dist',
  'build',
  '.next',
  'vendor',
]);
const CONFIG_FILE =
  /^(schema\.prisma|codegen\.(ya?ml|ts|js|json)|buf\.gen\.ya?ml|buf\.ya?ml|graphql\.config\.\w+|\.graphqlrc(\.\w+)?|orval\.config\.\w+|openapitools\.json|Makefile|justfile|turbo\.json|nx\.json|\.env\.(example|sample|template|dist)|drizzle\.config\.\w+|wrangler\.toml|vite\.config\.\w+|next\.config\.\w+)$/;

export type PlannedStep = { command: string; why: string };
export type Plan = { steps: PlannedStep[]; env: Record<string, string>; reasoning: string };
export type PreparedStep = PlannedStep & { code: number; output: string };
export type Preparation = {
  steps: PreparedStep[];
  env: Record<string, string>;
  reasoning: string;
  error?: string;
  // Repo files the steps changed. They stay out of the PR, so the PR names them.
  changedFiles?: string[];
};

// Picks the steps from what the repo shows. Injected so tests and the screen's dry runs spend $0.
export type PlanPreparation = (evidence: string, ledger: BudgetLedger) => Promise<Plan>;

async function* configFiles(dir: string, depth = 0): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 4 && !SKIP_DIRS.has(entry.name)) yield* configFiles(full, depth + 1);
    } else if (entry.name === 'package.json' || CONFIG_FILE.test(entry.name)) {
      yield full;
    } else if (entry.name.endsWith('.proto') || entry.name.endsWith('.graphql')) {
      yield full;
    }
  }
}

// What a model needs to pick the codegen: every manifest's scripts, the codegen configs, env
// templates and the README's lines about generating or building. Capped, and redacted.
export async function gatherEvidence(dir: string, checks: CheckCommand[]): Promise<string> {
  const parts: string[] = [
    `Checks the harness will run: ${checks.map((c) => `${c.name}: \`${c.command}\``).join('; ') || 'none detected'}`,
  ];
  let schemas = 0;
  for await (const file of configFiles(dir)) {
    const name = path.relative(dir, file);
    if (file.endsWith('.proto') || file.endsWith('.graphql')) {
      if (schemas++ < 20) parts.push(`(schema file) ${name}`);
      continue;
    }
    const text = await readFile(file, 'utf8').catch(() => '');
    parts.push(`--- ${name} ---\n${text.slice(0, name.endsWith('package.json') ? 4000 : 2500)}`);
    if (parts.join('\n').length > 40_000) break;
  }
  for (const readme of ['README.md', 'readme.md', 'CONTRIBUTING.md']) {
    const text = await readFile(path.join(dir, readme), 'utf8').catch(() => '');
    const lines = text
      .split('\n')
      .filter((line) => /generat|codegen|prisma|protoc|buf |graphql|env|build|setup/i.test(line));
    if (lines.length)
      parts.push(`--- ${readme} (matching lines) ---\n${lines.slice(0, 60).join('\n')}`);
  }
  return redactSecrets(parts.join('\n\n')).slice(0, 50_000);
}

const SYSTEM = `You prepare a code repository so its own checks (type check, build, tests) can run in a sandbox before anyone edits it.

The sandbox already installed dependencies with install scripts OFF, so nothing in any package's postinstall, prepare or install hook ran, including the repo's own. Name the steps that the repo's own setup would have run and that its checks need: for example \`npx prisma generate\`, \`npx graphql-codegen\`, \`buf generate\`, a protoc step, the repo's own "postinstall", "prepare", "generate" or "codegen" script, or a workspace package's build that other packages import from, or installing a subfolder project's dependencies when the checks run there (for example \`cd client && npm ci --ignore-scripts\`; install scripts stay off).

Rules:
- Only the repo's own codegen and build preparation. Never run a dependency's install script, never deploy, never call a live service or database migration against a real server.
- Don't run the checks themselves; the harness runs them next.
- Commands run from the repo root in a POSIX shell with the repo's package manager available (npm, npx, corepack pnpm/yarn, python3).
- env: placeholder values for environment variables the checks need just to load or build (for example DATABASE_URL=postgresql://user:pass@localhost:5432/db or OPENAI_API_KEY=placeholder), read from the env templates or the code. Never a real secret. Leave it empty when nothing needs one.
- Never edit the repo's source files: a check that fails because of the repo's own code stays failing.
- When you are shown checks that failed before any edit, name only what addresses an environmental cause: generated code, an env var read at build or test time, a workspace package that must be built first, a tool the repo expects. If the cause is the repo's own code, return nothing.
- When nothing is needed, return no steps. You are a shortcut, not a gate: be concrete and brief.`;

const SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { command: { type: 'string' }, why: { type: 'string' } },
        required: ['command', 'why'],
        additionalProperties: false,
      },
    },
    env: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'string' } },
        required: ['name', 'value'],
        additionalProperties: false,
      },
    },
    reasoning: { type: 'string' },
  },
  required: ['steps', 'env', 'reasoning'],
  additionalProperties: false,
};

const planFromAnswer = (answer: {
  steps?: PlannedStep[];
  env?: { name: string; value: string }[];
  reasoning?: string;
}): Plan => ({
  steps: answer.steps ?? [],
  env: Object.fromEntries((answer.env ?? []).map(({ name, value }) => [name, value])),
  reasoning: answer.reasoning ?? '',
});

// With no API key, the same call through the Agent SDK on the machine's logged-in credentials. The
// charge is the SDK's own estimate.
async function loginPlan(evidence: string, ledger: BudgetLedger, model: string): Promise<Plan> {
  for await (const message of query({
    prompt: evidence,
    options: {
      model,
      systemPrompt: SYSTEM,
      tools: [],
      outputFormat: { type: 'json_schema', schema: SCHEMA },
      maxBudgetUsd: Math.max(ledger.remainingUsd, 0.01),
      settingSources: [],
      persistSession: false,
    },
  })) {
    if (message.type !== 'result') continue;
    ledger.charge({ model, costUsd: message.total_cost_usd, note: 'codegen plan' });
    if (message.subtype !== 'success') throw new Error(`plan ended with ${message.subtype}`);
    return planFromAnswer(message.structured_output as Parameters<typeof planFromAnswer>[0]);
  }
  throw new Error('plan returned no result');
}

// The real planner: one Messages API call, charged to the task's ledger.
export const planWith =
  (model: string): PlanPreparation =>
  async (evidence, ledger) => {
    ledger.assertCanSpend();
    if (!process.env.ANTHROPIC_API_KEY) return loginPlan(evidence, ledger, model);
    const client = new Anthropic({ maxRetries: 2 });
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: evidence }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
    ledger.charge({
      model,
      costUsd: usageCostUsd(model, response.usage),
      note: 'codegen plan',
    });
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return planFromAnswer(JSON.parse(text));
  };

export const modelPlan = planWith(PREPARE_MODEL);

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

// A command with the placeholder env exported first, so compound commands see it too.
export function withEnv(command: string, env: Record<string, string>): string {
  const names = Object.keys(env).filter((name) => VALID_NAME.test(name));
  if (names.length === 0) return command;
  return `export ${names.map((name) => `${name}=${shellQuote(env[name] as string)}`).join(' ')}; ${command}`;
}

// Runs planned steps in the sandbox. Used again on the second, untouched copy for agent checks.
export async function runSteps(sandbox: Sandbox, plan: Plan): Promise<PreparedStep[]> {
  const done: PreparedStep[] = [];
  for (const step of plan.steps) {
    const result = await sandbox.exec(withEnv(step.command, plan.env), {
      timeoutMs: STEP_TIMEOUT_MS,
    });
    done.push({
      ...step,
      code: result.timedOut ? 124 : result.code,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-OUTPUT_TAIL),
    });
  }
  return done;
}

// Plans and runs the repo's codegen. Never throws: a planner failure leaves the repo as installed.
export async function prepareRepo(
  sandbox: Sandbox,
  checks: CheckCommand[],
  ledger: BudgetLedger,
  plan: PlanPreparation = modelPlan,
  failures?: string,
): Promise<Preparation> {
  let planned: Plan;
  try {
    const evidence = await gatherEvidence(sandbox.dir, checks);
    planned = await plan(
      failures
        ? `${evidence}\n\nThese checks failed before any edit, after the steps already run:\n${redactSecrets(failures)}`
        : evidence,
      ledger,
    );
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    return { steps: [], env: {}, reasoning: '', error: `no codegen plan: ${message}` };
  }
  return { ...planned, steps: await runSteps(sandbox, planned) };
}

// One line per step for the PR, so a reviewer sees exactly what ran before the baseline.
export function preparationNotes(prep: Preparation): string[] {
  const steps = prep.steps.map(
    (step) =>
      `Before the baseline the harness ran \`${step.command}\` (${step.why}); it exited ${step.code}.`,
  );
  const env = Object.keys(prep.env).length
    ? [`Checks ran with placeholder env: ${Object.keys(prep.env).join(', ')}.`]
    : [];
  const changed = prep.changedFiles?.length
    ? [`Preparation changed repo files, kept out of this PR: ${prep.changedFiles.join(', ')}.`]
    : [];
  return [...steps, ...env, ...changed, ...(prep.error ? [prep.error] : [])];
}
