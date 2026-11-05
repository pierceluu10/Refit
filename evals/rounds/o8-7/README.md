# O8 round 7

Locked before any paid run. It tests round 6's fixes: after a version move the session runs the provider's checking tool on every document, it works through each entry's "requires" lines, and `finish` takes `requirementsLeft`.

It's also the first round to measure true first runs. Saved installs are cleared before it starts, so no repo reuses a screen's install, and the sandbox has its new cap of 4 CPUs.

**Rule:** the 10 green repos round 6 left past the provider cap, in the same order. That uses up the list of 93. All 10 have different trees.

| Picked                                                                         | Provider        | Checks at baseline | Required |
| ------------------------------------------------------------------------------ | --------------- | ------------------ | -------- |
| `sanjeev744/smart-bundle`                                                      | Shopify         | typecheck, build   | 5        |
| `Nuraveda/shopify-agentic-seo-app`                                             | Shopify         | typecheck, build   | 3        |
| `Rakesh161rausahn/promo-banner-app`                                            | Shopify         | typecheck, build   | 2        |
| `tmtuan04/qr-code-product-remix`                                               | Shopify         | typecheck, build   | 2        |
| `Shopify/example-storefronts--customer-account-api-authentication--javascript` | Shopify         | typecheck, build   | 2        |
| `Mdy305/LolaDesk`                                                              | Shopify, Stripe | build              | 1        |
| `jgasimli04/marketoracle`                                                      | Shopify         | typecheck, build   | 2        |
| `iqbaldp/shopify-promotion-agent`                                              | Shopify         | typecheck, build   | 2        |
| `mdrahbar21/shopifyApp`                                                        | Shopify         | typecheck, build   | 1        |
| `hookdeck/shopify-festive-notifications`                                       | Shopify         | typecheck, build   | 3        |

**What this round can't show:** a $0 sweep at 2026-10 finds no dead document in these 10 repos, so the rule about documents can't move their results. That's what `rerun-lock.json` is for. It reruns `polidario/weeklyhow-remix-app`, `ksyp-7/shopify-theme-app-extension-vite-react` and `jahmedabeer/Shopify-Storefront-AI-agent`, and adds `productVariantUpdate` to the first two. A second pass adds `chandandadhekar/ListAI-V2` and `Shopify/shop-chat-agent`, to see whether the numbered requirements cost more or label too much as Needs a look. `regression-lock.json` then reruns round 7's 10 repos and 3 of those on the final prompt, to see whether the numbered requirements change labels or cost. Those repos aren't fresh, so the reruns don't count toward any score. A lock can't read refusal handling, so the hand-check reads `Shopify-Storefront-AI-agent`.

**Left out of the locks:**

- `Mdy305/LolaDesk` pins Stripe at `2024-06-20`, which predates the field removals its 4 Stripe findings name, so those aren't required.
- The list says not to bump a UI extension's `api_version` alone, so `extensions/banner-extension/shopify.extension.toml` isn't required.
