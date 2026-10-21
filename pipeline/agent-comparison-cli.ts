import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { readProviderAdapter } from './providers.ts';
import { removedRequestParameters } from './request-removals.ts';
import { runPipeline } from './run.ts';
import { readSpecification } from './specifications.ts';
import { stripePackageUpgrade, PACKAGE_FILES } from './stripe-package-upgrade.ts';
import { PipelineInputError } from './types.ts';
import { usageCostUsd } from './ai-budget.ts';
import { validateSourcePatch } from './validation.ts';
import { prepareDependencies } from './dependency-preparation.ts';

// Gives a headless coding agent each repository Refit did not validate, with the contract diff
// Refit computed, then puts the agent's patch through Refit's offline validation. Neither agent has
// network access: Claude Code only reads and edits files; Codex also runs commands in its sandbox.
const execute = promisify(execFile);
const USAGE =
  'Usage: tsx pipeline/agent-comparison-cli.ts --selection <selection.json> --output <new-dir> --budget <usd> [--agent claude|codex] [--model <id>] [--run-budget <usd>] [--max-turns N] [--env .env]';
const AGENT_TOOLS = 'Read,Edit,Write,Glob,Grep';
const DEFAULT_MODELS = { claude: 'claude-sonnet-5-5', codex: 'gpt-5.6-sol' };
const DEFAULT_RUN_BUDGET_USD = 2;
const DEFAULT_MAX_TURNS = 60;
const IMAGE = 'node:22-alpine';
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const CHANGELOG = resolve('docs/benchmarks/stripe-changelog');
const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

interface Selection {
  set: string;
  repo: string;
  // Benchmark root holding repos/<owner__repo>, and the Refit benchmark output that ran it.
  root: string;
  refitOutput: string;
  refit: { status: string; stage?: string; reason?: string; checks?: string };
}

interface RunConfiguration {
  repository: string;
  apiVersion: string;
  before: string;
  after: string;
  providerConfig: string;
  command: string[];
  compareTypeErrors?: boolean;
  generatedChecks?: unknown;
}

const { values } = parseArgs({
  options: {
    selection: { type: 'string' },
    output: { type: 'string' },
    budget: { type: 'string' },
    agent: { type: 'string' },
    model: { type: 'string' },
    env: { type: 'string' },
    'run-budget': { type: 'string' },
    'max-turns': { type: 'string' },
  },
});
if (!values.selection || !values.output || !values.budget) throw new PipelineInputError(USAGE);
const budget = Number(values.budget);
const runBudget = Number(values['run-budget'] ?? DEFAULT_RUN_BUDGET_USD);
if (!(budget > 0) || !(runBudget > 0))
  throw new PipelineInputError('--budget and --run-budget must be positive dollar amounts.');
const agentName = values.agent ?? 'claude';
if (agentName !== 'claude' && agentName !== 'codex')
  throw new PipelineInputError('--agent must be claude or codex.');
const model = values.model ?? DEFAULT_MODELS[agentName];
// Codex reports usage only when a run ends, so a run starts only while a whole run budget remains.
if (values.env) process.loadEnvFile(values.env);
if (agentName === 'codex' && !process.env.OPENAI_API_KEY)
  throw new PipelineInputError('--agent codex needs OPENAI_API_KEY, for example from --env.');
if (agentName === 'codex') usageCostUsd(model, ZERO_USAGE);
const output = resolve(values.output);
const selection = JSON.parse(await readFile(values.selection, 'utf8')) as Selection[];
const changelog = (
  JSON.parse(await readFile(join(CHANGELOG, 'index.json'), 'utf8')) as {
    changes: Record<string, string>;
  }
).changes;
await mkdir(output);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The same contract comparison Refit's scan used for this repository, written for a person.
async function brief(configuration: RunConfiguration) {
  const report = await runPipeline({
    repository: configuration.repository,
    before: configuration.before,
    after: configuration.after,
    apiVersion: configuration.apiVersion,
    providerConfig: configuration.providerConfig,
  });
  const [before, after] = await Promise.all([
    readSpecification(configuration.before),
    readSpecification(configuration.after),
  ]);
  const removals = removedRequestParameters(
    await readProviderAdapter(configuration.providerConfig),
    before.document,
    after.document,
  );
  const fields = report.changes.map((change) => `${change.schema}.${change.property}`);
  const pages = [...new Set(fields.map((field) => changelog[field]).filter(Boolean))];
  const notes = await Promise.all(
    pages.map(
      async (page) =>
        (JSON.parse(await readFile(join(CHANGELOG, page), 'utf8')) as { content: string }).content,
    ),
  );
  return {
    text: [
      `Upgrade this repository's Stripe integration from API version ${report.apiVersion.before} to ${report.apiVersion.after}.`,
      '',
      `Response fields the target version removes (schema.property), from Stripe's published OpenAPI documents for both versions, limited to the SDK methods this repository calls:`,
      ...fields.map((field) => `- ${field}`),
      '',
      'Request parameters the target version no longer accepts:',
      ...(removals.length
        ? removals.map((removal) => `- ${removal.resource}.${removal.method}: ${removal.parameter}`)
        : ['- none']),
      '',
      ...(notes.length ? ["Stripe's changelog entries for these changes:", '', ...notes] : []),
    ].join('\n'),
    target: report.apiVersion.after,
    fields: fields.length,
    removals: removals.length,
    notes: pages,
  };
}

const PROMPT = (contract: string) =>
  [
    contract,
    '',
    'Instructions:',
    '- Edit the code so it works against the target API version: move reads of removed fields to where Stripe now returns that data, replace removed request parameters, and set every literal Stripe `apiVersion` to the target.',
    '- Change only what the upgrade needs. Keep behavior the same.',
    '- Do not edit package.json or lockfiles: dependencies cannot be installed here. The stripe package is upgraded to the release for the target version for you after your edits.',
    agentName === 'claude'
      ? '- You cannot run commands.'
      : '- Commands run without network access, and dependencies are not installed.',
    '- When you are done, reply with a short summary of each change, and of anything you left for a person to decide.',
  ].join('\n');

interface AgentResult {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: typeof ZERO_USAGE;
}

// `codex exec --json` events, one per line.
interface CodexEvent {
  type: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  item?: { type?: string; text?: string };
  error?: { message?: string };
  message?: string;
}

// A clean environment, so the child uses no host session, user configuration or other credentials.
const baseEnvironment = () => ({
  HOME: process.env.HOME!,
  PATH: process.env.PATH!,
  USER: process.env.USER ?? '',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
});

async function runCodex(directory: string, prompt: string): Promise<AgentResult> {
  const home = await mkdtemp(join(tmpdir(), 'refit-codex-home-'));
  try {
    const run = execute(
      'codex',
      [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        '--ephemeral',
        '--sandbox',
        'workspace-write',
        '--model',
        model,
        '--json',
        prompt,
      ],
      {
        cwd: directory,
        env: { ...baseEnvironment(), CODEX_HOME: home, CODEX_API_KEY: process.env.OPENAI_API_KEY! },
        timeout: AGENT_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    // `codex exec` also reads a prompt from stdin and waits until it closes.
    run.child.stdin?.end();
    const { stdout } = await run.catch((error: { stdout?: string }) => {
      if (error.stdout) return { stdout: error.stdout };
      throw error;
    });
    const events = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as CodexEvent);
    const usage = events
      .filter((event) => event.type === 'turn.completed')
      .reduce<typeof ZERO_USAGE>(
        (total, event) => ({
          inputTokens: total.inputTokens + (event.usage?.input_tokens ?? 0),
          cachedInputTokens: total.cachedInputTokens + (event.usage?.cached_input_tokens ?? 0),
          cacheWriteInputTokens:
            total.cacheWriteInputTokens + (event.usage?.cache_write_input_tokens ?? 0),
          outputTokens: total.outputTokens + (event.usage?.output_tokens ?? 0),
          reasoningTokens: total.reasoningTokens + (event.usage?.reasoning_output_tokens ?? 0),
        }),
        ZERO_USAGE,
      );
    const failure = events.find((event) => event.type === 'turn.failed' || event.type === 'error');
    return {
      result: events.filter((event) => event.item?.type === 'agent_message').at(-1)?.item?.text,
      is_error: Boolean(failure),
      subtype: failure
        ? String(failure.error?.message ?? failure.message ?? failure.type)
        : 'success',
      total_cost_usd: usageCostUsd(model, usage),
      num_turns: events.filter((event) => event.type === 'item.completed').length,
      usage,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runClaude(directory: string, prompt: string, limit: number): Promise<AgentResult> {
  const { stdout } = await execute(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      model,
      '--tools',
      AGENT_TOOLS,
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--max-turns',
      values['max-turns'] ?? String(DEFAULT_MAX_TURNS),
      '--max-budget-usd',
      limit.toFixed(2),
    ],
    {
      cwd: directory,
      env: baseEnvironment(),
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).catch((error: { stdout?: string }) => {
    // A run that hits its turn or budget limit exits non-zero but still reports its result.
    if (error.stdout) return { stdout: error.stdout };
    throw error;
  });
  return JSON.parse(stdout) as AgentResult;
}

async function git(directory: string, args: string[]) {
  return (await execute('git', args, { cwd: directory, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

const results: Record<string, unknown>[] = [];
let spent = 0;
for (const [index, entry] of selection.entries()) {
  const slug = entry.repo.replace('/', '__');
  const log = (stage: string) =>
    console.error(`[${index + 1}/${selection.length}] ${entry.repo}: ${stage}`);
  const result: Record<string, unknown> = { set: entry.set, repo: entry.repo, refit: entry.refit };
  results.push(result);
  const save = () =>
    writeFile(join(output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  if (spent >= budget || (agentName === 'codex' && spent + runBudget > budget)) {
    result.agent = { status: 'not-run', reason: `Budget of $${budget} reached.` };
    log('budget reached');
    await save();
    continue;
  }
  const configurationPath = join(entry.refitOutput, 'repos', slug, 'run.json');
  if (!existsSync(configurationPath)) {
    result.agent = { status: 'not-run', reason: 'Refit recorded no runnable checks.' };
    await save();
    continue;
  }
  const configuration = JSON.parse(await readFile(configurationPath, 'utf8')) as RunConfiguration;
  result.checks = configuration.compareTypeErrors ? 'typecheck' : configuration.command.join(' ');
  // Generated stripe-mock checks run only inside Refit's own migration workflow.
  result.generatedChecksSkipped = Boolean(configuration.generatedChecks);
  // Validation prepares the same committed dependencies, so a refusal here would refuse any patch;
  // the agent is not paid for. The prepared environment is cached for validation.
  try {
    await prepareDependencies({ repository: configuration.repository, image: IMAGE });
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    result.preparation = { status: 'refused', reason: message(error).slice(0, 600) };
    result.agent = { status: 'not-run', reason: 'Dependency preparation refused.' };
    log('preparation refused; agent not run');
    await save();
    continue;
  }
  const work = await mkdtemp(join(tmpdir(), 'refit-agent-'));
  try {
    const contract = await brief(configuration);
    result.brief = { fields: contract.fields, removals: contract.removals, notes: contract.notes };
    const checkout = join(work, 'checkout');
    await execute('git', ['clone', '-q', '--shared', configuration.repository, checkout]);
    const started = Date.now();
    const agent = await (
      agentName === 'codex'
        ? runCodex(checkout, PROMPT(contract.text))
        : runClaude(checkout, PROMPT(contract.text), Math.min(runBudget, budget - spent))
    ).catch((error: unknown): AgentResult => ({ is_error: true, result: message(error) }));
    spent += agent.total_cost_usd ?? 0;
    const touchedPackages = (await git(checkout, ['diff', '--name-only']))
      .split('\n')
      .filter((path) => PACKAGE_FILES.includes(path));
    if (touchedPackages.length) await git(checkout, ['checkout', '--', ...touchedPackages]);
    // Staged, so files the agent created are part of the patch.
    await git(checkout, ['add', '-A']);
    const agentDiff = await git(checkout, ['diff', '--cached']);
    result.agent = {
      status: agent.is_error ? 'error' : agentDiff ? 'patched' : 'no-change',
      stop: agent.subtype,
      turns: agent.num_turns,
      model,
      costUsd: agent.total_cost_usd ?? 0,
      ...(agent.usage ? { usage: agent.usage } : {}),
      seconds: Math.round((Date.now() - started) / 1000),
      summary: agent.result,
      revertedPackageEdits: touchedPackages,
      diff: agentDiff,
    };
    await writeFile(join(output, `${slug}.agent.patch`), agentDiff);
    log(`agent ${String((result.agent as { status: string }).status)} ($${spent.toFixed(2)})`);
    if (!agentDiff) {
      await save();
      continue;
    }
    // The same stripe-node release Refit's own patches move to; Refit's refusals apply.
    const upgrade = contract.target
      ? await stripePackageUpgrade(checkout, contract.target)
      : { reason: 'The report names no target API version.' };
    if ('upgrade' in upgrade) {
      for (const file of upgrade.upgrade.files)
        await writeFile(join(checkout, file.path), file.after);
      result.sdkUpgrade = { from: upgrade.upgrade.from, to: upgrade.upgrade.to };
    } else result.sdkUpgrade = { skipped: upgrade.reason };
    await git(checkout, ['add', '-A']);
    const diff = await git(checkout, ['diff', '--cached']);
    await writeFile(join(output, `${slug}.patch`), diff);
    const validation = await validateSourcePatch({
      repository: configuration.repository,
      propose: async () => diff,
      image: IMAGE,
      command: configuration.command,
      prepareDependencies: true,
      compareTypeErrors: configuration.compareTypeErrors,
    });
    result.validation = {
      status: validation.status,
      ...('baseline' in validation
        ? {
            baseline: validation.baseline.status,
            patched: validation.patched.status,
            patchedOutput: `${validation.patched.stdout}\n${validation.patched.stderr}`.slice(
              -6000,
            ),
          }
        : {}),
    };
    log(`validation ${validation.status}`);
  } catch (error) {
    result.error = message(error);
    log(`error: ${message(error)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await save();
}
console.log(`Spent $${spent.toFixed(2)} of $${budget}. Results: ${join(output, 'results.json')}`);
