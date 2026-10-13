import { readBoundedResponse } from './network.ts';
import { digest, isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import { reserveAiBudget, responseUsage, type AiOptions } from './ai-budget.ts';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_INPUT_TOKENS = 16_384;

export async function requestStructuredOutput(
  request: { evidence: unknown; instructions: string; name: string; schema: object },
  options: AiOptions,
) {
  if (!options.apiKey.trim() || !options.model.trim())
    throw new PipelineInputError('AI requests require OPENAI_API_KEY and OPENAI_MODEL.');
  const input = JSON.stringify(request.evidence);
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES)
    throw new PipelineInputError(
      'AI evidence exceeds the 64 KiB input limit; narrow the repository scope.',
    );
  const body = {
    model: options.model,
    store: false,
    service_tier: 'default',
    instructions: request.instructions,
    input: [{ role: 'user', content: input }],
    max_output_tokens: MAX_OUTPUT_TOKENS,
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
  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PipelineInputError(
      `OpenAI response request failed with HTTP ${response.status}. No retry was made.`,
    );
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
  )
    throw new PipelineInputError('OpenAI response was incomplete or invalid.');
  const texts: string[] = [];
  for (const item of result.output) {
    if (!isObject(item)) throw new PipelineInputError('Invalid OpenAI output item.');
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content))
      throw new PipelineInputError('Unexpected OpenAI output type.');
    for (const part of item.content) {
      if (!isObject(part) || part.type !== 'output_text' || typeof part.text !== 'string')
        throw new PipelineInputError(
          'OpenAI response was refused or contained unsupported content.',
        );
      texts.push(part.text);
    }
  }
  if (texts.length !== 1)
    throw new PipelineInputError('OpenAI response must contain exactly one JSON output.');
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
