# O8 round 6

Locked before any paid run. It tests round 5's fixes: check output stays out of the diff, and an entry with no named replacement gets Needs a look. It also runs on Pierce's newer scanner, which flags imports of old REST classes.

**Rule:** same order as rounds 3 to 5. The list of 93 ran out under the cap of 3 per provider, with 4 repos left. The other 4 slots go, in the same order, to green repos past the cap, those naming more than one provider first. After this round every green repo in the list with more than one provider has been used.

| Picked                                       | Provider           | Checks at baseline     | Why it's here                                     |
| -------------------------------------------- | ------------------ | ---------------------- | ------------------------------------------------- |
| `brunaszarin/spotlight-manager`              | Shopify            | typecheck, build, test | Under the cap                                     |
| `speedcubing-ireland/speedcubingireland.com` | Shopify            | typecheck, build, test | REST classes imported by version                  |
| `polidario/weeklyhow-remix-app`              | Shopify            | typecheck, build       | REST classes, and the webhook version             |
| `Ganapathi1618/Nextjs-Fastrill-ai`           | Meta               | typecheck, build       | The OAuth dialog URL, in three pages and a script |
| `chandandadhekar/ListAI-V2`                  | Shopify, OpenAI    | typecheck, build       | Past the cap, more than one provider              |
| `jahmedabeer/Shopify-Storefront-AI-agent`    | Shopify, Anthropic | typecheck, build       | Past the cap, more than one provider              |
| `Shopify/shop-chat-agent`                    | Shopify, Anthropic | typecheck, build, test | Past the cap, more than one provider              |
| `jadenScali/Aeo-Optimizer`                   | Shopify            | typecheck, build       | Past the cap, next in order                       |

Green and past the cap, left out: `sanjeev744/smart-bundle`, `Nuraveda/shopify-agentic-seo-app`, `Rakesh161rausahn/promo-banner-app`, `tmtuan04/qr-code-product-remix`, `Shopify/example-storefronts--customer-account-api-authentication--javascript`, `Mdy305/LolaDesk`, `jgasimli04/marketoracle`, `iqbaldp/shopify-promotion-agent`, `mdrahbar21/shopifyApp`, `hookdeck/shopify-festive-notifications`. Every other repo in the list was used or failed a check at baseline. The 8 repos have different trees.

**Locks:** a REST import passes once the versioned path is gone. A fix that keeps it and wraps the classes fails its lock, though the scan would flag that too, and the hand-check would read it.
