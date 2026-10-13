import { client } from './client.js';

const model = 'fixture-openai-retired-model';

export async function variableCompletion() {
  const completion = await client.completions.create({
    model,
    prompt: 'Return a variable-model fixture response.',
    max_tokens: 8,
  });
  return completion.choices[0].text;
}
