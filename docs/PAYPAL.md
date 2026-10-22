# PayPal

Refit has no PayPal agent yet (`adapter: null` in the catalog). This page covers the review-only groundwork toward one: finding the PayPal REST requests a repository makes and matching each to PayPal's published contracts. Nothing here changes code, and nothing contacts PayPal. The goal and its milestones are in [Provider goals](PROVIDER-GOALS.md#paypal).

Why it matters: `@paypal/checkout-server-sdk`, PayPal's original Node server SDK, is deprecated on npm, which names `@paypal/paypal-server-sdk` as its replacement. The two packages share no class or method names, so moving between them rewrites every request site. The new package also renamed every controller method in 0.7.0. Refit does not propose that rewrite: replacing the package is an owner decision. This command lists the sites a person would change.

## List the PayPal requests

```sh
refit paypal --repository /path/to/app
refit paypal --repository /path/to/app --json
```

Refit reads JavaScript and TypeScript source and `package.json` files, without installing or running anything. It reports three kinds of request:

- **`@paypal/checkout-server-sdk` request classes.** `client.execute(new paypal.orders.OrdersCreateRequest())`, where `paypal` comes from `require('@paypal/checkout-server-sdk')`, a default or namespace import, or `import paypal = require(…)`. The area can also be bound by name (`const { orders } = paypal`, `import { orders } from '@paypal/checkout-server-sdk'`), and so can the class (`const { CapturesRefundRequest } = paypal.payments`). A request held in `const request = new …` or `request = new …` is followed to the call it is passed to. Environments and `PayPalHttpClient` are set-up, not requests.
- **`@paypal/paypal-server-sdk` controller calls.** `new OrdersController(client).createOrder({ body })`, or the same method on a variable or class property holding `new OrdersController(client)` (including `this.orders = new OrdersController(client)` in a constructor), with the controller imported by name, required by destructuring, or reached through a namespace (`sdk.OrdersController`). This is the shape the package's own documentation shows: `const ordersController = new OrdersController(client);` ([doc/controllers/orders.md at 2.5.0](https://github.com/paypal/PayPal-TypeScript-Server-SDK/blob/2.5.0/doc/controllers/orders.md)).
- **Raw HTTP to PayPal's REST hosts.** A string, template or `+` concatenation that starts with `https://api-m.paypal.com`, `https://api-m.sandbox.paypal.com`, `https://api.paypal.com` or `https://api.sandbox.paypal.com`, or with a constant holding one. A base can be a conditional between the live and sandbox hosts (`live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'`) and can be exported from another file and imported by name. The URL is followed to `fetch`, `axios` or a helper, as `refit meta-graph` does for Graph API URLs.

Each request lists:

| Field               | Meaning                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`              | `checkout-sdk`, `server-sdk` or `url`.                                                                                                                                                                        |
| `file`, `line`      | Where the request is made: the request class, the controller call, or the HTTP call. A URL no call uses is reported at the URL.                                                                               |
| `request`, `client` | `orders.OrdersCreateRequest` or `OrdersController.createOrder`, and the call that sends it (`client.execute`, `fetch`, `axios.post`, a helper).                                                               |
| `method`, `path`    | The HTTP method and path. SDK requests come from the SDK's own source (see [below](#the-recorded-requests)); `/v2/checkout/orders/{orderId}/capture` in a URL names runtime segments in braces.               |
| `hosts`             | The REST hosts a URL can reach; empty for SDK calls, whose host the SDK's environment chooses.                                                                                                                |
| `operation`         | The matching operation in PayPal's published OpenAPI documents (`orders.capture` in `checkout_orders_v2.json`), or null.                                                                                      |
| `counterpart`       | The controller methods of the newest recorded `@paypal/paypal-server-sdk` release that make the same request. For an old-SDK request this is where a migration would land; `[]` means no controller makes it. |
| `notes`             | Facts for review: a request the published documents do not list, a host they do not list, a method the declared SDK release does not define.                                                                  |
| `unknown`           | Each thing Refit could not read, and why.                                                                                                                                                                     |
| `use`               | `test` for test, spec, story, fixture and example files, which the text output lists separately.                                                                                                              |

The report also lists each declaration of either package with its declared and locked version, and npm's deprecation notice for `@paypal/checkout-server-sdk`.

### What is read, and what stays unknown

- **SDK release.** Method availability is checked against the locked `@paypal/paypal-server-sdk` version, or an exact declared one. With only a range such as `^2.0.0` and no lockfile, Refit says it did not check.
- **Untraced requests.** A request class that reaches no call, or reaches a function other than `execute`, is reported with that reason. A controller method that no recorded release defines is reported with a null path.
- **Raw URLs.** Methods come from `fetch(url, { method })` (GET when absent), `axios.<verb>` and `axios({ url, method })`. A URL passed to any other function is reported with that function as the client and an unknown method. A path built from a runtime value named like a path (`${path}`, `${endpoint}`), or starting with one, is unknown. A `let` assigned again may hold another URL at the time of the request.
- **Not covered.** A base read from an environment variable (`process.env.PAYPAL_API_URL`), axios instances created with a PayPal `baseURL`, and controllers passed between files or functions. These are not reported. A comment never counts.
- **What a match means.** `operation` says the method and path appear in the published documents at the pinned commit. It does not say a request body or response is compatible. A missing operation is a fact about those documents, which cover 13 APIs; it is not proof that PayPal retired the endpoint.

## The recorded requests

[`data/paypal-requests.json`](../data/paypal-requests.json) is generated by [`scripts/paypal-requests.mjs`](../scripts/paypal-requests.mjs) from package sources read as text, never installed or run:

- **`@paypal/checkout-server-sdk` 1.0.3**, the latest release: 15 request classes and the `this.path` and `this.verb` each sets, plus npm's deprecation notice for that release.
- **Every `@paypal/paypal-server-sdk` release from 0.5.1 to 2.5.0** (13 releases): each controller method's HTTP method and path, from `createRequest` and `appendTemplatePath`, and the releases that define it. The build fails if a method's request changes between releases.
- **PayPal's published OpenAPI documents** from [paypal/paypal-rest-api-specifications](https://github.com/paypal/paypal-rest-api-specifications) at commit `90e8041` (2026-04-07): 13 documents, their servers and every operation's method, path and `operationId`.

```sh
npm pack @paypal/checkout-server-sdk@1.0.3 --ignore-scripts   # and each @paypal/paypal-server-sdk release
curl -o checkout-registry.json https://registry.npmjs.org/@paypal%2fcheckout-server-sdk
git clone https://github.com/paypal/paypal-rest-api-specifications specifications
node scripts/paypal-requests.mjs --checkout checkout/package --checkout-registry checkout-registry.json \
  --server server/0.5.1/package --server … --specifications specifications --checked-at 2026-10-21 \
  --output data/paypal-requests.json
```

What the recorded sources show (checked 2026-10-21):

- **Every request the newest server SDK makes is in the published documents except two.** `POST /v1/oauth2/token` (`OAuthAuthorizationController.requestToken`) has no published document; `GET /v1/billing/subscriptions` (`SubscriptionsController.listSubscriptions`) is not in `billing_subscriptions_v1.json`. A test pins this list.
- **One old-SDK request has no counterpart.** `OrdersValidateRequest` sends `POST /v2/checkout/orders/{order_id}/validate-payment-method`, which is in neither the published Orders document nor any server SDK release. `RefreshTokenRequest` (`/v1/identity/openidconnect/tokenservice`) has no published document either.
- **Hosts differ.** `@paypal/checkout-server-sdk` 1.0.3 calls `https://api.paypal.com` and `https://api.sandbox.paypal.com` (`lib/core/paypal_environment.js`). `@paypal/paypal-server-sdk` 2.5.0 and every published document name `https://api-m.paypal.com` and `https://api-m.sandbox.paypal.com`. Refit notes a raw call to an `api.` host; whether PayPal still serves it was not checked.
- **0.7.0 renamed every controller method.** 0.5.1 to 0.6.1 use `ordersCreate`, `capturesRefund`, `paymentTokensCreate`; 0.7.0 and later use `createOrder`, `refundCapturedPayment`, `createPaymentToken` for the same requests. The package's CHANGELOG (commit `b02a9b9`) covers 1.0.0 to 2.4.0 only and does not mention it. 2.0.0 added the Subscriptions and Transaction Search controllers, and its CHANGELOG lists "several model renames" as breaking.

## Measured on a frozen set

[`benchmarks/2026-10-21-paypal-repos.json`](benchmarks/2026-10-21-paypal-repos.json) was frozen before any scan by [`scripts/paypal-select.mjs`](../scripts/paypal-select.mjs). GitHub code search is unavailable to this environment, so candidates come from npm search, as for the OpenAI and Anthropic sets: 22 queries returned 14,745 packages. A package qualified when its latest manifest declares either SDK in `dependencies`, links a github.com repository and was published since 2022-01, excluding `@paypal/` packages. Only **22 repositories** qualified, not the 50 the goal asks for. 16 declare `@paypal/paypal-server-sdk` and 8 `@paypal/checkout-server-sdk` (two declare both). **The set is libraries, not applications:** Medusa payment plugins, payment abstraction SDKs, a NestJS module and an AI tool collection. One entry (`payloadcms/payload`) is a package whose manifest links the Payload monorepo rather than its own source.

[`scripts/paypal-benchmark.mjs`](../scripts/paypal-benchmark.mjs) scanned each repository at its pinned commit from a pinned worktree at `1ec93a8`, with no code installed or run and nothing sent to PayPal ([results](benchmarks/2026-10-21-paypal-results.json)):

| Measure                                                        |   Result |
| -------------------------------------------------------------- | -------: |
| Repositories                                                   |       22 |
| Scanned                                                        |       17 |
| Not scanned (over the 50 MiB or 128-configuration scan limits) |        5 |
| Scanned repositories with a live PayPal request                |       11 |
| Live requests reported                                         |       90 |
| … `@paypal/paypal-server-sdk` controller calls                 |       82 |
| … raw REST calls                                               |        8 |
| … `@paypal/checkout-server-sdk` request classes                |        0 |
| Path known                                                     |       90 |
| Matched to a published operation                               |       83 |
| Real request with the right method and path, on hand review    | 90 of 90 |

Each of the 90 was read against its source line. The 7 without a published operation are `POST /v1/oauth2/token` (4), `POST /v1/identity/generate-token` (2) and `GET /v1/billing/subscriptions` (1), none of which the published documents list. 5 raw calls go to `api.paypal.com` or `api.sandbox.paypal.com`, which those documents do not list as servers.

**Tracing.** A text cross-check counted 116 lines that look like SDK calls: a request class the old SDK defines constructed with `new`, or a controller method name called in a file that names either package or a controller class. That is a heuristic, not a hand label. The scan reported 82 of them:

- **15** are in the 3 repositories over the scan limits (`sourcefuse/loopback4-microservice-catalog`, `zelavis/zelavis` and `zakariaelas/medusa`).
- **9** are not SDK calls. Two Medusa plugins wrap the SDK in their own `PaypalService` and call it as `this.client.captureOrder(id)` with the same method names.
- **10** are real misses. `playflixtv/paypal` gets its controller from another file's getter, `this.client.getSubscriptionsController()`, which is not traced.

So 82 of the 92 real SDK call lines in scanned repositories were traced (89%), short of the 90% target. One more repository makes its requests through an axios instance created from an object of host constants (`baseURL: this.baseUrl_`), which the scan does not read. It reports nothing there.

**Old-SDK coverage comes from a supplement.** Every `@paypal/checkout-server-sdk` request in the set is in the over-limit repositories. Scanning only the package directory that holds the PayPal code in those 3 ([supplement](benchmarks/2026-10-21-paypal-subdirectory-results.json)) traced all 15 of their call lines. 12 are old-SDK requests through `this.client.execute(…)` or `this.paypal_.execute(…)`, each matched to a published operation and to a `@paypal/paypal-server-sdk` counterpart. These are not counted in the table.

The other old-SDK declarations make no request the scan or the cross-check finds. `AntiHero/nestjs-paypal` only builds the client, and `Jump-Comedy/medusa-payment-paypal` calls PayPal through its own axios client. `shopnex-ai/shopnex` and `pip-services-ecommerce2/service-paymentmethods-node` declare the package without using it in source. `medusajs/medusa` and `payloadcms/payload` were not scanned, and the cross-check finds no call line in either. `usepaykit/paykit-sdk` holds only a README at the pinned commit.

Bases from environment variables with a host default, constant tables of hosts and functions that return a host, axios instances created with a PayPal `baseURL`, and controllers exported from one file and used in another are read since 2026-10-22; the numbers are in [PayPal progress](PAYPAL-PROGRESS.md).
