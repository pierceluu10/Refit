import { setTimeout as sleep } from 'node:timers/promises';
import { readBoundedResponse } from './network.ts';
import { digest, isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { reserveAiBudget, type AiOptions, type AiUsage } from './ai-budget.ts';
import {
  errorType,
  INPUT_LIMIT,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_TOKENS,
  retryDelay,
  UnusableAiResponse,
  type OutputLimits,
} from './openai.ts';

// The same request shape and limits as openai.ts, sent to the Claude Messages API instead.
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
// Raw HTTP sends the API version itself; 2026-10-21 rejects sampling parameters, which Refit never sends.
const API_VERSION = '2026-10-21';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_ESCALATION_MODEL = 'claude-opus-5-5';
const REQUEST_TIMEOUT_MS = 60_000;
const GENERATION_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_INPUT_TOKENS = 131_072;
// 429, 5xx and 529 (overloaded) are not billed and may clear; anything else fails at once.
const RETRIES = 4;
// Structured outputs reject these JSON Schema keywords; the callers validate the parsed answer
// themselves, as Anthropic's SDKs do when they strip them.
const UNSUPPORTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

export async function requestAnthropicOutput(
  request: { evidence: unknown; instructions: string; name: string; schema: object },
  options: AiOptions,
  limits: OutputLimits = {},
) {
  const maxOutputTokens = limits.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  const maxResponseBytes = limits.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!options.apiKey.trim() || !options.model.trim())
    throw new PipelineInputError('AI requests require ANTHROPIC_API_KEY and ANTHROPIC_MODEL.');
  const input = JSON.stringify(request.evidence);
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES)
    throw new PipelineInputError(
      `AI evidence exceeds the ${INPUT_LIMIT} input limit; narrow the repository scope.`,
    );
  const prompt = {
    model: options.model,
    system: request.instructions,
    messages: [{ role: 'user', content: input }],
  };
  const format = { type: 'json_schema', schema: supportedSchema(request.schema) };
  const body = {
    ...prompt,
    max_tokens: maxOutputTokens,
    output_config: {
      format,
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
    },
  };
  const headers = {
    'x-api-key': options.apiKey,
    'anthropic-version': API_VERSION,
    'Content-Type': 'application/json',
  };
  let settle: Awaited<ReturnType<typeof reserveAiBudget>> | undefined;
  if (options.budget) {
    const count = await fetch(`${MESSAGES_URL}/count_tokens`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
      body: JSON.stringify({ ...prompt, output_config: { format } }),
    });
    if (!count.ok) {
      const type = await errorType(count);
      throw new PipelineInputError(
        `Anthropic token counting failed with HTTP ${count.status}${type ? ` (${type})` : ''}; generation was not attempted.`,
      );
    }
    const tokens = parseObject(
      await readBoundedResponse(count, MAX_RESPONSE_BYTES, 'Anthropic token count'),
      'Anthropic token count',
    ).input_tokens;
    if (!Number.isSafeInteger(tokens) || Number(tokens) < 0 || Number(tokens) > MAX_INPUT_TOKENS)
      throw new PipelineInputError(
        'AI input exceeds the token limit or its count is invalid. Narrow the source context.',
      );
    settle = await reserveAiBudget(options.budget, options.model, Number(tokens), maxOutputTokens);
  }
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(MESSAGES_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(limits.timeoutMs ?? GENERATION_TIMEOUT_MS),
      headers,
      body: JSON.stringify(body),
    });
    if (response.ok) break;
    const type = await errorType(response);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === RETRIES)
      throw new PipelineInputError(
        `Anthropic message request failed with HTTP ${response.status}${type ? ` (${type})` : ''}${retryable && attempt ? ` after ${attempt} retries` : '. No retry was made'}.`,
      );
    await sleep(retryDelay(response.headers, attempt));
  }
  const result = parseObject(
    await readBoundedResponse(response, maxResponseBytes, 'Anthropic response'),
    'Anthropic response',
  );
  const usage = anthropicUsage(result.usage);
  const budget = settle
    ? await settle(usage, typeof result.model === 'string' ? result.model : '')
    : null;
  if (
    typeof result.id !== 'string' ||
    typeof result.model !== 'string' ||
    !Array.isArray(result.content)
  )
    throw new UnusableAiResponse(budget, 'Anthropic response was incomplete or invalid.');
  if (result.stop_reason === 'refusal')
    throw new UnusableAiResponse(budget, 'Anthropic response was refused.');
  if (result.stop_reason !== 'end_turn') {
    const reason = typeof result.stop_reason === 'string' ? result.stop_reason.slice(0, 64) : null;
    throw new UnusableAiResponse(
      budget,
      `Anthropic response was incomplete or invalid${reason ? ` (${reason})` : ''}.`,
      reason ?? undefined,
    );
  }
  const texts: string[] = [];
  for (const block of result.content) {
    if (!isObject(block)) throw new UnusableAiResponse(budget, 'Invalid Anthropic content block.');
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (block.type !== 'text' || typeof block.text !== 'string')
      throw new UnusableAiResponse(budget, 'Anthropic response contained unsupported content.');
    texts.push(block.text);
  }
  if (texts.length !== 1)
    throw new UnusableAiResponse(
      budget,
      'Anthropic response must contain exactly one JSON output.',
    );
  return {
    status: 'completed',
    provider: 'anthropic',
    model: result.model,
    responseId: result.id,
    evidenceHash: digest(input),
    usage,
    budget,
    content: texts[0],
  };
}

// Anthropic's input_tokens excludes cache reads and writes; the ledger counts them as input.
// Thinking is billed as output and is not reported apart from it.
function anthropicUsage(value: unknown): AiUsage | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value))
    throw new PipelineInputError('Anthropic returned invalid usage accounting.');
  const counts = [
    value.input_tokens,
    value.output_tokens,
    value.cache_read_input_tokens ?? 0,
    value.cache_creation_input_tokens ?? 0,
  ];
  if (!counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0))
    throw new PipelineInputError('Anthropic returned inconsistent usage accounting.');
  const [uncached, outputTokens, cachedInputTokens, cacheWriteInputTokens] = counts.map(Number);
  return {
    inputTokens: uncached + cachedInputTokens + cacheWriteInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningTokens: 0,
  };
}

// A copy of the schema without the keywords structured outputs reject; property names are kept.
export function supportedSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(supportedSchema);
  if (!isObject(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !UNSUPPORTED_KEYWORDS.has(key))
      .map(([key, value]) => [
        key,
        (key === 'properties' || key === '$defs' || key === 'definitions') && isObject(value)
          ? Object.fromEntries(
              Object.entries(value).map(([name, child]) => [name, supportedSchema(child)]),
            )
          : supportedSchema(value),
      ]),
  );
}
