import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

const MODE = process.argv[2];
const MODES = new Set(['before', 'stripe-after', 'openai-after', 'all-after']);
const LOOPBACK = '127.0.0.1';
const PAYMENT_ID = 'pi_multiple';
const EMPTY_ID = 'pi_empty';
const MISSING_ID = 'pi_missing';
const MODEL = 'gpt-4.1-mini';
const API_VERSION = '2022-08-01';
const DEMO_PROMPT = 'demo';
const FAILURE_PROMPT = 'fail';
const FAILURE_CODE = 'fixture_failure';
const SUCCESS = 200;
const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const charges = [
  { id: 'ch_first', object: 'charge', payment_intent: PAYMENT_ID },
  { id: 'ch_second', object: 'charge', payment_intent: PAYMENT_ID },
];
if (!MODES.has(MODE))
  throw new TypeError('Expected before, stripe-after, openai-after or all-after.');
const stripeChanged = MODE === 'stripe-after' || MODE === 'all-after';
const openaiChanged = MODE === 'openai-after' || MODE === 'all-after';
const requests = [];
const list = (data) => ({ object: 'list', data, has_more: false, url: '/v1/charges' });
const send = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${LOOPBACK}`);
  requests.push(`${request.method} ${url.pathname}`);
  if (url.pathname.startsWith('/v1/payment_intents/') && request.method === 'GET') {
    assert.equal(request.headers['stripe-version'], API_VERSION);
    const id = url.pathname.slice('/v1/payment_intents/'.length);
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
      ...(stripeChanged ? { latest_charge: data.at(-1)?.id ?? null } : { charges: list(data) }),
    });
    return;
  }
  if (url.pathname === '/v1/charges' && request.method === 'GET') {
    assert.equal(request.headers['stripe-version'], API_VERSION);
    const id = url.searchParams.get('payment_intent');
    assert.ok(id === PAYMENT_ID || id === EMPTY_ID);
    send(response, SUCCESS, list(id === EMPTY_ID ? [] : charges));
    return;
  }
  if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages[0].content;
    assert.ok(prompt === DEMO_PROMPT || prompt === FAILURE_PROMPT);
    assert.deepEqual(body, {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });
    if (prompt === FAILURE_PROMPT) {
      send(response, BAD_REQUEST, {
        error: {
          type: 'invalid_request_error',
          code: FAILURE_CODE,
          message: 'Simulated invalid prompt.',
        },
      });
      return;
    }
    send(response, SUCCESS, {
      id: 'chatcmpl_multiple',
      object: 'chat.completion',
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Simulated response.' },
        },
      ],
      ...(openaiChanged ? { model_id: MODEL } : { model: MODEL }),
    });
    return;
  }
  send(response, NOT_FOUND, {
    error: { type: 'invalid_request_error', message: 'Unexpected fixture request.' },
  });
});
try {
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  process.env.REFIT_SIMULATOR_PORT = String(server.address().port);
  const { chargeHistory } = await import('../src/history.ts');
  const { completionModel } = await import('../src/model.js');
  assert.deepEqual(await chargeHistory(PAYMENT_ID), charges);
  assert.deepEqual(await chargeHistory(EMPTY_ID), []);
  await assert.rejects(
    () => chargeHistory(MISSING_ID),
    (error) => error.code === 'resource_missing',
  );
  assert.equal(await completionModel(DEMO_PROMPT), MODEL);
  await assert.rejects(
    () => completionModel(FAILURE_PROMPT),
    (error) => error.code === FAILURE_CODE,
  );
  console.log(
    JSON.stringify({
      simulated: true,
      mode: MODE,
      stripe: 'history, empty history and retrieval error passed',
      openai: 'model read and request error passed',
      requests,
    }),
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
