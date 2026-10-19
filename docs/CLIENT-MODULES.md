# Shared SDK clients

Refit traces supported clients through a shared static module graph. The same binding is used for affected calls, mutation checks, API-version evidence and imported read-only AI context. Existing operator-authored response, request and endpoint rules use this graph without adding provider-specific scanner code.

## Default ESM exports

```ts
// client.ts
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2022-08-01' });
export default stripe;

// history.ts
import stripe from './client.js';
```

A directly exported constructor expression, such as `export default new Stripe(...)`, also works. Direct relative named imports of `export const` clients remain supported. Immutable local aliases are followed; mutation or exposure through any supported consumer downgrades linked usages.

## CommonJS clients

Stripe supports [callable initialization](https://github.com/stripe/stripe-node/blob/v19.1.0/README.md#usage):

```js
// client.cjs
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-08-01' });
module.exports = stripe;

// history.cjs
const stripe = require('./client.cjs');
```

`new Stripe(...)` also works. Refit recognizes static SDK constructor loads through a direct `require`, an explicitly mapped named/default member, or TypeScript `import Stripe = require('stripe')`. CommonJS named shared clients can use `module.exports = {stripe}`, `exports.stripe = stripe` or `module.exports.stripe = stripe`; consumers use direct member access or immutable destructuring. The names may be aliased. Direct `module.exports = stripe` is a different value from `exports.default = stripe`; Refit does not guess interop between those forms or between local ESM and CommonJS modules.

For another SDK, set `constructorCalls: true` in its reviewed provider adapter only when its constructor is documented to work without `new`. The default for custom adapters is false. The built-in Stripe adapter enables it. This setting describes initialization, not a migration rule; adding it alone does not create a new PR identity.

## Client factories and lazy clients

A client created behind a factory is traced when every value the factory can return is an SDK client or `null`:

```ts
let client: Stripe | null = null;
export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('missing key');
  client ??= new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' });
  return client;
}

// Consumers, in any module:
const stripe = getStripe();
await getStripe().subscriptions.retrieve(id);
```

The factory may be a function declaration or a `const` arrow or function expression, with any parameters; it may throw. A module `let` holder counts only when every assignment to it is a client or `null`/`undefined` (`=`, `??=`, `||=`), and `return client ?? (client = new Stripe(...))` works too. `const stripe = key ? new Stripe(key) : null` is a client as well. Each constructor behind a factory declares that factory's API version, so a literal `apiVersion` is read and bumped as for a direct client. `stripe!.customers.create(...)` traces like `stripe.customers.create(...)`.

An `async` factory counts when every call to it is awaited at once (`const stripe = await getStripe()`, `(await getStripe()).customers.create(...)`), including one that awaits its key before filling a lazy holder. If any call stores, returns or passes the promise, or calls it optionally, the whole factory stays a review case. A factory also stays a review case when it is a generator, returns anything else on any path, is reassigned, or its holder is written any other way (destructuring, `++`, a non-client value).

## Boundaries

Only scanned source files are resolved. Relative imports and supported repository `paths`/`baseUrl` mappings share the same graph. Exact paths, unique extensionless file/index paths and unambiguous `.js` → `.ts`, `.mjs` → `.mts` and `.cjs` → `.cts` paths are supported. Ambiguous source/output pairs are refused. See [configured aliases and runtime boundaries](SOURCE-ALIASES.md).

Clients and constructor aliases must be immutable. Static CommonJS exports must be unambiguous top-level assignments to unshadowed globals; literal export objects may contain only supported identifier bindings. Namespace imports, re-exports, spreads, accessors, computed exports, changing the export object, shadowed or exposed loaders, unconfigured or unresolved aliases, dynamic imports and factory wrappers outside the shapes above remain review cases. Refit does not reproduce a bundler's module interop or a package's export map.

A confirmed finding means the usage was traced under the recorded adapter, not that arbitrary application behavior is proven. Strict source-version policy still requires resolvable matching options. Checks must exercise the application's intended contracts.

The bounded Stripe guarded-history rule can add the correct ESM import or CommonJS require for a traced shared client. It uses the Charges list endpoint with pagination rather than replacing complete history with `latest_charge`.

## Verification scope

Tests exercise actual Stripe SDKs 10.17.0 and 19.1.0 over loopback HTTP, demonstrate the original missing-history failure, and validate default-export and CommonJS factory migrations in offline Docker with locked npm dependency preparation. The checks cover pagination, empty history and declared Stripe-Version headers. Actual OpenAI SDK 7.32.0 tests cover ESM default and CommonJS clients for a simulated response rename and a nested request-field rename, preserving request values, headers and error propagation. The OpenAI renames are invented conformance cases, not historical vendor changes. No model generation or paid API request is used.
