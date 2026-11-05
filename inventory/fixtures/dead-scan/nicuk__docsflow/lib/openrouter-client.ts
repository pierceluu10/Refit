// Excerpt of nicuk/docsflow, lib/openrouter-client.ts, seen in P5.
export class OpenRouterClient {
  async generateWithFallback(models: string[], prompt: string) {
    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: models[0], messages: [{ role: 'user', content: prompt }] }),
    });
  }
}

export const MODEL_CONFIGS = {
  SIMPLE: [
    'mistralai/mistral-7b-instruct',
    'qwen/qwen-2.5-7b-instruct',
    'meta-llama/llama-3.1-8b-instruct'
  ] as string[],
  MEDIUM: [
    'mistralai/mistral-7b-instruct',
    'qwen/qwen-2.5-7b-instruct',
    'meta-llama/llama-3.1-8b-instruct'
  ] as string[],
  COMPLEX: [
    'qwen/qwen-2.5-7b-instruct',
    'meta-llama/llama-3.1-8b-instruct',
    'mistralai/mistral-7b-instruct'
  ] as string[],
  PREMIUM: [
    'anthropic/claude-3.5-sonnet',
    'openai/gpt-4-turbo',
  ] as string[],
  DOCUMENT_PROCESSING: [
    'qwen/qwen-2.5-7b-instruct',
    'mistralai/mistral-7b-instruct',
  ] as string[],
};

export type ModelConfigKey = keyof typeof MODEL_CONFIGS;
