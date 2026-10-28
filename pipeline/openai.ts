import { setTimeout as sleep } from 'node:timers/promises';
import { readBoundedResponse } from './network.ts';
import { digest, isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { reserveAiBudget, responseUsage, type AiOptions } from './ai-budget.ts';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 60_000;
// A response may reason through most of the output allowance before it answers, and an aborted
// request keeps its full reservation, so generation waits longer than token counting.
const GENERATION_TIMEOUT_MS = 180_000;
// gpt-6.1-sol reads 1,050,000 tokens (developers.openai.com/api/docs/models/gpt-6.1-sol, read
// 2026-10-28). At 64 KiB, 6 of 249 l2-push-249 repositories never reached the model because their
// affected files alone were larger (run 40591190068); 256 KiB costs at most about $0.15 of input.
export const MAX_INPUT_BYTES = 256 * 1024;
export const INPUT_LIMIT = `${MAX_INPUT_BYTES / 1024} KiB`;
// Reasoning effort the Responses API accepts for gpt-6.1-sol, weakest first (same page).
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const MAX_RESPONSE_BYTES = 256 * 1024;
// A rate-limited (429) request is not billed. Without retries, 37 of 249 l2-push-249 repositories
// lost an AI request to 429 in run 40637083138 and 85 in 40637093239, once ten shards shared the key.
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = 5_000;
const MAX_RETRY_WAIT_MS = 60_000;
// Reasoning tokens count against this limit. OpenAI recommends reserving at least 25,000 tokens for
// reasoning and output (developers.openai.com/api/docs/guides/reasoning/advice-on-prompting). At
// 4,096, a repair in the PG8 eval came back incomplete without saying why; the error now names it.
export const MAX_OUTPUT_TOKENS = 25_000;
// At least 2 bytes per token, so the byte limit binds first. JSON-wrapped source measures about
// 3.5 bytes per token: a 16,384 cap rejected evidence the byte limit allowed.
const MAX_INPUT_TOKENS = 131_072;

// A response OpenAI completed and billed that Refit cannot use; `budget` is what it cost.
export class UnusableAiResponse extends PipelineInputError {
  constructor(
    readonly budget: { costUsd: number; spentUsd: number; limitUsd: number } | null,
    message: string,
  ) {
    super(message);
  }
}

export async function requestStructuredOutput(
  request: { evidence: unknown; instructions: string; name: string; schema: object },
  options: AiOptions,
) {
  if (!options.apiKey.trim() || !options.model.trim())
    throw new PipelineInputError('AI requests require OPENAI_API_KEY and OPENAI_MODEL.');
  const input = JSON.stringify(request.evidence);
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES)
    throw new PipelineInputError(
      `AI evidence exceeds the ${INPUT_LIMIT} input limit; narrow the repository scope.`,
    );
  const body = {
    model: options.model,
    store: false,
    service_tier: 'default',
    instructions: request.instructions,
    input: [{ role: 'user', content: input }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    text: {
      format: { type: 'json_schema', name: request.name, strict: true, schema: request.schema },
    },
  };
  let settle: Awaited<ReturnType<typeof reserveAiBudget>> | undefined;
  if (options.budget) {
    const count = await fetch(`${RESPONSES_URL}/input_tokens`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: body.model,
        instructions: body.instructions,
        input: body.input,
        text: body.text,
      }),
    });
    if (!count.ok) {
      await count.body?.cancel();
      throw new PipelineInputError(
        `OpenAI token counting failed with HTTP ${count.status}; generation was not attempted.`,
      );
    }
    const tokens = parseObject(
      await readBoundedResponse(count, MAX_RESPONSE_BYTES, 'OpenAI token count'),
      'OpenAI token count',
    ).input_tokens;
    if (!Number.isSafeInteger(tokens) || Number(tokens) < 0 || Number(tokens) > MAX_INPUT_TOKENS)
      throw new PipelineInputError(
        'AI input exceeds the token limit or its count is invalid. Narrow the source context.',
      );
    settle = await reserveAiBudget(
      options.budget,
      options.model,
      Number(tokens),
      MAX_OUTPUT_TOKENS,
    );
  }
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(RESPONSES_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) break;
    const type = await errorType(response);
    // An exhausted quota also answers 429, and waiting does not refill it.
    if (response.status !== 429 || type === 'insufficient_quota' || attempt === RATE_LIMIT_RETRIES)
      throw new PipelineInputError(
        `OpenAI response request failed with HTTP ${response.status}${type ? ` (${type})` : ''}${response.status === 429 && attempt ? ` after ${attempt} retries` : '. No retry was made'}.`,
      );
    await sleep(retryDelay(response.headers, attempt));
  }
  const result = parseObject(
    await readBoundedResponse(response, MAX_RESPONSE_BYTES, 'OpenAI response'),
    'OpenAI response',
  );
  const usage = responseUsage(result.usage);
  const budget = settle
    ? await settle(usage, typeof result.model === 'string' ? result.model : '')
    : null;
  if (
    result.status !== 'completed' ||
    !Array.isArray(result.output) ||
    typeof result.id !== 'string' ||
    typeof result.model !== 'string'
  ) {
    const reason = isObject(result.incomplete_details) ? result.incomplete_details.reason : null;
    throw new UnusableAiResponse(
      budget,
      `OpenAI response was incomplete or invalid${typeof reason === 'string' ? ` (${reason.slice(0, 64)})` : ''}.`,
    );
  }
  const texts: string[] = [];
  for (const item of result.output) {
    if (!isObject(item)) throw new UnusableAiResponse(budget, 'Invalid OpenAI output item.');
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content))
      throw new UnusableAiResponse(budget, 'Unexpected OpenAI output type.');
    for (const part of item.content) {
      if (!isObject(part) || part.type !== 'output_text' || typeof part.text !== 'string')
        throw new UnusableAiResponse(
          budget,
          'OpenAI response was refused or contained unsupported content.',
        );
      texts.push(part.text);
    }
  }
  if (texts.length !== 1)
    throw new UnusableAiResponse(budget, 'OpenAI response must contain exactly one JSON output.');
  return {
    status: 'completed',
    provider: 'openai',
    model: result.model,
    responseId: result.id,
    evidenceHash: digest(input),
    usage,
    budget,
    content: texts[0],
  };
}

// OpenAI's own wait when it sends one, otherwise exponential backoff; capped either way.
function retryDelay(headers: Headers, attempt: number) {
  const milliseconds = Number(headers.get('retry-after-ms') ?? NaN);
  const seconds = Number(headers.get('retry-after') ?? NaN);
  const wait = Number.isFinite(milliseconds)
    ? milliseconds
    : Number.isFinite(seconds)
      ? seconds * 1000
      : RATE_LIMIT_BACKOFF_MS * 2 ** attempt;
  return Math.min(Math.max(wait, 0), MAX_RETRY_WAIT_MS);
}

// Only OpenAI's error type, never its message, which may echo request content.
async function errorType(response: Response) {
  try {
    const parsed: unknown = JSON.parse(
      await readBoundedResponse(response, MAX_RESPONSE_BYTES, 'OpenAI error'),
    );
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
    const type = typeof error.code === 'string' ? error.code : error.type;
    return typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? type : null;
  } catch {
    return null;
  }
}
