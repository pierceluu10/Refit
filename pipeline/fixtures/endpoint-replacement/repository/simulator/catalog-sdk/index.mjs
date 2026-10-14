const LEGACY_ITEMS_PATH = '/legacy/items';
const CURRENT_ITEMS_PATH = '/items';
const REQUEST_ID_HEADER = 'x-request-id';
const API_VERSION_HEADER = 'x-catalog-version';

export class CatalogRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CatalogRequestError';
    this.status = status;
  }
}

export class Catalog {
  #baseUrl;
  #apiVersion;

  constructor({ baseUrl, apiVersion }) {
    this.#baseUrl = new URL(baseUrl);
    this.#apiVersion = apiVersion;
    this.items = Object.freeze({
      retrieveLegacy: (id, options) => this.#retrieve(LEGACY_ITEMS_PATH, id, options),
      retrieve: (id, options) => this.#retrieve(CURRENT_ITEMS_PATH, id, options),
    });
    this.products = Object.freeze({
      get: (id, options) => this.#retrieve(CURRENT_ITEMS_PATH, id, options),
    });
    this.inventory = Object.freeze({
      legacy: Object.freeze({ items: this.items }),
      current: Object.freeze({ products: this.products }),
    });
  }

  async #retrieve(path, id, { requestId, locale } = {}) {
    const url = new URL(`${path}/${encodeURIComponent(id)}`, this.#baseUrl);
    if (locale) url.searchParams.set('locale', locale);
    const response = await fetch(url, {
      headers: {
        ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}),
        ...(this.#apiVersion ? { [API_VERSION_HEADER]: this.#apiVersion } : {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new CatalogRequestError(response.status, body.message);
    return body;
  }
}
