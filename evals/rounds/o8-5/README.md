# O8 round 5

Locked before any paid run. It tests round 4's fixes on fresh repos: the prompt's rules on versions in more than one layer and on code that strips a dead thing, and the wider env templates.

**Rule:** same order and cap as rounds 3 and 4, continuing over the repos they didn't use, until there are 8.

| Picked, in order                 | Provider         | Checks at baseline     | Why it's here                                                                           |
| -------------------------------- | ---------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `lnmjkessel-code/v13`            | Shopify          | typecheck, build       | Enum and codegen config                                                                 |
| `Naqi-Haider/Hype-Counter`       | Shopify          | typecheck, build       | Same, in JavaScript                                                                     |
| `AB-Insightful/ab-insightful`    | Shopify          | typecheck, build, test | A cookie Shopify stopped setting, a raw REST URL, and a test cookie dump the scan flags |
| `stellalphatic/voiceify`         | Meta             | typecheck, build, test | A preset URL in a connector catalog                                                     |
| `saurabhbisht95/ai-career-coach` | Gemini           | build                  | Five call sites                                                                         |
| `ownerofstudio37/websitefors37`  | Meta             | typecheck, build       | A version in a webhook route                                                            |
| `AmandaOrg/udara`                | Meta, OpenRouter | typecheck, build, test | A model with no named replacement                                                       |
| `ingridandrade-ctrl/arthea`      | Anthropic        | typecheck, build       | A default, a saved config and a picker                                                  |

| Left out                                                                                                                                                                                                                                                                                                      | Reason                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `brunaszarin/spotlight-manager`, `speedcubing-ireland/speedcubingireland.com`, `polidario/weeklyhow-remix-app`, `jadenScali/Aeo-Optimizer`, `sanjeev744/smart-bundle`, `Nuraveda/shopify-agentic-seo-app`, `Rakesh161rausahn/promo-banner-app`, `chandandadhekar/ListAI-V2`, `tmtuan04/qr-code-product-remix` | Green, but past the Shopify cap |
| Every red repo in rounds 3 and 4, plus `newideasacct-lab/ai-peacemaker`, `ArseniyX/taskly`, `AlazabDev/az-wa`, `Shopify/editions-dev-2025-workshop-customer-account`, `EF-CHAIN/SendAm`, `drizzle-team/tento`, `Totex-Motors/Totexgest`                                                                       | A check fails at baseline       |

The 8 repos have different trees. The screen stopped once 8 were picked. `saurabhbisht95/ai-career-coach` was screened in an earlier set, and it has one check.

**Locks:** `ab-insightful` R4 and `udara` R2 have no replacement to look for, because the list names none: a cookie read has no drop-in, and OpenRouter published no successor. Removing the dead name passes, and the hand-check reads what took its place.
