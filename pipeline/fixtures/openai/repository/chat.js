import { client } from './client.js';

const MODEL = 'gpt-4.1-mini';

export async function getCompletionModel(prompt) {
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  });
  return completion.model.toLowerCase();
}
