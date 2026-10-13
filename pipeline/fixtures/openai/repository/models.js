import OpenAI from 'openai';

const OFFLINE_KEY = 'refit-offline-test';
const REQUEST_TIMEOUT_MS = 5000;
if (!process.env.REFIT_SIMULATOR_URL)
  throw new TypeError('This fixture requires its local simulator URL.');
const client = new OpenAI({
  apiKey: OFFLINE_KEY,
  baseURL: process.env.REFIT_SIMULATOR_URL,
  maxRetries: 0,
  timeout: REQUEST_TIMEOUT_MS,
});

export async function getModelOwner(id) {
  const model = await client.models.retrieve(id);
  return model.owned_by.toLowerCase();
}
