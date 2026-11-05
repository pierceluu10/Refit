// Optional live smoke call: on a sample of fixes, one tiny request per provider to the replacement
// the fix moved to. Mocks and rescans can't see a model that refuses a call. It runs on the host with
// the provider's own key, never in the sandbox, and a fix is called proven live only by a real answer.
import { createHash } from 'node:crypto';
import type { RepoTask } from './findings.ts';

export type SmokeResult = {
  provider: string;
  model: string;
  outcome: 'answered' | 'refused' | 'no-key';
  detail: string;
};

type Call = {
  key: string;
  url: (model: string) => string;
  init: (model: string, key: string) => RequestInit;
};

const json = (headers: Record<string, string>, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const openAiChat = (model: string, key: string) =>
  json(
    { authorization: `Bearer ${key}` },
    { model, messages: [{ role: 'user', content: 'ok' }], max_completion_tokens: 16 },
  );

// Each costs a fraction of a cent: a one-word prompt and 16 tokens out.
const CALLS: Record<string, Call> = {
  anthropic: {
    key: 'ANTHROPIC_API_KEY',
    url: () => 'https://api.anthropic.com/v1/messages',
    init: (model, key) =>
      json(
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 16, messages: [{ role: 'user', content: 'ok' }] },
      ),
  },
  openai: {
    key: 'OPENAI_API_KEY',
    url: () => 'https://api.openai.com/v1/chat/completions',
    init: openAiChat,
  },
  groq: {
    key: 'GROQ_API_KEY',
    url: () => 'https://api.groq.com/openai/v1/chat/completions',
    init: openAiChat,
  },
  gemini: {
    key: 'GEMINI_API_KEY',
    url: (model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    init: (_model, key) =>
      json(
        { 'x-goog-api-key': key },
        { contents: [{ parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 16 } },
      ),
  },
};

// A stable pick by repo name, so a rerun smokes the same repos.
export function sampled(repo: string, rate: number): boolean {
  const roll = createHash('sha256').update(repo).digest().readUInt32BE(0) / 2 ** 32;
  return roll < rate;
}

const modelIn = (replacement: string) =>
  /`([\w./:-]+)`/.exec(replacement)?.[1] ??
  (/^[\w./:-]+$/.test(replacement) ? replacement : undefined);

// One call per provider with a model replacement. Providers with no such call (Stripe, Analytics)
// have nothing a one-line request can show, so they get no result.
export async function liveSmoke(
  task: RepoTask,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; rate?: number } = {},
): Promise<SmokeResult[]> {
  const { env = process.env, fetch: send = fetch } = options;
  const rate = options.rate ?? Number(env.APTITUDE_SMOKE_RATE ?? 0.1);
  if (!sampled(task.repo, rate)) return [];
  const byProvider = new Map<string, string>();
  for (const entry of task.entries) {
    const model = modelIn(entry.replacement);
    if (model && CALLS[entry.provider] && !byProvider.has(entry.provider))
      byProvider.set(entry.provider, model);
  }
  return Promise.all(
    [...byProvider].map(async ([provider, model]): Promise<SmokeResult> => {
      const call = CALLS[provider] as Call;
      const key = env[call.key];
      if (!key)
        return { provider, model, outcome: 'no-key', detail: `${call.key} is not set here` };
      try {
        const response = await send(call.url(model), {
          ...call.init(model, key),
          signal: AbortSignal.timeout(30_000),
        });
        return response.ok
          ? { provider, model, outcome: 'answered', detail: `HTTP ${response.status}` }
          : { provider, model, outcome: 'refused', detail: `HTTP ${response.status}` };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { provider, model, outcome: 'refused', detail };
      }
    }),
  );
}
