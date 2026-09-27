import { Catalog as CatalogClient } from '@example/catalog';

const catalog = new CatalogClient();

export async function itemLabel(id: string) {
  const item = await catalog.items.retrieve(id);
  return item.legacy_label;
}

export async function orderLabel(id: string) {
  const order = await catalog.orders.retrieve(id);
  return order.legacy_label;
}
