// Excerpt of Jmk125/ConstructionDocuments, services/openai.js, seen in P5.
const OpenAI = require('openai');

const openai = new OpenAI();
exports.createEmbedding = (input) => openai.embeddings.create({ input });
exports.generateChatResponse = (messages) =>
  openai.chat.completions.create({ model: "gpt-4-turbo-preview", messages });
