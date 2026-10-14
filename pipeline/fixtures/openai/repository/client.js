import OpenAI from 'openai';

const OFFLINE_KEY = 'refit-offline-test';
const REQUEST_TIMEOUT_MS = 5000;
const LOOPBACK = '127.0.0.1';
if (!process.env.REFIT_SIMULATOR_URL)
  throw new TypeError('This fixture requires its local simulator URL.');
const baseURL = new URL(process.env.REFIT_SIMULATOR_URL);
if (baseURL.protocol !== 'http:' || baseURL.hostname !== LOOPBACK)
  throw new TypeError('This fixture accepts only its loopback HTTP simulator.');
export const client = new OpenAI({
  apiKey: OFFLINE_KEY,
  baseURL: baseURL.href,
  maxRetries: 0,
  timeout: REQUEST_TIMEOUT_MS,
});
