const LEGACY_ITEMS_PATH = '/legacy/items';
const CURRENT_ITEMS_PATH = '/items';
const REQUEST_ID_HEADER = 'x-request-id';

export class CatalogRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CatalogRequestError';
    this.status = status;
  }
}

export class Catalog {
  #baseUrl;

  constructor({ baseUrl }) {
    this.#baseUrl = new URL(baseUrl);
    this.items = Object.freeze({
      retrieveLegacy: (id, options) => this.#retrieve(LEGACY_ITEMS_PATH, id, options),
      retrieve: (id, options) => this.#retrieve(CURRENT_ITEMS_PATH, id, options),
    });
    this.products = Object.freeze({
      get: (id, options) => this.#retrieve(CURRENT_ITEMS_PATH, id, options),
    });
  }

  async #retrieve(path, id, { requestId, locale } = {}) {
    const url = new URL(`${path}/${encodeURIComponent(id)}`, this.#baseUrl);
    if (locale) url.searchParams.set('locale', locale);
    const response = await fetch(url, {
      headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : {},
    });
    const body = await response.json();
    if (!response.ok) throw new CatalogRequestError(response.status, body.message);
    return body;
  }
}
