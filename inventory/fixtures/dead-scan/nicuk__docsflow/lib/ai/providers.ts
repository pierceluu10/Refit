// Excerpt of nicuk/docsflow, lib/ai/providers.ts, seen in P5.
import { google } from '@ai-sdk/google';
import { OpenRouterClient, MODEL_CONFIGS } from '@/lib/openrouter-client';

const enhancedProvider = {
  generatePersona: async (prompt: string) =>
    new OpenRouterClient().generateWithFallback(MODEL_CONFIGS.SIMPLE, prompt),
  getApiKey: () => process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  getEmbeddingModel: () => google.textEmbedding('text-embedding-004'),
};

export const aiProvider = enhancedProvider;
