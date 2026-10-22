import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [source, mode, variant = 'model'] = process.argv.slice(2);
assert.ok(mode === 'before' || mode === 'after');
assert.ok(variant === 'model' || variant === 'chat');
const MODEL = 'gpt-4.1';
const PROMPT = 'Offline conformance test';
const MODEL_PATH = `/v1/models/${MODEL}`;
const CHAT_PATH = '/v1/chat/completions';
const CHAT_REQUEST = { model: MODEL, messages: [{ role: 'user', content: PROMPT }], stream: false };
const requests = [];
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer refit-offline-test');
  let body;
  if (variant === 'chat') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual(body, CHAT_REQUEST);
  }
  requests.push({ method: request.method, path: request.url, ...(body ? { body } : {}) });
  assert.equal(request.method, variant === 'chat' ? 'POST' : 'GET');
  assert.equal(request.url, variant === 'chat' ? CHAT_PATH : MODEL_PATH);
  response.setHeader('Content-Type', 'application/json');
  response.end(
    JSON.stringify(
      variant === 'chat'
        ? {
            id: 'chatcmpl_simulated',
            object: 'chat.completion',
            created: 0,
            choices: [],
            ...(mode === 'before' ? { model: MODEL } : { model_id: MODEL }),
          }
        : {
            id: MODEL,
            object: 'model',
            created: 0,
            ...(mode === 'before' ? { owned_by: 'openai' } : { owner_name: 'openai' }),
          },
    ),
  );
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
process.env.REFIT_SIMULATOR_URL = `http://127.0.0.1:${server.address().port}/v1`;
try {
  const application = await import(pathToFileURL(resolve(source)).href);
  if (variant === 'chat') {
    assert.equal(await application.getCompletionModel(PROMPT), MODEL);
    console.log(JSON.stringify({ requests, model: MODEL }));
  } else {
    assert.equal(await application.getModelOwner(MODEL), 'openai');
    console.log(JSON.stringify({ requests, owner: 'openai' }));
  }
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
}
