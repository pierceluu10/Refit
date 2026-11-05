// Excerpt of elnazar535-coder/eleko-bot, ai.js, seen in P5.
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic();
exports.ask = (text) =>
  client.messages.create({ model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: text }] });
