import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const MODE = process.argv[2];
const LOOPBACK = '127.0.0.1';
const MODEL = 'gpt-4.1-mini';
const PROMPT = 'offline request';
const FAILURE_PROMPT = 'fail';
const REQUEST_ID = 'req_openai';
const REQUEST_FIELD = MODE === 'before' ? 'model' : 'model_id';
const SUCCESS = 200;
const BAD_REQUEST = 400;
const FAILURE_CODE = 'fixture_failure';
if (!['before', 'after'].includes(MODE)) throw new TypeError('Expected before or after.');
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(request.headers.authorization, 'Bearer refit-offline-test');
  requests.push({
    method: request.method,
    path: request.url,
    requestId: request.headers['x-request-id'],
    body,
  });
  const missing = !Object.hasOwn(body, REQUEST_FIELD);
  const failed = body.messages[0].content === FAILURE_PROMPT;
  response.writeHead(missing || failed ? BAD_REQUEST : SUCCESS, {
    'content-type': 'application/json',
  });
  response.end(
    JSON.stringify(
      missing || failed
        ? {
            error: {
              type: 'invalid_request_error',
              code: FAILURE_CODE,
              message: missing ? 'Missing required model field' : 'Simulated request failure',
            },
          }
        : {
            id: 'chatcmpl_request',
            object: 'chat.completion',
            created: 1,
            model: MODEL,
            choices: [],
          },
    ),
  );
});
try {
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  process.env.REFIT_SIMULATOR_URL = `http://${LOOPBACK}:${server.address().port}/v1`;
  const { createCompletion } = await import('../src/billing.js');
  assert.equal(await createCompletion(PROMPT, REQUEST_ID), 'chatcmpl_request');
  await assert.rejects(
    () => createCompletion(FAILURE_PROMPT, REQUEST_ID),
    (error) =>
      error.status === BAD_REQUEST &&
      error.code === FAILURE_CODE &&
      error.message.includes('Simulated request failure'),
  );
  assert.deepEqual(
    requests,
    [PROMPT, FAILURE_PROMPT].map((prompt) => ({
      method: 'POST',
      path: '/v1/chat/completions',
      requestId: REQUEST_ID,
      body: {
        [REQUEST_FIELD]: MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      },
    })),
  );
  console.log(
    `Simulated OpenAI request passed (${MODE}): exact nested SDK body, headers and propagated 400.`,
  );
} finally {
  if (server.listening) {
    const closed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
}
