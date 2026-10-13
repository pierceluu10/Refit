import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [source, mode] = process.argv.slice(2);
assert.ok(mode === 'before' || mode === 'after');
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  assert.equal(request.headers.authorization, 'Bearer refit-offline-test');
  assert.equal(request.url, '/v1/models/gpt-4.1-mini');
  response.setHeader('Content-Type', 'application/json');
  response.end(
    JSON.stringify({
      id: 'gpt-4.1-mini',
      object: 'model',
      created: 0,
      ...(mode === 'before' ? { owned_by: 'openai' } : {}),
    }),
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.env.REFIT_SIMULATOR_URL = `http://127.0.0.1:${server.address().port}/v1`;
try {
  const { getModelOwner } = await import(pathToFileURL(resolve(source)).href);
  assert.equal(await getModelOwner('gpt-4.1-mini'), 'openai');
  console.log(JSON.stringify({ requests, owner: 'openai' }));
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
}
