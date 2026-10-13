import OpenAI from 'openai';

if (!process.env.REFIT_OPENAI_BASE_URL)
  throw new TypeError('This fixture requires its loopback provider URL.');

export const client = new OpenAI({
  apiKey: 'refit-offline-test',
  baseURL: process.env.REFIT_OPENAI_BASE_URL,
  maxRetries: 0,
  timeout: 1000,
});
