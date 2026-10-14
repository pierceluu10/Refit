import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [source, mode] = process.argv.slice(2);
assert.ok(source, 'A billing module path is required.');
assert.ok(['before', 'after'].includes(mode), 'Mode must be before or after.');
const intentId = 'pi_refit_contract';
const charges = [
  { id: 'ch_first', object: 'charge', payment_intent: intentId },
  { id: 'ch_second', object: 'charge', payment_intent: intentId },
];
const list = { object: 'list', data: charges, has_more: false, url: '/v1/charges' };
const requests = [];
const apiVersions = [];
const expectedVersion = process.env.REFIT_EXPECTED_API_VERSION;
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  apiVersions.push(request.headers['stripe-version'] ?? null);
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && request.url === `/v1/payment_intents/${intentId}`) {
    response.end(
      JSON.stringify({
        id: intentId,
        object: 'payment_intent',
        ...(mode === 'before' ? { charges: list } : { latest_charge: charges[1].id }),
      }),
    );
  } else if (request.method === 'GET' && request.url === `/v1/charges?payment_intent=${intentId}`) {
    response.end(JSON.stringify(list));
  } else {
    response.statusCode = 400;
    response.end(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'Unexpected fixture request.' },
      }),
    );
  }
});

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  process.env.REFIT_FIXTURE_PORT = String(server.address().port);
  const { chargeHistory } = await import(pathToFileURL(resolve(source)));
  const result = await chargeHistory(intentId);
  assert.deepEqual(result, charges, 'Migration must preserve the complete fixture charge list.');
  if (expectedVersion)
    assert.ok(
      apiVersions.every((version) => version === expectedVersion),
      'SDK requests must send the configured Stripe-Version header.',
    );
  if (mode === 'after')
    assert.deepEqual(requests, [
      { method: 'GET', path: `/v1/payment_intents/${intentId}` },
      { method: 'GET', path: `/v1/charges?payment_intent=${intentId}` },
    ]);
  console.log(
    JSON.stringify({ mode, chargeIds: result.map((charge) => charge.id), requests, apiVersions }),
  );
} finally {
  server.closeAllConnections();
  if (server.listening)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
