// Excerpt of Jmk125/ConstructionDocuments, chatHandler.js, seen in P5.
const OpenAI = require('openai');
const { runQuery } = require('../database');
const { getAvailableModels } = require('./aiHandler');
exports.start = (generate) => generate(new OpenAI(), runQuery, getAvailableModels());
