// Excerpt of atrueempire/yk, app/api/chat/messages/perplexity/route.ts, seen in P5.
import OpenAI from 'openai';

export const client = new OpenAI({
    baseURL: process.env.PERPLEXITY_ENDPOINT ?? 'https://api.perplexity.ai/',
});
