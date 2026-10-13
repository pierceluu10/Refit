import { catalog } from './client.ts';

export async function itemLabel(id: string, options: { requestId?: string; locale?: string } = {}) {
  const item = await catalog.items.retrieveLegacy(id, options);
  return item.label;
}
