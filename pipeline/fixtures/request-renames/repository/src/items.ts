import { catalog } from './client.ts';

export async function createItem(legacy_name: string, quantity: number, requestId: string) {
  const item = await catalog.items.create({ legacy_name, quantity }, { requestId });
  return item.id;
}
