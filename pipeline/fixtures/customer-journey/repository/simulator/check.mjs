import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const MODE = process.argv[2];
const LOOPBACK = '127.0.0.1';
const PAYMENT_ID = 'pi_journey';
const EMPTY_ID = 'pi_empty';
const MISSING_ID = 'pi_missing';
const API_VERSION = '2022-08-01';
const OFFLINE_KEY = 'sk_test_refit_customer_journey';
const SUCCESS = 200;
const NOT_FOUND = 404;
const charges = [
  { id: 'ch_first', object: 'charge', payment_intent: PAYMENT_ID },
  { id: 'ch_second', object: 'charge', payment_intent: PAYMENT_ID },
];
if (MODE !== 'before' && MODE !== 'after') throw new TypeError('Expected before or after.');
const nodeModules = fileURLToPath(new URL('../node_modules', import.meta.url));
const requests = [];
const list = (data) => ({ object: 'list', data, has_more: false, url: '/v1/charges' });
const send = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};
// The simulated API: after the change a PaymentIntent no longer embeds its charges.
const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${LOOPBACK}`);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
  assert.equal(request.headers['stripe-version'], API_VERSION);
  assert.equal(request.headers.authorization, `Bearer ${OFFLINE_KEY}`);
  if (url.pathname.startsWith('/v1/payment_intents/') && request.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/v1/payment_intents/'.length));
    if (id === MISSING_ID) {
      send(response, NOT_FOUND, {
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: 'No such PaymentIntent.',
        },
      });
      return;
    }
    assert.ok(id === PAYMENT_ID || id === EMPTY_ID);
    const data = id === EMPTY_ID ? [] : charges;
    send(response, SUCCESS, {
      id,
      object: 'payment_intent',
      ...(MODE === 'after' ? { latest_charge: data.at(-1)?.id ?? null } : { charges: list(data) }),
    });
    return;
  }
  if (url.pathname === '/v1/charges' && request.method === 'GET') {
    const id = url.searchParams.get('payment_intent');
    assert.ok(id === PAYMENT_ID || id === EMPTY_ID);
    send(response, SUCCESS, list(id === EMPTY_ID ? [] : charges));
    return;
  }
  send(response, NOT_FOUND, {
    error: { type: 'invalid_request_error', message: 'Unexpected fixture request.' },
  });
});
let ownsNodeModules = false;
try {
  await mkdir(nodeModules);
  ownsNodeModules = true;
  await symlink(
    '../simulator/stripe-sdk',
    new URL('../node_modules/stripe', import.meta.url),
    'dir',
  );
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  process.env.REFIT_SIMULATOR_PORT = String(server.address().port);
  const { chargeHistory } = await import('../src/history.ts');
  assert.deepEqual(await chargeHistory(PAYMENT_ID), charges);
  assert.deepEqual(await chargeHistory(EMPTY_ID), []);
  await assert.rejects(
    () => chargeHistory(MISSING_ID),
    (error) => error.code === 'resource_missing',
  );
  console.log(JSON.stringify({ simulated: true, mode: MODE, requests }));
} finally {
  if (server.listening) {
    const closed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
  if (ownsNodeModules) await rm(nodeModules, { recursive: true, force: true });
}
