# Monorepo and workspace attribution

In a monorepo, every finding `detectProviders` and `scanDeadlines` report now says which package of the repository it lives in, and whether its path is outside the product. `pipeline/workspace-attribution.ts` reads the layout from the repository's own files; nothing is installed or run. The output is additive: each piece of evidence gains two fields. Deadline matches on some excluded paths are listed apart and not counted (below).

- **`workspace`.** `{ path, name }` of the nearest enclosing package: a directory with a `package.json`, Nx `project.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile`, `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`, `pom.xml` or `build.gradle(.kts)`. It is `null` when no manifest encloses the file. `readWorkspaceLayout` also says which packages the root's workspace configuration includes:
  - npm and Yarn `workspaces` (array or `{ packages }`, with `!` negation);
  - `pnpm-workspace.yaml`, `lerna.json`, `rush.json`;
  - uv `[tool.uv.workspace]`, Cargo `[workspace]` and `go.work`;
  - Nx `nx.json` and Turborepo `turbo.json`, recorded as tools.

  A nested `package.json` with no workspace configuration is still a package, just not a member.
- **`excluded`.** Why a path is not product code, or `null`. Directory names are matched as whole segments, first match wins:

  | Reason | Directories |
  |---|---|
  | `node-modules` | `node_modules` |
  | `vendored` | `vendor`, `vendors`, `vendored`, `third_party`, `third-party`, `thirdparty` |
  | `build-output` | `dist`, `build`, `out`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `coverage`, `.turbo`, plus `*.min.js` and `*.bundle.js` |
  | `example` | `example(s)`, `sample(s)`, `demo(s)` |
  | `docs-site` | `doc(s)`, `website`, `documentation` |
  | `test-fixture` | `fixture(s)`, `__fixtures__`, `__mocks__`, `testdata`, `test-data`, `mocks` |

How the two scanners use them:

- **`detectProviders`** keeps every detection and marks each package and hostname with its place.
- **`scanDeadlines`** keeps every match's `use` as it was and adds the place. A match on a `docs-site`, `example`, `test-fixture` or `build-output` path is **listed but not counted** (owner decision, 2026-10-22): it goes to the exposure's `outside` list, never to `evidence`, so it does not count for `--fail-within`, deadline alerts or model-fix lists. `vendored` matches still count. A repository declares a deployed `website/` or `apps/demo` as application code in `.refit-application-paths.json`. [DEADLINES.md](DEADLINES.md#matches-outside-application-code-not-counted) has the exact paths, the output and the override.
- **`refit agents`** prints the place after each piece of evidence, for example `[example, package checkout-example]`.

**Versions from the right lockfile.** The root lockfile still decides when it covers a package. A nested `package.json` that it does not cover (an app with its own lockfile and no workspaces) is resolved against the `package-lock.json`, `pnpm-lock.yaml` or `yarn.lock` in its own directory, through the existing `resolveLockedDependency`. Other ecosystems already lock from the nearest ancestor lockfile (`pipeline/package-manifests.ts`), which covers a uv or Cargo workspace's single root lockfile.

## Measurement (2026-10-22)

**Monorepos in the frozen sets.** `scripts/workspace-monorepos.mjs` fetched the trees of all 922 repositories in the Stripe (100, 50, 381), Shopify (50, 200) and AI-app (100, 50) frozen sets at their frozen commits. 326 are monorepos ([list](benchmarks/2026-10-22-workspace-monorepos.json)):

| Signal | Monorepos |
|---|---:|
| `package.json` workspaces | 173 |
| `pnpm-workspace.yaml` | 58 |
| `turbo.json` | 6 |
| `nx.json` | 2 |
| More than one `package.json` (with or without the above) | 201 |

**Blind labels.** 20 monorepos were labelled before Refit ran on them ([labels](benchmarks/2026-10-22-workspace-labels.json), `scripts/workspace-sample.mjs`, seed 20261022): 10 with declared workspaces and 10 with only nested `package.json` files. Each was labelled from `scripts/workspace-label-candidates.mjs`, which imports no pipeline code. That covers 204 files: every `package.json` that declares a catalog SDK and every JS/TS file naming a provider host, model ID or API version. Each file gets its enclosing package and a category (product, test, or an exclusion reason). 133 of the 204 sit outside the root package. `pipeline/workspace-attribution-score.ts` scores them, with its own test.

| Run on the 20 labelled monorepos | Refit commit | Findings (labelled) | Package attribution correct | Live findings that are product code |
|---|---|---:|---:|---:|
| Before (every finding implicitly at the root) | `cf66902` | 119 (101) | 43.6% (44/101) | 94.9% (94/99) |
| After | `d7026fe` | 119 (101) | **100% (101/101)** | 94.9% (94/99) |

The after row is from `d7026fe`, before `015fe7a` added `setup.py`, `setup.cfg` and `Pipfile` as package manifests, so the head can differ from it; it was not rerun.

- **The attribution figure is partly by construction.** The labels use the same definition the code does: the nearest enclosing manifest. So the 100% shows the layouts are read correctly (nameless roots, nested apps, Shopify `extensions/*`, template collections); it does not test that definition against another one.
- **The 5 non-product live findings** are Stripe hostnames in one test file (`wevm/curl.md`, `src/api.workers.test.ts`). `detectProviders` hostname evidence has never told tests apart, and test files are not on this lane's exclusion list. The deadline scanner already marks tests as `test`.
- **Unlabelled findings.** 18 findings were outside the labelled files: non-npm manifests the candidate listing did not cover, and three files its patterns missed. They are left unscored rather than labelled after the fact.
- **No product finding was lost** (94 before, 94 after).
- **Exclusion accuracy is not measured.** The 204 labelled units are 200 product, 4 test and 0 excluded, and neither run placed a labelled finding on an excluded path, so these runs say nothing about how well the exclusion rules pick out non-product code.

**Excluded paths across all 326 monorepos** at `f4e587d` ([scan](benchmarks/2026-10-22-workspace-exclusions.json)): 1,496 findings, 311 of them outside the root package. Refit placed 11 findings, in 5 repositories, on excluded paths: 5 `example`, 4 `docs-site` and 2 `test-fixture`. Before attribution, every one of these counted as live. All 11 were looked at by hand (not blind) and match the rules above, but no per-finding verdicts were committed, so that check is unrecorded. Two of them are worth a reviewer's look: embedbase's `docs/` is a deployed docs site whose `docs/pages/api/qa.ts` calls OpenAI live. It is excluded by rule, but a customer might still want that exposure. Six repositories exceed the repository reader's existing scan limits (10,000 files) and were not scanned.

**Nested lockfiles** ([counts](benchmarks/2026-10-22-workspace-nested-locks.json)): 94 monorepos have a lockfile below the root; 2 of them (getcord/cord, litmajor/mtaa-dao) exceeded the repository reader's scan limits and were not counted. The other 92 hold 89 catalog SDK declarations in nested `package.json` files. Before, the root lockfile alone locked 6 of them; with per-package lockfiles, 74 are locked. That run is unpinned: the script did not check each checkout's commit or record Refit's commit and dirty state (it does now), so 6 → 74 is not tied to a Refit commit. Three were checked against their lockfiles by hand: Hungry-Harvest `backend` stripe 19.1.0, RefSpring `functions` 14.25.0 and ShipGenAI `ai-travel-studio` 22.2.0.

**What this means.** In these sets, monorepos are common (35%), and attribution moves 311 findings from an implied root to their real package. Findings on excluded paths are rare: 11 of 1,496, because the repository reader already skips `node_modules`, `dist`, `build`, `.next` and `coverage`, and the deadline scanner already marks tests. The larger practical gain is nested-lockfile versions (6 → 74, unpinned).

## Python, Rust and Go monorepos

uv workspaces, Cargo workspaces and `go.work` mark their members, and Python, Go and Rust manifests mark packages. Findings from FG5's package inventory (several `pyproject.toml` files) are attributed to their own package. They are locked from the workspace's root `uv.lock` or `Cargo.lock` through the nearest-ancestor rule. Tests use a real uv workspace (`Agent-Field/backai`, fixture header names its commit). These ecosystems were not part of the frozen sets above, so their attribution is tested but not measured on a sample.

## Reproduce

```sh
node scripts/workspace-monorepos.mjs --work <dir> --output docs/benchmarks/2026-10-22-workspace-monorepos.json
node scripts/workspace-sample.mjs --list docs/benchmarks/2026-10-22-workspace-monorepos.json --seed 20261022
node scripts/workspace-label-candidates.mjs --root <checkout>
node scripts/workspace-attribution-benchmark.mjs --labels docs/benchmarks/2026-10-22-workspace-labels.json --root <dir> --output <results.json>
node scripts/workspace-exclusions-scan.mjs --list docs/benchmarks/2026-10-22-workspace-monorepos.json --root <dir> --output <scan.json>
node scripts/workspace-nested-locks.mjs --list docs/benchmarks/2026-10-22-workspace-monorepos.json --root <dir> --output <counts.json>
```

`workspace-monorepos.mjs` fetches trees only. Check each repository out at its frozen commit (`git -C <dir> checkout --detach <commit>`) before running the scans.

**Not counting matches outside application code** ([before and after](benchmarks/2026-10-22-workspace-uncounted.json), `scripts/workspace-uncounted.mjs`, at `d7621ae`, clean). The exclusion scan above found excluded findings in 5 of the 326 monorepos; the other 321 had no live deadline match on an excluded path at `f4e587d`, so the decision does not change their counts (they were not rerun). The 5 were checked out again at their frozen commits:

| 5 repositories with an excluded finding | Deadlines counted as exposures |
|---|---:|
| Before (any live match counts) | 19 |
| After (matches outside application code listed, not counted) | 16 |

4 matches moved to the "not counted" list: communisaas/commons `tests/mocks/external-services.ts` (`meta-graph-v18-0`, test-fixture), embedbase `docs/pages/api/qa.ts` (`gpt-4`, docs-site; still counted from its other live code), and LocalRouter `website/src/components/GuardrailApprovalDemo.tsx` (`claude-3-5-sonnet`, docs-site) and `website/src/components/demo/TauriMockSetup.ts` (`gpt-4`, example). So commons loses one exposure and LocalRouter both of its two. embedbase's `docs/` is a deployed docs site that calls OpenAI live; its owner would add `docs` to `.refit-application-paths.json` to count it. The "before" column is computed from the same run (every live match, wherever it is), not from an older commit.
