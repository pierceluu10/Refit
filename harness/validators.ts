// A provider validator counts as proof only when the harness recorded the ToolPack call itself.
// What the agent says in finish is a claim; it is shown in the PR but never grades the run.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveModelId } from '../shared/models.ts';
import type { ProofResult } from '../shared/types.ts';
import { dockerAvailable, runHost } from './sandbox.ts';
import { redactSecrets } from './secrets.ts';
import type { FinishReport, ValidatorRun } from './types.ts';

// shortcut: ToolPack tools return free text, so pass/fail is read from the problem lines the provider
// packs print; use a structured result once the packs return one. Matching too much only costs a
// verified grade; matching too little would grade a validator that found problems as proof.
const PROBLEMS = [
  /^error:|\binvalid\b|\bfail(?:s|ed|ure|ures)?\b|"valid"\s*:\s*false/i,
  /\b[1-9]\d* error\(s\)/, // shopify_validate_graphql: "Result: 1 error(s), 0 warning(s)"
  /^unknown param(?:eter)?s\b(?!: none)/im, // openai_check_request, stripe_check_params
  /^(?:deprecated or legacy parameters|deprecated in the spec):/im,
  /^(?:required by the spec but missing|required params missing):/im,
  /^enum mismatch:/im,
  /\bis not (?:supported|compatible)\b/i, // openai_check_request on reasoning models
  /^endpoint note \((?!supported\b)/im, // openai_check_request: legacy, deprecated or shut down
  /^old sdk shapes found:/im, // openai_sdk_migration
  /^status\b[^:\n]*:\s*(?:deprecated|shut down)/im, // openai_model_lookup on a retiring model
  /^(?:product|version \S+) status:\s*(?:deprecated|end-of-life|retired|sunset)/im, // twilio_endpoint_lookup
  /`:\s*(?:removed|renamed|deprecated)\b/, // meta_lookup_field: "field `x`: removed -> y"
  /\bnot in (?:the )?snapshot\b/i, // an unknown model, version or endpoint in any pack
];

export const runPassed = (output: string) => !PROBLEMS.some((problem) => problem.test(output));

export type ValidatorGrade = { name: string; ran: boolean; passed: boolean; detail: string };

// The model sees the harness tools through the SDK's MCP server, so it may claim one by that full name.
export const claimMatches = (claim: string, tool: string) => {
  const name = claim.replace(/^mcp__refit__/, '');
  return tool === name || tool.endsWith(`__${name}`);
};

// One grade per claimed validator, from the latest recorded call of that tool.
export function gradeValidators(
  claims: FinishReport['validators'],
  runs: ValidatorRun[],
): ValidatorGrade[] {
  return claims.map((claim) => {
    const run = runs.filter((candidate) => claimMatches(claim.name, candidate.tool)).at(-1);
    if (!run) {
      return {
        name: claim.name,
        ran: false,
        passed: false,
        detail: 'claimed by the agent, but the harness recorded no call of it',
      };
    }
    const detail = run.output.trim().split('\n')[0].slice(0, 200);
    return { name: claim.name, ran: true, passed: claim.passed && run.passed, detail };
  });
}

// Provider checkers (a check or validate tool) whose latest call reported problems. They block
// verified even when the agent leaves them out of finish; lookups and docs searches only inform.
export function failingCheckers(runs: ValidatorRun[]): string[] {
  const latest = new Map(runs.map((run) => [run.tool, run]));
  return [...latest.values()]
    .filter((run) => /check|validat/i.test(run.tool) && !run.passed)
    .map((run) => run.tool);
}

// ---------------------------------------------------------------------------------------------------
// Upgrade validators: tools the agent calls to check its own work. Each returns a ProofResult-shaped
// verdict with the evidence it saw; `passed: 'unknown'` says honestly that something could not run.

export type UpgradeValidation = ProofResult & { problems: string[] };

const verdict = (
  check: string,
  problems: string[],
  evidence: string[],
  unknown = false,
): UpgradeValidation => ({
  check,
  passed: problems.length > 0 ? false : unknown ? 'unknown' : true,
  problems,
  evidence,
});

// Models that reject these request shapes (claude-api skill, cached 2026-10-06).
const NO_FORCED_TOOL = /^claude-(?:opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)/;
const NO_DISABLED_THINKING = /^claude-(?:opus-5-5|sonnet-5-5|fable-5)/;
const NO_BUDGET_TOKENS = /^claude-(?:fable-5|opus-5|opus-4-[78]|sonnet-5|haiku-5)/;
const NO_PREFILL = /^claude-(?:fable-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function anthropicRequestProblems(request: Json): string[] {
  const problems: string[] = [];
  const model = typeof request.model === 'string' ? request.model : '';
  if (!model) problems.push('`model` is missing or not a string');
  else if (!resolveModelId(model)) {
    problems.push(`model "${model}" is not in the price table (shared/models.ts); is it current?`);
  }
  const maxTokens = request.max_tokens;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0) {
    problems.push('`max_tokens` must be a positive integer');
  }
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push('`messages` must be a non-empty array');
  } else {
    messages.forEach((message, index) => {
      if (!isObject(message)) return problems.push(`messages[${index}] is not an object`);
      const role = message.role;
      if (!['user', 'assistant', 'system'].includes(role as string)) {
        problems.push(`messages[${index}].role "${String(role)}" is not user, assistant or system`);
      }
      if (index === 0 && role !== 'user') problems.push('the first message must be from the user');
      if (message.content === undefined) problems.push(`messages[${index}].content is missing`);
    });
    const last = messages.at(-1);
    if (isObject(last) && last.role === 'assistant' && NO_PREFILL.test(model)) {
      problems.push(`${model} rejects an assistant prefill as the last message`);
    }
  }
  for (const param of ['temperature', 'top_p', 'top_k']) {
    if (param in request) {
      problems.push(`\`${param}\` is rejected on every model from API version 2026-10-21`);
    }
  }
  if ('output_format' in request) {
    problems.push('`output_format` is deprecated; use `output_config.format`');
  }
  const thinking = request.thinking;
  if (isObject(thinking)) {
    if (thinking.type === 'enabled' || 'budget_tokens' in thinking) {
      if (NO_BUDGET_TOKENS.test(model)) {
        problems.push(
          `${model} rejects \`thinking.budget_tokens\`; use adaptive thinking and effort`,
        );
      }
    }
    if (thinking.type === 'disabled' && NO_DISABLED_THINKING.test(model)) {
      problems.push(`${model} rejects \`thinking: {type: "disabled"}\`; lower effort instead`);
    }
  }
  const toolChoice = request.tool_choice;
  if (isObject(toolChoice) && ['any', 'tool'].includes(toolChoice.type as string)) {
    if (NO_FORCED_TOOL.test(model)) {
      problems.push(
        `${model} rejects forced \`tool_choice\` "${String(toolChoice.type)}"; use auto`,
      );
    }
  }
  return problems;
}

export function openaiRequestProblems(request: Json): string[] {
  const problems: string[] = [];
  if (typeof request.model !== 'string' || !request.model) {
    problems.push('`model` is missing or not a string');
  }
  const hasMessages = Array.isArray(request.messages);
  const hasInput = typeof request.input === 'string' || Array.isArray(request.input);
  if (!hasMessages && !hasInput) {
    problems.push('needs `messages` (Chat Completions) or `input` (Responses)');
  }
  if (hasMessages) {
    (request.messages as unknown[]).forEach((message, index) => {
      if (!isObject(message) || typeof message.role !== 'string') {
        problems.push(`messages[${index}] needs a string role`);
      }
    });
  }
  return problems;
}

export type ModelRequestInput = {
  provider: 'anthropic' | 'openai' | string;
  request: Json; // the request body the code sends with the replacement model
  // A test key the customer supplied for this check. Without one, no live call is made. Never logged.
  testKey?: string;
  fetch?: typeof fetch;
};

const LIVE_MAX_TOKENS = 16;

// Does a model call still work with the replacement model? The request's shape always; a live call
// only with a test key the customer supplied, capped at a few output tokens.
export async function validateModelRequest(input: ModelRequestInput): Promise<UpgradeValidation> {
  const check = 'model-request';
  const request = isObject(input.request) ? input.request : {};
  const provider = input.provider.toLowerCase();
  const problems =
    provider === 'anthropic'
      ? anthropicRequestProblems(request)
      : provider === 'openai'
        ? openaiRequestProblems(request)
        : [];
  const evidence = [
    provider === 'anthropic' || provider === 'openai'
      ? `request shape checked against the ${provider} API rules Refit knows`
      : `no shape rules for provider "${input.provider}"; the request was not checked`,
  ];
  const known = provider === 'anthropic' || provider === 'openai';
  if (!input.testKey) {
    evidence.push('no live call: no test key was supplied');
    return verdict(check, problems, evidence, !known);
  }
  if (problems.length > 0 || !known) {
    evidence.push('no live call: the request shape has problems or the provider is unknown');
    return verdict(check, problems, evidence, !known);
  }
  const live = await liveCall(provider as 'anthropic' | 'openai', request, input);
  evidence.push(live.evidence);
  if (!live.ok) problems.push(live.evidence);
  return verdict(check, problems, evidence);
}

async function liveCall(
  provider: 'anthropic' | 'openai',
  request: Json,
  input: ModelRequestInput,
): Promise<{ ok: boolean; evidence: string }> {
  const doFetch = input.fetch ?? fetch;
  const key = input.testKey as string;
  const scrub = (text: string) => redactSecrets(text.split(key).join('[redacted]'));
  const responses = provider === 'openai' && 'input' in request;
  const url =
    provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/messages'
      : `https://api.openai.com/v1/${responses ? 'responses' : 'chat/completions'}`;
  const body =
    provider === 'anthropic'
      ? { ...request, max_tokens: LIVE_MAX_TOKENS, stream: false }
      : responses
        ? { ...request, max_output_tokens: LIVE_MAX_TOKENS, stream: false }
        : { ...request, max_completion_tokens: LIVE_MAX_TOKENS, stream: false };
  if (provider === 'openai') delete (body as Json).max_tokens;
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
      : { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = scrub(await response.text()).slice(0, 400);
    return response.ok
      ? { ok: true, evidence: `live call to ${url} with the test key returned ${response.status}` }
      : { ok: false, evidence: `live call to ${url} returned ${response.status}: ${text}` };
  } catch (error) {
    const message = scrub(error instanceof Error ? error.message : String(error));
    return { ok: false, evidence: `live call to ${url} failed: ${message}` };
  }
}

const DOCKERFILE_INSTRUCTIONS = new Set([
  'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT',
  'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL',
]); // prettier-ignore

export function dockerfileProblems(text: string): string[] {
  const problems: string[] = [];
  const instructions: { name: string; line: number; args: string }[] = [];
  const lines = text.split(/\r?\n/);
  let heredoc: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i];
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    if (/^\s*(#|$)/.test(line)) continue;
    while (/\\\s*$/.test(line) && i + 1 < lines.length)
      line = line.replace(/\\\s*$/, ' ') + lines[++i];
    const match = /^\s*([A-Za-z]+)\s*(.*)$/.exec(line);
    if (!match) {
      problems.push(`line ${start + 1}: not an instruction`);
      continue;
    }
    const name = match[1].toUpperCase();
    if (!DOCKERFILE_INSTRUCTIONS.has(name))
      problems.push(`line ${start + 1}: unknown instruction ${match[1]}`);
    const doc = /<<-?["']?(\w+)["']?/.exec(match[2]);
    if (doc && ['RUN', 'COPY', 'ADD'].includes(name)) heredoc = doc[1];
    instructions.push({ name, line: start + 1, args: match[2].trim() });
  }
  const first = instructions.find((instruction) => instruction.name !== 'ARG');
  if (!first) problems.push('no instructions');
  else if (first.name !== 'FROM')
    problems.push(`line ${first.line}: the first instruction must be FROM`);
  for (const from of instructions.filter((instruction) => instruction.name === 'FROM')) {
    if (!from.args) problems.push(`line ${from.line}: FROM needs an image`);
  }
  return problems;
}

export type DockerfileInput = {
  dir: string; // the build context: the sandbox copy, never the customer's checkout
  file?: string; // relative to dir, default Dockerfile
  build?: boolean; // default true: build it when Docker answers
  timeoutMs?: number;
};

// A Dockerfile builds: parsed always, built with Docker when a daemon answers. The build runs RUN
// steps in Docker's own build containers, never on the host.
export async function validateDockerfile(input: DockerfileInput): Promise<UpgradeValidation> {
  const check = 'dockerfile-builds';
  const file = input.file ?? 'Dockerfile';
  const text = await readFile(path.join(input.dir, file), 'utf8').catch(() => undefined);
  if (text === undefined) return verdict(check, [`${file} not found`], []);
  const problems = dockerfileProblems(text);
  const evidence = [
    `parsed ${file}: ${problems.length === 0 ? 'no problems' : `${problems.length} problem(s)`}`,
  ];
  if (problems.length > 0) return verdict(check, problems, evidence);
  if (input.build === false || !(await dockerAvailable())) {
    evidence.push(
      input.build === false ? 'not built: build was off' : 'not built: Docker is not available',
    );
    return verdict(check, problems, evidence, true);
  }
  const tag = `refit-validate-${randomBytes(6).toString('hex')}`;
  const timeoutMs = input.timeoutMs ?? 20 * 60_000;
  const built = await runHost('docker', ['build', '--pull', '-f', file, '-t', tag, '.'], {
    cwd: input.dir,
    timeoutMs,
  });
  await runHost('docker', ['rmi', '-f', tag], { timeoutMs: 60_000 });
  const tailText = `${built.stdout}\n${built.stderr}`.trimEnd().split('\n').slice(-15).join('\n');
  evidence.push(
    `docker build exited ${built.code}${built.timedOut ? ' (timed out)' : ''}:\n${tailText}`,
  );
  if (built.code !== 0) problems.push(`docker build failed with exit code ${built.code}`);
  return verdict(check, problems, evidence);
}

const PARSE_WORKFLOW = `
import json, sys, yaml
try:
    data = yaml.safe_load(sys.stdin.read())
except yaml.YAMLError as error:
    print(json.dumps({"error": str(error)}))
    sys.exit(0)
def keys(value):
    if isinstance(value, dict):
        return {("on" if k is True else str(k)): keys(v) for k, v in value.items()}
    if isinstance(value, list):
        return [keys(v) for v in value]
    return value
print(json.dumps({"data": keys(data)}, default=str))
`;

// GitHub Actions workflow structure: triggers, jobs with a runner or a reusable workflow, and steps
// that each use an action or run a command. Action refs should pin a version.
export function workflowProblems(data: unknown): string[] {
  if (!isObject(data)) return ['the workflow is not a mapping'];
  const problems: string[] = [];
  if (!('on' in data)) problems.push('missing `on` (the triggers)');
  if (!isObject(data.jobs) || Object.keys(data.jobs).length === 0) {
    problems.push('missing `jobs`');
    return problems;
  }
  for (const [id, job] of Object.entries(data.jobs)) {
    if (!isObject(job)) {
      problems.push(`job ${id} is not a mapping`);
      continue;
    }
    if (!('runs-on' in job) && !('uses' in job))
      problems.push(`job ${id} has neither runs-on nor uses`);
    const steps = job.steps;
    if (steps === undefined) continue;
    if (!Array.isArray(steps)) {
      problems.push(`job ${id}: steps is not a list`);
      continue;
    }
    steps.forEach((step, index) => {
      if (!isObject(step) || (!('uses' in step) && !('run' in step))) {
        problems.push(`job ${id} step ${index + 1} has neither uses nor run`);
      } else if (typeof step.uses === 'string') {
        const local = step.uses.startsWith('./') || step.uses.startsWith('docker://');
        if (!local && !step.uses.includes('@')) {
          problems.push(`job ${id} step ${index + 1}: ${step.uses} pins no version`);
        }
      }
    });
  }
  return problems;
}

// A workflow file parses (YAML via PyYAML's safe loader, which only reads data) and has the shape
// GitHub Actions needs. Without python3 and PyYAML it says it could not parse, rather than guessing.
export async function validateWorkflow(input: {
  dir: string;
  file: string;
}): Promise<UpgradeValidation> {
  const check = 'workflow-parses';
  const text = await readFile(path.join(input.dir, input.file), 'utf8').catch(() => undefined);
  if (text === undefined) return verdict(check, [`${input.file} not found`], []);
  if (text.split('\n').some((line) => /^ *\t/.test(line))) {
    return verdict(check, ['YAML indentation must not use tabs'], [`read ${input.file}`]);
  }
  const parsed = await parseYaml(text);
  if ('unavailable' in parsed) {
    return verdict(check, [], [`not parsed: ${parsed.unavailable}`], true);
  }
  if ('error' in parsed) return verdict(check, [`YAML does not parse: ${parsed.error}`], []);
  const problems = workflowProblems(parsed.data);
  return verdict(check, problems, [`parsed ${input.file} with PyYAML safe_load`]);
}

function parseYaml(
  text: string,
): Promise<{ data: unknown } | { error: string } | { unavailable: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'python3',
      ['-I', '-c', PARSE_WORKFLOW],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (/No module named .?yaml/.test(stderr))
          return resolve({ unavailable: 'PyYAML is not installed' });
        if (error && !stdout)
          return resolve({ unavailable: `python3 failed: ${error.message.split('\n')[0]}` });
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ unavailable: 'the parser printed no result' });
        }
      },
    );
    child.stdin?.end(text);
  });
}
