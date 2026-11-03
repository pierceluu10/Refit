import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { tmpdir } from 'node:os';

export class BudgetExceededError extends Error {}

// The model's answer was cut off or refused, so its output can't be trusted as guidance.
export class DegradedOutputError extends Error {}

// In-process dollar ledger. Every model and embedding call in memory/ is charged here.
// shortcut: lives in one process only; move onto the harness budget ledger once harness/ lands.
export class Budget {
  spentUsd = 0;
  readonly capUsd: number;

  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new Error(`Invalid AI budget: ${capUsd}`);
    this.capUsd = capUsd;
  }

  // AGENTS.md: a run without REFIT_AI_BUDGET_USD refuses to spend, so unset means a $0 cap.
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Budget {
    const raw = env.REFIT_AI_BUDGET_USD;
    return new Budget(raw === undefined || raw === '' ? 0 : Number(raw));
  }

  // Refuse a call whose worst case would cross the cap, so the cap holds even if the call succeeds.
  reserve(worstCaseUsd: number): void {
    if (this.spentUsd + worstCaseUsd > this.capUsd) {
      throw new BudgetExceededError(
        `AI budget: $${this.spentUsd.toFixed(4)} spent of $${this.capUsd}; next call could cost $${worstCaseUsd.toFixed(4)}`,
      );
    }
  }

  charge(usd: number): void {
    this.spentUsd += usd;
  }
}

export type JsonRequest = {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
};

// The one shape memory/ needs from a model: a prompt in, schema-shaped JSON out.
export interface Model {
  json<T>(request: JsonRequest): Promise<T>;
}

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export const MODEL = 'claude-opus-5-5';
// Source: Claude API pricing for claude-opus-5-5, $4 / $20 per million tokens, 2026-10-06.
const INPUT_USD_PER_TOKEN = 4 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 20 / 1_000_000;

// Plain fields, not parameter properties: node runs these files by stripping types, and can't strip those.
export class AnthropicModel implements Model {
  private readonly budget: Budget;
  private readonly client: Anthropic;

  constructor(budget: Budget, client?: Anthropic) {
    this.budget = budget;
    this.client = client ?? new Anthropic();
  }

  async json<T>({ system, prompt, schema, maxTokens = 16_000 }: JsonRequest): Promise<T> {
    this.budget.reserve(worstCaseUsd({ system, prompt, schema, maxTokens }));

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    });
    this.budget.charge(
      response.usage.input_tokens * INPUT_USD_PER_TOKEN +
        response.usage.output_tokens * OUTPUT_USD_PER_TOKEN,
    );

    if (response.stop_reason === 'refusal') {
      throw new DegradedOutputError(
        `Model refused: ${response.stop_details?.explanation ?? 'no explanation'}`,
      );
    }
    if (response.stop_reason === 'max_tokens') throw new Error('Model output hit max_tokens');
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
    return JSON.parse(text.join('')) as T;
  }
}

// ~3 characters per token is a deliberately high token estimate for the reservation.
function worstCaseUsd({ system, prompt, schema, maxTokens }: Required<JsonRequest>): number {
  const inputTokens = (system.length + prompt.length + JSON.stringify(schema).length) / 3;
  return inputTokens * INPUT_USD_PER_TOKEN + maxTokens * OUTPUT_USD_PER_TOKEN;
}

// Same contract through the Claude Agent SDK, using the machine's logged-in Claude Code credentials.
// Charges the SDK's own cost estimate (total_cost_usd), not a bill, and caps the query at what is left.
export class AgentSdkModel implements Model {
  private readonly budget: Budget;
  private readonly run: typeof query;

  constructor(budget: Budget, run: typeof query = query) {
    this.budget = budget;
    this.run = run;
  }

  async json<T>({ system, prompt, schema, maxTokens = 16_000 }: JsonRequest): Promise<T> {
    this.budget.reserve(worstCaseUsd({ system, prompt, schema, maxTokens }));
    let result;
    let interrupted: string | undefined;
    for await (const message of this.run({
      prompt,
      options: {
        model: MODEL,
        systemPrompt: system,
        outputFormat: { type: 'json_schema', schema },
        tools: [],
        settingSources: [],
        persistSession: false,
        cwd: tmpdir(),
        maxTurns: 3,
        maxBudgetUsd: this.budget.capUsd - this.budget.spentUsd,
      },
    })) {
      if (message.type === 'result') result = message;
      interrupted ??= interruption(message);
    }
    if (!result) throw new Error('Agent SDK returned no result');
    this.budget.charge(result.total_cost_usd);
    // The model may "recover" after an interruption with placeholder text, so distrust the whole answer.
    if (interrupted)
      throw new DegradedOutputError(`Agent SDK answer was interrupted: ${interrupted}`);
    if (result.subtype !== 'success' || result.structured_output === undefined) {
      throw new Error(`Agent SDK query failed: ${result.subtype}`);
    }
    return result.structured_output as T;
  }
}

function interruption(message: SDKMessage): string | undefined {
  if (
    message.type === 'system' &&
    (message.subtype === 'model_refusal_fallback' ||
      message.subtype === 'model_refusal_no_fallback')
  ) {
    return message.content;
  }
  // shortcut: a mid-answer classifier stop reaches the stream only as this notice to the model; switch to a structured signal if the SDK adds one.
  if (
    message.type === 'user' &&
    JSON.stringify(message.message.content).includes('stopped by a safety classifier')
  ) {
    return 'stopped by a safety classifier';
  }
  return undefined;
}

// Source: Voyage AI list price for voyage-code-3, $0.18 per million tokens, recalled 2026-11-01 and not re-checked.
const VOYAGE_USD_PER_TOKEN = 0.18 / 1_000_000;

export class VoyageEmbedder implements Embedder {
  readonly name = 'voyage-code-3';
  private readonly budget: Budget;
  private readonly apiKey: string;

  constructor(budget: Budget, apiKey: string) {
    this.budget = budget;
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const chars = texts.reduce((sum, text) => sum + text.length, 0);
    this.budget.reserve((chars / 3) * VOYAGE_USD_PER_TOKEN);
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.name, input: texts, input_type: 'document' }),
    });
    if (!response.ok) throw new Error(`Voyage embeddings failed: HTTP ${response.status}`);
    const body = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
      usage: { total_tokens: number };
    };
    this.budget.charge(body.usage.total_tokens * VOYAGE_USD_PER_TOKEN);
    return body.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}

const LOCAL_DIMENSIONS = 512;

// Free offline embedder: hashed word and character-trigram features, so similar code and wording land close.
// shortcut: lexical, not semantic; used only when VOYAGE_API_KEY is absent. Set the key for real embeddings.
export class LocalEmbedder implements Embedder {
  readonly name = 'local-hash-512';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(LOCAL_DIMENSIONS).fill(0);
      const words = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
      for (const word of words) {
        vector[hash(word) % LOCAL_DIMENSIONS] += 1;
        const padded = ` ${word} `;
        for (let i = 0; i + 3 <= padded.length; i++) {
          vector[hash(padded.slice(i, i + 3)) % LOCAL_DIMENSIONS] += 0.5;
        }
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    });
  }
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

// Real clients when keys are present, offline fallbacks otherwise. Keys come only from the environment.
export function defaultAi(env: NodeJS.ProcessEnv = process.env, budget = Budget.fromEnv(env)) {
  return {
    budget,
    model: env.ANTHROPIC_API_KEY ? new AnthropicModel(budget) : undefined,
    embedder: env.VOYAGE_API_KEY
      ? new VoyageEmbedder(budget, env.VOYAGE_API_KEY)
      : new LocalEmbedder(),
  };
}
