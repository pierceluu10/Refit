const OpenAI = require('openai');

const client = new OpenAI();

async function summarise(text) {
  const response = await client.chat.completions.create({
    model: 'gpt-3.5-turbo-0613',
    messages: [{ role: 'user', content: `Summarise: ${text}` }],
  });
  return response.choices[0].message.content;
}

module.exports = { summarise };
