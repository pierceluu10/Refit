---
provider: shopify
kind: sdk-major
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/CHANGELOG.md
  - https://github.com/Shopify/shopify-api-ruby/blob/main/CHANGELOG.md
  - https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-app-remix/README.md
  - https://shopify.dev/docs/api/shopify-app-react-router
---

# Shopify: SDK and app framework majors

**What usually changes.** Shopify's libraries drop old API versions and their REST resource classes, raise runtime minimums and tighten types on each major release:

- **`@shopify/shopify-api`** ([changelog](https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-api/CHANGELOG.md)):
  - v15 removed `eventId`/`resourceId` from events webhooks (use `webhookId`).
  - v14 requires Node 22+, removed webhook `subTopic` (use filters) and typed `graphQLErrors`.
  - v13 removed `customShopDomains` (use `domainTransformations`), dropped old API versions with their REST resources, and moved the Express adapter to Express 5.
- **`shopify_api` gem** ([changelog](https://github.com/Shopify/shopify-api-ruby/blob/main/CHANGELOG.md)):
  - 16.0 needs Ruby 3.2 and removed `Session#serialize`/`deserialize`.
  - 15.0 removed `ShopifyAPI::Webhooks::Handler` (use `WebhookHandler`) and the `LATEST_SUPPORTED_ADMIN_VERSION` constants, so set `api_version` explicitly.
- **`@shopify/shopify-app-remix`**: its README says to use it only for existing Remix apps and to upgrade to **`@shopify/shopify-app-react-router`**, following the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix).

**How to spot it.** Check `package.json` and the lockfile for `@shopify/shopify-api`, `@shopify/shopify-app-remix`, `@shopify/shopify-app-react-router`, `@shopify/shopify-app-express`, `@shopify/app-bridge*`, `@remix-run/*`. Check the `Gemfile.lock` for `shopify_api` and `shopify_app`. Look at imports of `restResources`, `LATEST_API_VERSION` and `ApiVersion`.

**What to check.**

- Read the changelog entries between the current and target majors. Each one lists required code changes.
- SDK upgrades often move the default or latest API version. Run `shopify_api_versions` on the version the new SDK uses, and run GraphQL documents through `shopify_validate_graphql` at that version.
- If the old code relies on REST resource classes the new major drops, `shopify_rest_to_graphql` gives the GraphQL replacements.
- For Remix to React Router: route modules, `@remix-run/*` imports and `authenticate.admin` call sites change, so follow the upgrade guide step by step.

**Pitfalls.** Session storage adapters are separate packages with their own majors. Check that the runtime in CI (Node or Ruby) meets the new minimum before blaming the code.
