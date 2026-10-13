import { client } from './client.js';

export async function directCompletion() {
  const completion = await client.completions.create({
    model: 'fixture-openai-retired-model',
    prompt: 'Return a fixture response.',
    max_tokens: 8,
  });
  return completion.choices[0].text;
}
