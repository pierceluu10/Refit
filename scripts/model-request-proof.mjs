#!/usr/bin/env node
// Request-level proof for replacement models (pipeline/model-request-proofs.ts). For every model in
// data/model-request-proofs.json it sends the smallest request each API accepts, then a JSON-output
// request, a forced tool call and a stream, and checks that each response parses. It also sends the
// parameters a retired model took that the replacement may reject (max_tokens, temperature, top_p,
// top_k) one at a time and records each one the provider refuses with HTTP 400.
//
// It runs only in refit-bench Actions with Refit's own keys from repository secrets
// (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY), never a customer's. A provider without a
// key stays pending with that reason. Keys are read from the environment and never printed; the
// output holds only model names, status codes and the names of checks.
//
// Usage: node scripts/model-request-proof.mjs --run <actions run URL> [--output <path>] [--provider openai]
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    output: { type: 'string', default: 'model-request-proofs.json' },
    provider: { type: 'string', multiple: true },
    table: {
      type: 'string',
      default: new URL('../data/model-request-proofs.json', import.meta.url).pathname,
    },
  },
});
if (
  !values.run ||
  !/^https:\/\/github\.com\/refit-dev\/refit-bench\/actions\/runs\/\d+$/.test(values.run)
)
  throw new Error('--run must be this refit-bench Actions run URL.');

const KEYS = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};
const SECRET = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};
// At most this many requests in one run, whatever the table holds.
const MAX_REQUESTS = 200;
const TIMEOUT_MS = 90_000;
const TOKENS = 512;
const PROMPT = 'Reply with the single word OK.';
const JSON_PROMPT = 'Return the JSON object {"ok": true} and nothing else.';
// A strict JSON schema for structured outputs (`response_format: json_schema`, `zodResponseFormat`).
const SCHEMA = {
  name: 'ok_result',
  strict: true,
  schema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
};
const TOOL = {
  name: 'report_ok',
  description: 'Reports that the request worked.',
  parameters: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
};
let requests = 0;

async function send(url, headers, body) {
  if (++requests > MAX_REQUESTS) throw new Error(`More than ${MAX_REQUESTS} requests; stopped.`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  return { status: response.status, text };
}

// Every `data:` line of a server-sent event stream parses as JSON (OpenAI's `[DONE]` aside).
function streamParses(text) {
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]');
  if (!data.length) return false;
  try {
    data.forEach((line) => JSON.parse(line));
    return true;
  } catch {
    return false;
  }
}

const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const jsonObject = (text) => {
  const value = parsed(String(text ?? '').trim());
  return value !== null && typeof value === 'object';
};

// One API: the requests to send and how to read their responses.
const APIS = {
  'chat.completions': {
    provider: 'openai',
    url: () => 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    limit: 'max_completion_tokens',
    base: (model, prompt = PROMPT) => ({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: TOKENS,
    }),
    ok: (body) => Array.isArray(body?.choices),
    json: (model) => ({
      ...APIS['chat.completions'].base(model, JSON_PROMPT),
      response_format: { type: 'json_object' },
    }),
    jsonOk: (body) => jsonObject(body?.choices?.[0]?.message?.content),
    schema: (model) => ({
      ...APIS['chat.completions'].base(model, JSON_PROMPT),
      response_format: { type: 'json_schema', json_schema: SCHEMA },
    }),
    schemaOk: (body) => typeof parsed(body?.choices?.[0]?.message?.content ?? '')?.ok === 'boolean',
    tools: (model) => ({
      ...APIS['chat.completions'].base(model),
      tools: [{ type: 'function', function: TOOL }],
      tool_choice: { type: 'function', function: { name: TOOL.name } },
    }),
    toolsOk: (body) =>
      jsonObject(body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments),
    stream: (model) => ({ ...APIS['chat.completions'].base(model), stream: true }),
    probes: { max_tokens: 256, temperature: 0.2, top_p: 0.5 },
    probe: (model, name, value) => {
      const body = APIS['chat.completions'].base(model);
      if (name === 'max_tokens') delete body.max_completion_tokens;
      return { ...body, [name]: value };
    },
  },
  responses: {
    provider: 'openai',
    url: () => 'https://api.openai.com/v1/responses',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    limit: 'max_output_tokens',
    base: (model, prompt = PROMPT) => ({ model, input: prompt, max_output_tokens: TOKENS }),
    ok: (body) => Array.isArray(body?.output),
    json: (model) => ({
      ...APIS.responses.base(model, JSON_PROMPT),
      text: { format: { type: 'json_object' } },
    }),
    jsonOk: (body) =>
      jsonObject(
        body?.output
          ?.flatMap((item) => item.content ?? [])
          .find((part) => part.type === 'output_text')?.text,
      ),
    schema: (model) => ({
      ...APIS.responses.base(model, JSON_PROMPT),
      text: { format: { type: 'json_schema', ...SCHEMA } },
    }),
    schemaOk: (body) =>
      typeof parsed(
        body?.output
          ?.flatMap((item) => item.content ?? [])
          .find((part) => part.type === 'output_text')?.text ?? '',
      )?.ok === 'boolean',
    tools: (model) => ({
      ...APIS.responses.base(model),
      tools: [{ type: 'function', ...TOOL }],
      tool_choice: { type: 'function', name: TOOL.name },
    }),
    toolsOk: (body) =>
      jsonObject(body?.output?.find((item) => item.type === 'function_call')?.arguments),
    stream: (model) => ({ ...APIS.responses.base(model), stream: true }),
    probes: { temperature: 0.2, top_p: 0.5 },
    probe: (model, name, value) => ({ ...APIS.responses.base(model), [name]: value }),
  },
  messages: {
    provider: 'anthropic',
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    limit: 'max_tokens',
    base: (model, prompt = PROMPT) => ({
      model,
      max_tokens: TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
    ok: (body) => Array.isArray(body?.content),
    tools: (model) => ({
      ...APIS.messages.base(model),
      tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }],
      tool_choice: { type: 'tool', name: TOOL.name },
    }),
    toolsOk: (body) => {
      const input = body?.content?.find((part) => part.type === 'tool_use')?.input;
      return input !== null && typeof input === 'object';
    },
    stream: (model) => ({ ...APIS.messages.base(model), stream: true }),
    probes: { temperature: 0.2, top_p: 0.5, top_k: 5 },
    probe: (model, name, value) => ({ ...APIS.messages.base(model), [name]: value }),
  },
  generateContent: {
    provider: 'gemini',
    url: (model, stream) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    headers: (key) => ({ 'x-goog-api-key': key }),
    limit: 'generationConfig.maxOutputTokens',
    base: (_model, prompt = PROMPT) => ({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: TOKENS },
    }),
    ok: (body) => Array.isArray(body?.candidates),
    json: (model) => {
      const body = APIS.generateContent.base(model, JSON_PROMPT);
      return {
        ...body,
        generationConfig: { ...body.generationConfig, responseMimeType: 'application/json' },
      };
    },
    jsonOk: (body) =>
      jsonObject(body?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text),
    tools: (model) => ({
      ...APIS.generateContent.base(model),
      tools: [{ functionDeclarations: [TOOL] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL.name] } },
    }),
    toolsOk: (body) => {
      const call = body?.candidates?.[0]?.content?.parts?.find(
        (part) => part.functionCall,
      )?.functionCall;
      return call?.name === TOOL.name && call.args !== null && typeof call.args === 'object';
    },
    stream: (model) => APIS.generateContent.base(model),
    probes: {},
    probe: () => null,
  },
};

async function prove(model, api) {
  const spec = APIS[api];
  const key = KEYS[spec.provider];
  const call = (body, stream = false) => send(spec.url(model, stream), spec.headers(key), body);
  const first = await call(spec.base(model));
  if (first.status !== 200 || !spec.ok(parsed(first.text)))
    return {
      pending: `The smallest request returned HTTP ${first.status}${first.status === 200 ? ' with a body Refit could not read' : ''} on ${new Date().toISOString().slice(0, 10)}.`,
    };
  const checks = { request: 'passed' };
  const failed = [];
  if (spec.json) {
    const result = await call(spec.json(model));
    if (result.status === 200 && spec.jsonOk(parsed(result.text))) checks.json = 'passed';
    else failed.push(`json (HTTP ${result.status})`);
  }
  if (spec.schema) {
    const result = await call(spec.schema(model));
    if (result.status === 200 && spec.schemaOk(parsed(result.text))) checks.schema = 'passed';
    else failed.push(`schema (HTTP ${result.status})`);
  }
  const tools = await call(spec.tools(model));
  if (tools.status === 200 && spec.toolsOk(parsed(tools.text))) checks.tools = 'passed';
  else failed.push(`tools (HTTP ${tools.status})`);
  const stream = await call(spec.stream(model), true);
  if (stream.status === 200 && streamParses(stream.text)) checks.stream = 'passed';
  else failed.push(`stream (HTTP ${stream.status})`);
  const rejected = [];
  for (const [name, value] of Object.entries(spec.probes)) {
    const result = await call(spec.probe(model, name, value));
    if (result.status === 400) rejected.push(name);
  }
  return { checks, failed, rejected, parameters: [spec.limit] };
}

const table = JSON.parse(await readFile(values.table, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const wanted = (provider) => !values.provider?.length || values.provider.includes(provider);
const targets = [
  ...table.proofs.map(({ provider, model, api }) => ({ provider, model, api })),
  ...table.pending.map(({ provider, model, api }) => ({ provider, model, api })),
];
const next = { formatVersion: 1, proofs: [], pending: [] };
const summary = [];
for (const target of targets) {
  const previous =
    table.proofs.find((item) => item.model === target.model && item.api === target.api) ??
    table.pending.find((item) => item.model === target.model && item.api === target.api);
  if (!wanted(target.provider)) {
    (previous.reason ? next.pending : next.proofs).push(previous);
    continue;
  }
  if (!KEYS[target.provider]) {
    const reason = `Blocked: refit-dev/refit-bench has no ${SECRET[target.provider]} repository secret, so Refit cannot send the request with its own key.`;
    next.pending.push({ ...target, reason });
    summary.push(`${target.model} ${target.api}: pending, no key`);
    continue;
  }
  let result;
  try {
    result = await prove(target.model, target.api);
  } catch (error) {
    result = { pending: `The request failed before a response: ${error.name}.` };
  }
  if (result.pending) {
    next.pending.push({ ...target, reason: result.pending });
    summary.push(`${target.model} ${target.api}: pending, ${result.pending}`);
    continue;
  }
  next.proofs.push({
    ...target,
    parameters: result.parameters,
    checks: result.checks,
    ...(result.rejected.length ? { rejected: result.rejected } : {}),
    run: values.run,
    date: today,
  });
  summary.push(
    `${target.model} ${target.api}: ${Object.keys(result.checks).join(', ')} passed${result.failed.length ? `; failed ${result.failed.join(', ')}` : ''}${result.rejected.length ? `; rejects ${result.rejected.join(', ')}` : ''}`,
  );
}
await writeFile(values.output, `${JSON.stringify(next, null, 2)}\n`);
console.log(summary.join('\n'));
console.log(`${requests} requests sent.`);
