import OpenAI from 'openai';

const OFFLINE_KEY = 'refit-offline-test';
const REQUEST_TIMEOUT_MS = 5000;
if (!process.env.REFIT_SIMULATOR_URL)
  throw new TypeError('This fixture requires its local simulator URL.');
export const client = new OpenAI({
  apiKey: OFFLINE_KEY,
  baseURL: process.env.REFIT_SIMULATOR_URL,
  maxRetries: 0,
  timeout: REQUEST_TIMEOUT_MS,
});
