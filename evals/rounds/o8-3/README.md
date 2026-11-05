# O8 round 3

Locked before any paid run. It's the first scored round on Pierce's real scanner, and the first with Shopify and Meta breaks.

**Rule:** the real scanner ran over all 196 repos cloned from the dev sets. Of those with a live finding that no round has used, 93 repos, take them in order of the SHA-256 of `rebuild-round-3:<lower-cased owner/name>`. Keep each repo that passes its own checks in the $0 screen, at most 3 per provider, until there are 8. The provider cap stops one template family filling the round.

| Picked, in order                                | Provider | Checks at baseline     |
| ----------------------------------------------- | -------- | ---------------------- |
| `tungbinzzz/instagram-app-shopify`              | Shopify  | typecheck, build       |
| `sabbir-noyon/wishkit-app-shopify`              | Shopify  | typecheck, build       |
| `ksyp-7/shopify-theme-app-extension-vite-react` | Shopify  | typecheck, build       |
| `diegocsrdias/postmedia`                        | OpenAI   | typecheck, build       |
| `imran-farooq7/next-gen-ai-yt`                  | Gemini   | typecheck, build       |
| `Cap-go/videoclub`                              | Meta     | typecheck, build, test |
| `newfold-labs/wp-module-facebook`               | Meta     | build                  |
| `hridoyhossain1001/buykori-client-portal`       | Meta     | typecheck, build       |

| Left out                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Reason                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `meisbobzheng/pinpoint-archive`, `LazerTechnologies/shopify-app-development-course`, `aaronarrays/shopify-vercel-app`, `lnmjkessel-code/v13`, `Naqi-Haider/Hype-Counter`                                                                                                                                                                                                                                                                                         | Green, but past the Shopify cap |
| `SGFGOV/medusa-plugin-shopify-ts`, `gruntlord5/cloudflare-react-router7-shopify-d1`, `dcam9586/scout-source2`, `Priyadharshini29-M/Combo-page-app`, `kellyannclark/subscription-sync`, `sanjeev744/smart-slidecart`, `Shopify/loyalty-extension-example`, `sachin21kumar/Infinite-bundler`, `matheuscpatricio/omafit`                                                                                                                                            | A check fails at baseline       |
| `anderrsc/crm-bielenki`, `Jam7-UK/bizzblox-social`, `Mukul0610/Enterprise_qua`, `Shards-foundation/shards-workflow-hub`, `aaqibqadeer/ScrapperNinjaa`, `ventas-png/control-consumo-agua`, `marioce12-bot/Chariow`, `ZoaZone/marketer`, `framerslab/agentos`, `iamgenesistech-hub/IAGT_AI_VIRAL_ENGINE`, `avinashquikboom-code/quickboom-crm-backend`, `jamalsoueidan/booking-api`, `inploi/postiz-app`, `drewmully/newreserve`, `CarlosReyes0/mon-unlock-widget` | A check fails at baseline       |
| `jaguar999paw-droid/lavira-media-engine`, `vaughnxmedia-alt/VX_KORA`                                                                                                                                                                                                                                                                                                                                                                                             | No checks to run                |

The 8 repos have different trees. No Stripe repo in this order passed its checks, so Stripe isn't in this round.

**Locks:** each says the dead name is gone from the file and the replacement from the list is there. A Shopify lock accepts the enum, the plain version string or `LATEST_API_VERSION`, since the fix depends on what the repo's SDK has. These locks show the name moved, not that a live call works, and the hand-check reads each diff for what a name can't show.
