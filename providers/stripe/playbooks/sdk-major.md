---
provider: stripe
kind: sdk-major
reviewed: false
drafted: 2026-11-01
sources:
  - https://docs.stripe.com/sdks/versioning
  - https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md
  - https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22
  - https://docs.stripe.com/upgrades
---

# Stripe SDK major upgrade

**What changes.** Stripe SDKs use semver. A major bump means breaking SDK changes, such as renamed classes, changed types or removed methods ([SDK versioning](https://docs.stripe.com/sdks/versioning)). For most majors since 2023, the bump also moves the pinned API version. An SDK major is therefore usually also an API-version migration, so read the api-version playbook too. A few majors keep the same API version and only change the SDK surface. For example, stripe-node v22 rewrote the TypeScript types and made the default export a real class, so call `new Stripe(key)` and not `Stripe(key)` ([v22 guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v22)). stripe-go puts the major in the module path (`github.com/stripe/stripe-go/v87`), so every import changes.

**How to spot it.** Look at the dependency manifests and lockfiles. In code, grep for `require('stripe')` / `import Stripe from 'stripe'`, `import stripe`, `Stripe::`, `\Stripe\`, `com.stripe`, `stripe-go/v`, and `Stripe.net`. Watch for the newer client style (`StripeClient`, `client.v1.customers...`) next to the legacy global style (`stripe.Customer.create`, `Stripe.api_key =`).

**What to check.**

- `stripe_api_versions` with `sdk` (e.g. `"stripe-node@18"`) shows which API version each major pins. Then call it with `version` set to the old pin and `target` set to the new pin to list the API breaking changes the bump pulls in.
- The ⚠️-prefixed items in the SDK CHANGELOG for every major you cross, and the migration guide in the repo wiki. Docs say the wiki holds both the guides and the major-to-API-version mapping ([SDK versioning](https://docs.stripe.com/sdks/versioning)).
- Runtime support. Older Node, Python and Ruby versions get dropped in later majors ([SDK versioning](https://docs.stripe.com/sdks/versioning)), so check CI images.
- `stripe_check_params` on the calls the repo makes, with the new pinned version.

**Pitfalls.** Skipping several majors at once multiplies the breaking changes. Go upgrades need the import path changed everywhere, including in tests. With Java, Go or .NET, webhook endpoints must be on the SDK's pinned version or events fail to deserialize ([webhook versioning](https://docs.stripe.com/webhooks/versioning)). An explicit `apiVersion` override that is older than the new pin keeps old response shapes while the types describe new ones.
