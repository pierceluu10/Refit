import { client } from './client.js';

export async function createMessage() {
  const message = await client.messages.create({
    model: 'fixture-anthropic-retired-model',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Return a fixture response.' }],
  });
  return message.content[0]?.type === 'text' ? message.content[0].text : null;
}
