import OpenAI from 'openai';
import { port, REQUEST_TIMEOUT_MS } from './simulator.ts';

const OFFLINE_KEY = 'refit-multiple-integrations-offline';

export const client = new OpenAI({
  apiKey: OFFLINE_KEY,
  baseURL: `http://127.0.0.1:${port}/v1`,
  timeout: REQUEST_TIMEOUT_MS,
  maxRetries: 0,
});
