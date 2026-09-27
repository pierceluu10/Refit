# Upstream Stripe replay evidence

The local pipeline was exercised against the following real Stripe OpenAPI revisions. These files were downloaded through `stripe:snapshot`, then consumed offline by `stripe:scan --propose-patch` against `pipeline/fixtures/repository`.

| Input | Upstream commit | SHA-256 of original specification text |
| --- | --- | --- |
| Before | `da4ef11c8691eb41e6b2a8d86c13343a973633e4` (2022-11-10) | `b3cc0093e33c24deca89483353bd35f0bd98b0201791115c593bc9d898eacafd` |
| After | `37236d21d9ef0c3e109e26f7a398c783ca1dde8c` (2022-11-17) | `3509a551af04a720739a367e41fc3a72c24b9ba70a7a36e2e493bcea36ab974b` |

Sources: [before specification](https://raw.githubusercontent.com/stripe/openapi/da4ef11c8691eb41e6b2a8d86c13343a973633e4/openapi/spec3.json), [after specification](https://raw.githubusercontent.com/stripe/openapi/37236d21d9ef0c3e109e26f7a398c783ca1dde8c/openapi/spec3.json).

Observed result: two direct schema-property removals, one confirmed code finding at `billing.ts:7`, status `affected`, and one proposed migration with zero unresolved **detected findings**. This is not proof that the entire API change is covered. The current differ ignores many classes of breaking changes, and the scanner supports only bounded local Stripe patterns.

This verifies real upstream ingestion and the path from a real specification removal to a code proposal. It does not verify a production application, an SDK upgrade, API-version applicability, sandbox validation or PR publication. No Stripe account or live payment request was used. See the README for reproducible commands.
