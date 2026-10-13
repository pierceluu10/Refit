import { createCompletion } from './completion-wrapper.js';

export async function wrappedCompletion() {
  const completion = await createCompletion('fixture-openai-retired-model');
  return completion.choices[0].text;
}
