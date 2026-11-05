// Excerpt of Jmk125/ConstructionDocuments, aiHandler.js, seen in P5.
const Anthropic = require('@anthropic-ai/sdk');
const { runQuery } = require('../database');

const MODELS = {
  'claude-opus-4.5': { provider: 'anthropic', name: 'Claude Opus 4.5' },
  'claude-sonnet-4': { provider: 'anthropic', name: 'Claude Sonnet 4' },
};

const anthropic = new Anthropic();
exports.getAvailableModels = () => Object.keys(MODELS);
exports.initAI = () => runQuery;
exports.generateResponse = (model, messages) =>
  anthropic.messages.create({
    model: model === 'claude-opus-4.5' ? 'claude-opus-4-20250514' : 'claude-sonnet-4-20250514',
    messages,
  });
