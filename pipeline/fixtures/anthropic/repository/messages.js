import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

export async function messageLimit() {
  const message = await client.messages.create({ model: 'claude', max_tokens: 64 });
  return message.max_tokens;
}
