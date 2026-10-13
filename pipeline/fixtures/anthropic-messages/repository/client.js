import Anthropic from '@anthropic-ai/sdk';

if (!process.env.REFIT_ANTHROPIC_BASE_URL)
  throw new TypeError('This fixture requires its loopback provider URL.');

export const client = new Anthropic({
  apiKey: 'refit-offline-test',
  baseURL: process.env.REFIT_ANTHROPIC_BASE_URL,
  maxRetries: 0,
  timeout: 1000,
});
