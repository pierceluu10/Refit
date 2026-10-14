import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repository, mode] = process.argv.slice(2);
assert.ok(repository, 'Supply the webhook application directory.');
assert.ok(
  ['before', 'after', 'regression', 'migrated'].includes(mode),
  'Unknown webhook contract mode.',
);
const { stripe } = await import(pathToFileURL(resolve(repository, 'client.js')));
const { handleWebhook, MissingSubscriptionPeriodError } = await import(
  pathToFileURL(resolve(repository, 'entitlements.js'))
);
const SECRET = 'whsec_refit_simulated_endpoint';
const BEFORE_VERSION = '2025-02-24.acacia';
const AFTER_VERSION = '2025-03-31.basil';
const PERIOD_START = 1740787200;
const PERIOD_END = 1743465600;
const OTHER_PERIOD_END = 1746057600;
const deliveries = [];

function snapshot(version, type = 'customer.subscription.updated') {
  return {
    id: 'evt_refit_period',
    object: 'event',
    api_version: version,
    created: PERIOD_START,
    livemode: false,
    type,
    data: {
      object: {
        id: 'sub_refit_entitlement',
        object: 'subscription',
        ...(version === BEFORE_VERSION
          ? { current_period_start: PERIOD_START, current_period_end: PERIOD_END }
          : {}),
        items: {
          object: 'list',
          has_more: false,
          data: [
            {
              id: 'si_primary',
              object: 'subscription_item',
              price: { id: 'price_primary', object: 'price' },
              ...(version === AFTER_VERSION
                ? { current_period_start: PERIOD_START, current_period_end: PERIOD_END }
                : {}),
            },
            {
              id: 'si_addon',
              object: 'subscription_item',
              price: { id: 'price_addon', object: 'price' },
              ...(version === AFTER_VERSION
                ? { current_period_start: PERIOD_START, current_period_end: OTHER_PERIOD_END }
                : {}),
            },
          ],
        },
      },
    },
  };
}

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  response.setHeader('Content-Type', 'application/json');
  try {
    const result = handleWebhook(
      Buffer.concat(chunks),
      request.headers['stripe-signature'],
      SECRET,
    );
    response.end(JSON.stringify(result));
  } catch (error) {
    if (error.type === 'StripeSignatureVerificationError') {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'invalid-signature' }));
    } else if (error instanceof MissingSubscriptionPeriodError) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: 'missing-subscription-period' }));
    } else {
      response.destroy(error);
    }
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
  async function deliver(event, { signingSecret = SECRET, tamper = false, stale = false } = {}) {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: signingSecret,
      ...(stale ? { timestamp: PERIOD_START } : {}),
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      method: 'POST',
      headers: { 'stripe-signature': header },
      body: tamper ? `${payload} ` : payload,
    });
    const result = { status: response.status, body: await response.json() };
    deliveries.push(result);
    return result;
  }

  const before = snapshot(BEFORE_VERSION);
  const after = snapshot(AFTER_VERSION);
  assert.notEqual(
    after.data.object.items.data[0].current_period_end,
    after.data.object.items.data[1].current_period_end,
    'The simulated multi-item payload must make first-item selection a business decision.',
  );
  const version = mode === 'after' ? AFTER_VERSION : BEFORE_VERSION;
  const result = await deliver(snapshot(version));
  assert.equal(
    result.status,
    200,
    `Incoming ${version} must provide the intended entitlement period; received ${JSON.stringify(result.body)}`,
  );
  assert.deepEqual(result.body, {
    subscription: 'sub_refit_entitlement',
    startsAt: PERIOD_START,
    endsAt: PERIOD_END,
    incomingApiVersion: version,
  });
  if (mode === 'regression' || mode === 'migrated') {
    const changed = await deliver(after);
    assert.equal(changed.status, mode === 'migrated' ? 200 : 422);
    if (mode === 'regression')
      assert.deepEqual(changed.body, { error: 'missing-subscription-period' });
    else {
      assert.deepEqual(changed.body, { ...result.body, incomingApiVersion: AFTER_VERSION });
      const reordered = snapshot(AFTER_VERSION);
      reordered.data.object.items.data.reverse();
      assert.deepEqual(
        await deliver(reordered),
        changed,
        'Price identity must determine the period, independent of item order.',
      );
      const changedPeriod = snapshot(AFTER_VERSION);
      changedPeriod.data.object.items.data[0].current_period_end = OTHER_PERIOD_END;
      assert.equal(
        (await deliver(changedPeriod)).body.endsAt,
        OTHER_PERIOD_END,
        'Period values must come from the actual matched item.',
      );
      const invalid = [
        (event) => {
          event.api_version = null;
        },
        (event) => {
          event.api_version = '2025-04-30.basil';
        },
        (event) => {
          event.api_version = BEFORE_VERSION;
        },
        (event) => {
          event.data.object.items.has_more = true;
        },
        (event) => {
          delete event.data.object.items.has_more;
        },
        (event) => {
          event.data.object.items.data = [];
        },
        (event) => {
          event.data.object.items.data[0].price.id = 'price_missing';
        },
        (event) => {
          event.data.object.items.data[1].price.id = 'price_primary';
        },
        (event) => {
          delete event.data.object.items.data[1].price;
        },
        (event) => {
          event.data.object.items.data.push(null);
        },
        (event) => {
          event.data.object.items.data[0].current_period_start = -1;
        },
        (event) => {
          event.data.object.items.data[0].current_period_end = PERIOD_START - 1;
        },
        (event) => {
          event.data.object.items.data[0].current_period_end = 1.5;
        },
        (event) => {
          delete event.data.object.items.data[0].current_period_end;
        },
      ];
      for (const change of invalid) {
        const event = snapshot(AFTER_VERSION);
        change(event);
        assert.deepEqual(await deliver(event), {
          status: 422,
          body: { error: 'missing-subscription-period' },
        });
      }
    }
    const oldAgain = await deliver(before);
    assert.equal(oldAgain.status, 200, 'Previously rendered events retain their original version.');
    for (const options of [{ signingSecret: 'whsec_wrong' }, { tamper: true }, { stale: true }]) {
      assert.deepEqual(await deliver(before, options), {
        status: 400,
        body: { error: 'invalid-signature' },
      });
    }
    assert.deepEqual(await deliver(snapshot(AFTER_VERSION, 'customer.created')), {
      status: 200,
      body: { ignored: true },
    });
    const payload = JSON.stringify(after);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const asyncEvent = await stripe.webhooks.constructEventAsync(payload, header, SECRET);
    assert.equal(asyncEvent.api_version, AFTER_VERSION);
    assert.equal(asyncEvent.data.object.current_period_end, undefined);
  }
  console.log(
    JSON.stringify({ mode, simulated: true, outgoingClientVersion: BEFORE_VERSION, deliveries }),
  );
} finally {
  server.closeAllConnections();
  if (server.listening)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
