import { Catalog } from '@example/catalog';

export const catalog = new Catalog({ baseUrl: process.env.CATALOG_BASE_URL, apiVersion: '1' });
