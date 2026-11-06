import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dockerfileProblems,
  failingCheckers,
  gradeValidators,
  runPassed,
  validateDockerfile,
  validateModelRequest,
  validateWorkflow,
} from './validators.ts';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const dirs: string[] = [];
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'refit-validators-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('gradeValidators', () => {
  const claim = (name: string, passed = true) => ({ name, passed, detail: '' });

  it('passes a claim only when its recorded call passed', () => {
    const runs = [
      { tool: 'stripe__check_params', output: 'invalid param: source', passed: false },
      { tool: 'stripe__check_params', output: 'params valid', passed: true },
    ];
    expect(gradeValidators([claim('check_params')], runs)).toEqual([
      { name: 'check_params', ran: true, passed: true, detail: 'params valid' },
    ]);
    expect(gradeValidators([claim('check_params')], runs.slice(0, 1))[0].passed).toBe(false);
    expect(gradeValidators([claim('check_params', false)], runs)[0].passed).toBe(false);
  });

  it('matches a claim by its bare, provider or SDK tool name', () => {
    const runs = [
      { tool: 'openai__openai_check_request', output: 'Unknown parameters: none.', passed: true },
    ];
    for (const name of [
      'openai_check_request',
      'openai__openai_check_request',
      'mcp__refit__openai__openai_check_request',
    ]) {
      expect(gradeValidators([claim(name)], runs)[0], name).toMatchObject({
        ran: true,
        passed: true,
      });
    }
  });

  it('fails a claim with no recorded call', () => {
    expect(gradeValidators([claim('live_call')], [])[0]).toMatchObject({
      ran: false,
      passed: false,
    });
  });

  it('reads failure from tool text', () => {
    expect(runPassed('params valid for 2026-10-01')).toBe(true);
    expect(runPassed('error: network down')).toBe(false);
    expect(runPassed('2 fields failed validation')).toBe(false);
    expect(runPassed('{"valid": false}')).toBe(false);
  });

  // Trimmed from the provider tool packs' real output on 2026-11-01.
  it('reads the problem lines the provider packs print', () => {
    const clean = [
      'Result: 0 error(s), 0 warning(s), 0 note(s); 2 field(s) checked.\nNo problems found in the checked fields.',
      'Deprecated parameters: none found.\nUnknown parameters: none.\nRequired parameters present (messages, model).\nModel gpt-6-luna: active.',
      'Operation: POST /v1/checkout/sessions (PostCheckoutSessions).\nNo problems found against this spec for the params given.',
      '## gpt-6-luna\nStatus: active as far as the snapshot shows (listed on the models page).',
      'Endpoint note (supported): Chat Completions remains supported, but Responses is recommended for new projects.',
      'No known old-SDK call shapes matched. That is not proof the code is current: the patterns are a hint list.',
      'Product status: current.\nNote: The older 2008 version reached End of Life on 2023-12-15.',
    ];
    for (const output of clean) expect(runPassed(output), output).toBe(true);
    const problems = [
      'Result: 1 error(s), 0 warning(s), 0 note(s); 1 field(s) checked.\n- line 1:10 error: Field "nameThatDoesNotExist" does not exist on type Shop.',
      'Unknown parameters:\n- bogus_param: not a top-level parameter of POST /chat/completions in the spec.',
      'Deprecated or legacy parameters:\n- max_tokens: deprecated in spec.',
      'Required by the spec but missing: messages',
      'Reasoning model: temperature is not supported when reasoning effort is not none.',
      'Unknown params (not in the spec for this operation):\n- payment_method_types',
      'Required params missing: line_items.',
      'Enum mismatch: mode = "subscriptions" is not one of [payment, setup, subscription].',
      '## gpt-4o-2024-08-06\nStatus (as of 2026-11-01): deprecated, shutdown scheduled 2027-01-14',
      "Endpoint note (legacy): Completions is a legacy endpoint (the model pages label it 'Completions (legacy)').",
      'Old SDK shapes found:\n- [node] Configuration -> new OpenAI({ apiKey })',
      'Version used: v2 (path prefix /v2).\nProduct status: end-of-life (EOL date 2022-07-25).',
      'Version v1 status: deprecated.',
      '- v23.0 (2025-05-29) [marketing] field `instagram_actor_id`: removed -> ig_user_id',
      'Model gpt-9-ultra-made-up: not in snapshot (see openai_model_lookup for closest matches).',
      '2099-01-01.madeup is not in the snapshot (retrieved 2026-11-01). It may be newer than the snapshot or mistyped.',
    ];
    for (const output of problems) expect(runPassed(output), output).toBe(false);
  });
});

describe('failingCheckers', () => {
  it('lists check and validate tools whose latest call failed, claimed or not', () => {
    const runs = [
      { tool: 'stripe__stripe_check_params', output: 'Unknown params', passed: false },
      { tool: 'stripe__stripe_check_params', output: 'No problems found', passed: true },
      { tool: 'shopify__shopify_validate_graphql', output: 'Result: 1 error(s)', passed: false },
      { tool: 'openai__openai_model_lookup', output: 'Status: deprecated', passed: false },
    ];
    expect(failingCheckers(runs)).toEqual(['shopify__shopify_validate_graphql']);
  });
});

describe('validateModelRequest', () => {
  const good = {
    model: 'claude-sonnet-5-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Summarise this ticket.' }],
  };

  it('passes a well-formed request for the replacement model without a live call', async () => {
    const result = await validateModelRequest({ provider: 'anthropic', request: good });
    expect(result.passed).toBe(true);
    expect(result.evidence).toContain('no live call: no test key was supplied');
  });

  it('names the shapes the replacement model rejects', async () => {
    const result = await validateModelRequest({
      provider: 'anthropic',
      request: {
        ...good,
        model: 'claude-opus-5-5',
        temperature: 0.2,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        tool_choice: { type: 'tool', name: 'extract' },
        messages: [...good.messages, { role: 'assistant', content: '{' }],
      },
    });
    expect(result.passed).toBe(false);
    const text = result.problems.join('\n');
    expect(text).toMatch(/temperature/);
    expect(text).toMatch(/budget_tokens/);
    expect(text).toMatch(/forced `tool_choice`/);
    expect(text).toMatch(/prefill/);
  });

  it('flags a model the price table does not know', async () => {
    const result = await validateModelRequest({
      provider: 'anthropic',
      request: { ...good, model: 'claude-3-opus-20240229' },
    });
    expect(result.problems.join()).toMatch(/not in the price table/);
  });

  it('checks OpenAI request shapes and says so for unknown providers', async () => {
    const openai = await validateModelRequest({
      provider: 'openai',
      request: { model: 'gpt-5.1', input: 'hi' },
    });
    expect(openai.passed).toBe(true);
    const bad = await validateModelRequest({ provider: 'openai', request: { model: 'gpt-5.1' } });
    expect(bad.passed).toBe(false);
    const other = await validateModelRequest({ provider: 'mistral', request: { model: 'x' } });
    expect(other.passed).toBe('unknown');
  });

  it('makes a capped live call only with a supplied test key, and never shows the key', async () => {
    // Illustrative fake key and fake API: no real call is made.
    const key = 'sk-ant-test-0000000000000000000000000000';
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
      [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
      });
      return new Response(`{"error":"bad key ${key}"}`, { status: 401 });
    }) as unknown as typeof fetch;
    const result = await validateModelRequest({
      provider: 'anthropic',
      request: good,
      testKey: key,
      fetch: fakeFetch,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].body.max_tokens).toBe(16);
    expect(calls[0].headers['x-api-key']).toBe(key);
    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.problems.join()).toMatch(/returned 401/);
  });
});

describe('validateDockerfile', () => {
  it('parses instructions, continuations and heredocs', () => {
    expect(
      dockerfileProblems(
        [
          'ARG NODE=20',
          'FROM node:${NODE}-bookworm AS build',
          'RUN apt-get update \\',
          '  && apt-get install -y git',
          'RUN <<EOF',
          'echo not an instruction',
          'EOF',
          'COPY . .',
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(dockerfileProblems('RUN echo hi\nFROM node:20')).toEqual([
      'line 1: the first instruction must be FROM',
    ]);
    expect(dockerfileProblems('FROM node:20\nRUNN echo')).toEqual([
      'line 2: unknown instruction RUNN',
    ]);
  });

  it('reports unknown, not passed, when it cannot build', async () => {
    const dir = await fixture({ Dockerfile: 'FROM node:22-bookworm\nCOPY . /app\n' });
    const result = await validateDockerfile({ dir, build: false });
    expect(result.passed).toBe('unknown');
    expect(result.evidence.join()).toMatch(/not built/);
    expect((await validateDockerfile({ dir, file: 'missing.Dockerfile' })).passed).toBe(false);
  });

  it.skipIf(!dockerAvailable())(
    'builds a Dockerfile with Docker',
    async () => {
      const dir = await fixture({ Dockerfile: 'FROM node:22-bookworm\nRUN node -v\n' });
      const result = await validateDockerfile({ dir });
      expect(result.passed).toBe(true);
      expect(result.evidence.join()).toMatch(/docker build exited 0/);
    },
    20 * 60 * 1000,
  );
});

describe('validateWorkflow', () => {
  const workflow = [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v5',
    '      - uses: actions/setup-node@v5',
    '        with: { node-version: 22 }',
    '      - run: npm test',
  ].join('\n');

  it('parses a workflow and checks its shape', async () => {
    const dir = await fixture({ '.github/workflows/ci.yml': workflow });
    const result = await validateWorkflow({ dir, file: '.github/workflows/ci.yml' });
    // PyYAML is optional on the host: without it the check is honest about not parsing.
    if (result.passed === 'unknown') expect(result.evidence.join()).toMatch(/not parsed/);
    else expect(result).toMatchObject({ passed: true, problems: [] });
  });

  it('reports a broken workflow', async () => {
    const dir = await fixture({
      'bad.yml': 'on: push\njobs:\n  test:\n    steps:\n      - uses: actions/checkout\n',
      'tabs.yml': 'on: push\njobs:\n\ttest: {}\n',
      'broken.yml': 'on: [push\njobs: {',
    });
    const bad = await validateWorkflow({ dir, file: 'bad.yml' });
    if (bad.passed !== 'unknown') {
      expect(bad.problems).toEqual([
        'job test has neither runs-on nor uses',
        'job test step 1: actions/checkout pins no version',
      ]);
      expect((await validateWorkflow({ dir, file: 'broken.yml' })).problems.join()).toMatch(
        /does not parse/,
      );
    }
    expect((await validateWorkflow({ dir, file: 'tabs.yml' })).problems).toEqual([
      'YAML indentation must not use tabs',
    ]);
  });
});
