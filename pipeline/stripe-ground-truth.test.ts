import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { labelReads, stripeParamOperations } from './stripe-ground-truth.ts';

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'refit-ground-truth-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const sdkSpec = {
  components: {
    schemas: {
      'checkout.session': {
        'x-stripeResource': { class_name: 'Session', in_package: 'Checkout' },
        'x-stripeOperations': [
          {
            method_name: 'create',
            method_on: 'service',
            operation: 'post',
            path: '/v1/checkout/sessions',
          },
          {
            method_name: 'list_line_items',
            method_on: 'service',
            operation: 'get',
            path: '/v1/checkout/sessions/{session}/line_items',
          },
        ],
      },
    },
  },
};
const contract = (properties: Record<string, unknown>) => ({
  paths: {
    '/v1/checkout/sessions': {
      post: {
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': { schema: { type: 'object', properties } },
          },
        },
      },
    },
  },
});
const application = `import Stripe from 'stripe';
const stripe = new Stripe('sk');
export async function checkout() {
  const params = { mode: 'payment', payment_method_types: ['card'] };
  await stripe.checkout.sessions.create(params);
  const session = await stripe.checkout.sessions.create({
    subscription_data: { trial_from_plan: true, description: 'kept' },
  });
  return session.subscription;
}
`;

it('names each stripe-node parameter type after its class and method', () => {
  const operations = stripeParamOperations(sdkSpec);
  expect(operations.get('Checkout.SessionCreateParams')).toEqual({
    path: '/v1/checkout/sessions',
    operation: 'post',
  });
  expect(operations.has('Checkout.SessionListLineItemsParams')).toBe(true);
});

it('labels removed request parameters and response reads for ambient and module stripe types', () => {
  const ambient = tree({
    'package.json': '{"types": "types/index.d.ts"}',
    'types/index.d.ts': `declare module 'stripe' {
  namespace Stripe {
    namespace Checkout {
      interface Session { subscription: string }
      interface SessionCreateParams {
        mode?: string;
        payment_method_types?: string[];
        subscription_data?: SessionCreateParams.SubscriptionData;
      }
      namespace SessionCreateParams {
        interface SubscriptionData { trial_from_plan?: boolean; description?: string }
      }
      class SessionsResource { create(params?: SessionCreateParams): Promise<Session> }
    }
  }
  class Stripe {
    constructor(key: string);
    checkout: { sessions: Stripe.Checkout.SessionsResource };
  }
  export default Stripe;
}
`,
  });
  // stripe-node v22 declares each class in its own module under resources/.
  const modules = tree({
    'package.json': '{"exports": {"default": {"require": {"types": "./cjs/index.d.ts"}}}}',
    'cjs/index.d.ts': `import { SessionsResource } from './resources/Checkout/Sessions.js';
declare class Stripe {
  constructor(key: string);
  checkout: { sessions: SessionsResource };
}
export = Stripe;
`,
    'cjs/resources/Checkout/Sessions.d.ts': `export interface Session { subscription: string }
export interface SessionCreateParams {
  mode?: string;
  payment_method_types?: string[];
  subscription_data?: { trial_from_plan?: boolean; description?: string };
}
export declare class SessionsResource { create(params?: SessionCreateParams): Promise<Session> }
`,
  });
  for (const stripePackage of [ambient, modules]) {
    const reads = labelReads({
      repository: tree({ 'src/checkout.ts': application }),
      stripePackage,
      removed: new Map([['subscription', new Set(['checkout.session'])]]),
      classSchemas: new Map([['Checkout.Session', 'checkout.session']]),
      requests: {
        before: contract({
          mode: {},
          payment_method_types: {},
          subscription_data: {
            type: 'object',
            properties: { trial_from_plan: {}, description: {} },
          },
        }),
        after: contract({
          mode: {},
          subscription_data: { type: 'object', properties: { description: {} } },
        }),
        operations: stripeParamOperations(sdkSpec),
      },
    });
    expect(
      reads.map(({ line, property, label, request }) => ({ line, property, label, request })),
    ).toEqual([
      {
        line: 4,
        property: 'payment_method_types',
        label: 'breaking',
        request: 'POST /v1/checkout/sessions payment_method_types',
      },
      {
        line: 7,
        property: 'trial_from_plan',
        label: 'breaking',
        request: 'POST /v1/checkout/sessions subscription_data.trial_from_plan',
      },
      { line: 9, property: 'subscription', label: 'breaking', request: undefined },
    ]);
  }
});
