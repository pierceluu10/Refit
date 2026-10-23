// A simulated stand-in for the `stripe` package, not Stripe's SDK: it implements only the calls this
// fixture and Refit's patch make, with stripe-node's request shapes, and sends requests only to the
// loopback simulator in check.mjs.
export default class Stripe {
  #origin;
  #key;
  #apiVersion;
  #timeout;

  constructor(key, { apiVersion, host, port, protocol, timeout }) {
    this.#origin = `${protocol}://${host}:${port}`;
    this.#key = key;
    this.#apiVersion = apiVersion;
    this.#timeout = timeout;
    this.paymentIntents = Object.freeze({
      retrieve: (id) => this.#request(`/v1/payment_intents/${encodeURIComponent(id)}`),
    });
    this.charges = Object.freeze({
      list: (params) => this.#request(`/v1/charges?${new URLSearchParams(params)}`),
    });
  }

  async #request(path) {
    const response = await fetch(`${this.#origin}${path}`, {
      headers: { Authorization: `Bearer ${this.#key}`, 'Stripe-Version': this.#apiVersion },
      signal: AbortSignal.timeout(this.#timeout),
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(body.error?.message ?? 'Simulated Stripe request failed.'), {
        type: 'StripeInvalidRequestError',
        code: body.error?.code,
        statusCode: response.status,
      });
    return body;
  }
}
