// Excerpt of nicuk/docsflow, lib-frontend/ai/providers.ts, seen in P5.
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

export const realProvider = {
  generatePersona: async (prompt: string) => {
    const result = await generateText({
      model: google('gemini-2.0-flash'),
      prompt,
    });
    return result.text;
  },
};
