const LOOPBACK = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 5000;

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
    if (this.#baseUrl.hostname !== LOOPBACK || this.#baseUrl.protocol !== 'http:')
      throw new TypeError('The simulated SDK requires an HTTP loopback server.');
    this.#apiVersion = apiVersion;
    this.items = Object.freeze({ create: (body, options) => this.#create(body, options) });
  }

  async #create(body, { requestId }) {
    const response = await fetch(new URL('/items', this.#baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
        'x-catalog-version': this.#apiVersion,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const result = await response.json();
    if (!response.ok) throw new CatalogRequestError(response.status, result.message);
    return result;
  }
}
