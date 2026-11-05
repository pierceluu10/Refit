// Learning off the fix path. Fix runs only store what happened; this reads stored runs later, in
// batches, on memory's own small budget, so it can't delay or block a fix or spend from its $1 cap.
import type Anthropic from '@anthropic-ai/sdk';
import { BATCH_DISCOUNT, MODEL_PRICES } from '../shared/prices.ts';
import { Budget, DegradedOutputError, type JsonRequest, type Model } from './ai.ts';

// Haiku, not Sonnet: extraction is summarising, and it was the biggest memory cost in round 3.
export const LEARN_MODEL = 'claude-haiku-5-5';
const POLL_MS = 30_000;
// A batch goes out once no new call has arrived for this long.
const FLUSH_AFTER_MS = 250;

type BatchClient = {
  messages: { batches: Pick<Anthropic.Messages.Batches, 'create' | 'retrieve' | 'results'> };
};

type Waiting = {
  request: JsonRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

// The Model contract over the Message Batches API at half price: json() queues a call, and flush()
// sends the queue as one batch and settles every call from its result.
export class BatchModel implements Model {
  private readonly client: BatchClient;
  private readonly budget: Budget;
  private readonly pollMs: number;
  private waiting: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(client: BatchClient, budget: Budget, pollMs = POLL_MS) {
    this.client = client;
    this.budget = budget;
    this.pollMs = pollMs;
  }

  json<T>(request: JsonRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ request, resolve: resolve as (value: unknown) => void, reject });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), FLUSH_AFTER_MS);
    });
  }

  get queued(): number {
    return this.waiting.length;
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    const calls = this.waiting;
    this.waiting = [];
    if (calls.length === 0) return;
    const price = MODEL_PRICES[LEARN_MODEL];
    const worstCase = calls.reduce((sum, { request }) => {
      const input = (request.system.length + request.prompt.length) / 3;
      const output = request.maxTokens ?? 16_000;
      // A prompt over the long-rate line pays it; the discount applies to every rate.
      const rates = price.long && input > (price.longAbove ?? Infinity) ? price.long : price;
      return sum + ((input * rates.input + output * rates.output) / 1e6) * BATCH_DISCOUNT;
    }, 0);
    try {
      this.budget.reserve(worstCase);
      const batch = await this.client.messages.batches.create({
        requests: calls.map(({ request }, index) => ({
          custom_id: String(index),
          params: {
            model: LEARN_MODEL,
            max_tokens: request.maxTokens ?? 16_000,
            system: request.system,
            output_config: {
              format: { type: 'json_schema', schema: request.schema },
            },
            messages: [{ role: 'user', content: request.prompt }],
          },
        })),
      });
      for (;;) {
        const state = await this.client.messages.batches.retrieve(batch.id);
        if (state.processing_status === 'ended') break;
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      }
      const results = await this.client.messages.batches.results(batch.id);
      const seen = new Set<number>();
      for await (const { custom_id, result } of results) {
        const index = Number(custom_id);
        const call = calls[index];
        if (!call) continue;
        seen.add(index);
        if (result.type !== 'succeeded') {
          call.reject(new Error(`batch request ${result.type}`));
          continue;
        }
        const { usage, content, stop_reason } = result.message;
        const prompt =
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        const rates = price.long && prompt > (price.longAbove ?? Infinity) ? price.long : price;
        this.budget.charge(
          ((usage.input_tokens * rates.input + usage.output_tokens * rates.output) / 1e6) *
            BATCH_DISCOUNT,
        );
        const text = content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
        if (stop_reason === 'refusal' || stop_reason === 'max_tokens') {
          call.reject(new DegradedOutputError(`Batch answer ended with ${stop_reason}`));
        } else {
          call.resolve(JSON.parse(text.join('')));
        }
      }
      calls.forEach((call, index) => {
        if (!seen.has(index)) call.reject(new Error('no result for this batch request'));
      });
    } catch (error) {
      for (const call of calls) call.reject(error as Error);
    }
  }
}
