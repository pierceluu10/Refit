import { client } from './client.js';

export async function createCompletion(model) {
  return client.completions.create({
    model,
    prompt: 'Return a wrapped fixture response.',
    max_tokens: 8,
  });
}
