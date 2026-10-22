# Report examples

Generated with `refit report`'s builder from public repositories in Refit's frozen benchmark sets, at the commits those sets pinned. Each repository was shallow-cloned, inventoried read-only (nothing installed or run, no provider contacted) and deleted. Days left are counted from 2026-10-22. The matched source lines were removed from the evidence afterwards, as reports no longer carry them (owner decision, 2026-10-22). These are examples of the format, not reviews of the repositories: the findings are what Refit's scanners report, including their known gaps.

Refit commit `12fb86a23f2a8cf2f1800f88641d3d7e1c973375`, command:

```bash
node scripts/report-examples.mjs --root <dir> --output docs/report-examples docs/benchmarks/2026-10-21-anthropic-app-repos.json:viperrcrypto/Siftly docs/benchmarks/2026-10-21-anthropic-app-repos.json:nextai-translator/raycast-openai-translator docs/benchmarks/2026-10-21-anthropic-app-repos.json:getmaxun/maxun docs/benchmarks/2026-10-21-anthropic-app-repos.json:kgoedecke/doop docs/benchmarks/2026-10-21-openai-app-repos.json:JohnRiceML/clawport-ui docs/benchmarks/2026-10-21-openai-app-repos.json:pdovhomilja/nextcrm-app docs/benchmarks/2026-10-14-stripe-repos.json:odota/core docs/benchmarks/2026-10-14-stripe-repos.json:Kanba-co/kanba docs/benchmarks/2026-10-14-stripe-repos.json:fogbender/b2b-saaskit docs/benchmarks/2026-10-16-shopify-repos.json:Hujjat/wishlist-inspire-app
```

| Repository | Commit | Frozen list | Integrations | Deadlines | Model calls |
| --- | --- | --- | --- | --- | --- |
| [viperrcrypto/Siftly](viperrcrypto--Siftly.md) | `b25daa45b858` | `docs/benchmarks/2026-10-21-anthropic-app-repos.json` | 2 | 1 | 0 |
| [nextai-translator/raycast-openai-translator](nextai-translator--raycast-openai-translator.md) | `13b28b08661a` | `docs/benchmarks/2026-10-21-anthropic-app-repos.json` | 3 | 2 | 1 |
| [getmaxun/maxun](getmaxun--maxun.md) | `4347a8f96b48` | `docs/benchmarks/2026-10-21-anthropic-app-repos.json` | 2 | 1 | 6 |
| [kgoedecke/doop](kgoedecke--doop.md) | `0f274ac01b21` | `docs/benchmarks/2026-10-21-anthropic-app-repos.json` | 5 | 1 | 4 |
| [JohnRiceML/clawport-ui](JohnRiceML--clawport-ui.md) | `40db84d69b79` | `docs/benchmarks/2026-10-21-openai-app-repos.json` | 2 | 2 | 2 |
| [pdovhomilja/nextcrm-app](pdovhomilja--nextcrm-app.md) | `ade5fcfb8137` | `docs/benchmarks/2026-10-21-openai-app-repos.json` | 2 | 0 | 12 |
| [odota/core](odota--core.md) | `b877fd1c169c` | `docs/benchmarks/2026-10-14-stripe-repos.json` | 1 | 0 | 0 |
| [Kanba-co/kanba](Kanba-co--kanba.md) | `d5dfe822a503` | `docs/benchmarks/2026-10-14-stripe-repos.json` | 1 | 0 | 0 |
| [fogbender/b2b-saaskit](fogbender--b2b-saaskit.md) | `148385ddf8a0` | `docs/benchmarks/2026-10-14-stripe-repos.json` | 2 | 2 | 0 |
| [Hujjat/wishlist-inspire-app](Hujjat--wishlist-inspire-app.md) | `684f64f9d21e` | `docs/benchmarks/2026-10-16-shopify-repos.json` | 1 | 0 | 0 |
