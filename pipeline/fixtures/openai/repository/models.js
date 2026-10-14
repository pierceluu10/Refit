import { client } from './client.js';

export async function getModelOwner(id) {
  const model = await client.models.retrieve(id);
  return model.owned_by.toLowerCase();
}
