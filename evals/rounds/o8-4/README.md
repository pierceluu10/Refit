# O8 round 4

Locked before any paid run. It tests the fix for unneeded major upgrades on more Shopify repos, and adds harder breaks: Meta fields and call shapes, a provider that shut down, and a repo with many files to move.

**Rule:** same order and cap as round 3, continuing over the repos round 3 didn't use: the SHA-256 of `rebuild-round-3:<lower-cased owner/name>`, at most 3 per provider, until there are 8. A repo's provider is the one most of its entries name, and the first entry's on a tie.

| Picked, in order                                   | Provider             | Checks at baseline | Why it's harder                                                                 |
| -------------------------------------------------- | -------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `meisbobzheng/pinpoint-archive`                    | Shopify              | typecheck, build   | The enum has no 2026-10                                                         |
| `LazerTechnologies/shopify-app-development-course` | Shopify              | typecheck, build   | A version in a hand-written URL too                                             |
| `aaronarrays/shopify-vercel-app`                   | Shopify              | typecheck, build   | The enum has no 2026-10                                                         |
| `dvygolov/AdReplica`                               | Meta                 | build, test        | Field names in request lists and identity logic, with both fields handled today |
| `AtonIA00/aton-member-dashboard`                   | Meta                 | typecheck, build   | Root `?ids=` calls must change shape                                            |
| `Hrithik450/harnes`                                | Meta                 | typecheck, build   | A plain version bump                                                            |
| `Muregis/educore-school-management-system`         | Groq, Meta           | build, test        | Env, config and deploy files                                                    |
| `ogSulem/pulse`                                    | OpenAI, GitHub, Meta | build              | A provider that shut down, and a metric whose read must move with its request   |

| Left out                                                                                                                                                                                                                                               | Reason                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `lnmjkessel-code/v13`, `Naqi-Haider/Hype-Counter`, `AB-Insightful/ab-insightful`, `brunaszarin/spotlight-manager`, `speedcubing-ireland/speedcubingireland.com`, `polidario/weeklyhow-remix-app`, `jadenScali/Aeo-Optimizer`, `stellalphatic/voiceify` | Green, but past the provider cap |
| Every red repo in round 3's list, plus `mssalemi/b-is-for-bundles`, `Intekhab78/JTS-Chat-Support`, `hak193/i-devr-code`, `darongmean/shopify-on-cloudflare`, `samikaran/fullstack-ecommerce-nextjs-shopify`, `BitsToBoot/new-auto-DM`                  | A check fails at baseline        |
| `jaguar999paw-droid/lavira-media-engine`, `vaughnxmedia-alt/VX_KORA`, `AntonVasylchenko/shopify-node-app`                                                                                                                                              | No checks to run                 |

The 8 repos have different trees. The screen stopped once 8 were picked, so later repos weren't read.

**Locks:** `pulse` R2 has no replacement to look for, because GitHub Models has no drop-in: the entry says a person must set up a new account. Removing the dead host, or making it configurable, passes. Extension `api_version` lines aren't locked, because the list says older UI extensions keep working. These locks show names and call shapes, so the hand-check reads each diff.
