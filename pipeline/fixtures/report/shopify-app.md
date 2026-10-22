<!-- refit-report -->
# What `Shopify/example-app--qr-code--remix` depends on

Counted on 2026-10-22 at commit `6ed425cab13f`, from files only: Refit ran no code and contacted no provider.

## Next step

Plan to move off `2026-01` before 2027-01-16 (86 days left). Replacement: a supported stable version.

## Integrations

| Provider | Package | Declared | Locked | Refit |
|---|---|---|---|---|
| Shopify | `@shopify/shopify-app-react-router` in `package.json` | `^1.1.0` |  | Agent available: migrates breaking changes once added |

## Deadlines

- **2027-01-16** (86 days left): Shopify API version 2026-01 stops being accessible at 15:00 UTC. Requests fall forward to the oldest accessible stable version. Replacement: a supported stable version. [Source](https://shopify.dev/docs/api/usage/versioning)
  - `app/shopify.server.js:16`: `apiVersion: ApiVersion.January26,`
  - `app/shopify.server.js:40`: `export const apiVersion = ApiVersion.January26;`

## AI model calls

No OpenAI or Anthropic text-generation calls traced.

## Hosts Refit does not track

None.