// Illustrative fixture code.
import OpenAI from 'openai';

const client = new OpenAI();

export async function reply(messages) {
  return client.chat.completions.create({ model: 'gpt-4-0613', messages });
}
