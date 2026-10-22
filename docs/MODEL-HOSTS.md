# Cloud-hosted models: Bedrock, Azure OpenAI and OpenRouter

Customers often call OpenAI, Anthropic and other models through a cloud host instead of the provider's own API. `pipeline/model-hosts.ts` finds those call sites in JS/TS source, report only. Nothing is edited.

| Host           | What is reported                                                                                                                                                                                                                                                                        | Named stop                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Amazon Bedrock | Model IDs (`anthropic.claude-3-sonnet-20240229-v1:0`, cross-region `us.`/`eu.`/`apac.`/`global.`/`us-gov.` profiles, unversioned IDs such as `us.anthropic.claude-haiku-5-5`) and model or inference-profile ARNs. An Anthropic ID also names its Claude API model as `upstream`.       | `bedrock-lifecycle-unknown`                                                                                                                                  |
| Azure OpenAI   | `api-version` values (client `apiVersion`, a quoted `api-version` key, `?api-version=` in URLs, including `v1`) and deployment names (any `…deployment…` key, the `model` an Azure client sends, `/openai/deployments/<name or ${expr}>/`, and `AZURE_OPENAI_*DEPLOYMENT*` env values). | `azure-deployment-name`: a deployment name is the customer's own, so check which model it runs in Azure. `azure-api-version-lifecycle-unknown` for versions. |
| OpenRouter     | `namespace/model` IDs in its model namespaces (`openai/…`, `anthropic/…`, `moonshotai/…`, `openrouter/auto` and others), in any file that names OpenRouter. The provider part becomes `upstream`.                                                                                       | `openrouter-alias` when the ID is not dated and names no registry model                                                                                      |

How the findings are used:

- **Deadlines.** `scanDeadlines` reports an OpenRouter ID that names a retired registry model exactly (`openai/gpt-4-0613`, `anthropic/claude-3-opus-20240229`) under that model's deadline, with the route in its evidence text. This is the "Keep going" item; it reuses the OpenAI and Anthropic entries. Bedrock and Azure sites match only registry entries kept for the host itself: the new registry providers `bedrock` and `azure-openai`. They never match the provider's own date, because the clouds retire models on their own schedules.
- **Model replacements.** Through FG9's report-only hook (`REPORT_ONLY_SOURCES` in `pipeline/model-retirements.ts`; this lane adds the one call), host sites are listed as stops with a reason instead of being edited or left unresolved.

## Registry entries: Blocked

The lane asks for registry entries from three official pages, read and cited:

- the Amazon Bedrock model lifecycle page (`docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html`);
- the Azure OpenAI model retirements page (`learn.microsoft.com/…/openai/concepts/model-retirements`);
- the Azure OpenAI API version lifecycle page (`learn.microsoft.com/…/openai/api-version-lifecycle`).

All three were refused by this session's network proxy (connection rejected) on 2026-10-22, and again on one retry. Per the shared rules, no date was added from memory or a search summary.

The matchers exist and are tested with illustrative, test-only entries, so adding the real entries needs data only:

- `provider: "bedrock"`, `kind: "model"`, with Bedrock model IDs as `versions`;
- `provider: "azure-openai"`, `kind: "api-version"`, with api-version strings.

## Measurement (2026-10-22)

**Sample.** [`2026-10-22-model-hosts-repos.json`](benchmarks/2026-10-22-model-hosts-repos.json): 45 repositories, 15 per host, pinned at HEAD and selected by `scripts/model-hosts-select.mjs` from npm search. GitHub search was unreachable, as for the Gemini set, so these are libraries and tools that publish an npm package with the host SDK, not applications. Most host identifiers in them sit in tests and model catalogs; few are live calls.

**Labels.** `scripts/model-hosts-label-candidates.mjs` imports no pipeline code. It lists every line that a pattern wider than the detector flags, and a seeded random 12 lines per repository were labelled blind. For each line, I recorded its host identifiers and how the line uses them (call, catalog, test, example or doc), before Refit ran on that repository. `pipeline/model-hosts-score.ts` scores only detections on labelled lines, with its own test.

- [First set](benchmarks/2026-10-22-model-hosts-labels.json): 20 repositories (7 Bedrock, 7 Azure, 6 OpenRouter), 215 lines, 112 identifiers.
- [Held-out set](benchmarks/2026-10-22-model-hosts-heldout-labels.json): 12 other repositories (4 per host), 144 lines, 50 identifiers. It was labelled after the detector changes that the first set informed.

| Run                                | Refit commit |         Precision |    Recall | Bedrock P / R |   Azure P / R | OpenRouter P / R |
| ---------------------------------- | ------------ | ----------------: | --------: | ------------: | ------------: | ---------------: |
| First set, first detector          | `5e341b7`    |     96.8% (60/62) |     53.6% |  100% / 65.2% | 81.8% / 40.9% |     100% / 47.7% |
| First set, after fixes it informed | `fc0a8ed`    |   97.2% (106/109) |     94.6% |  97.9% / 100% | 90.0% / 81.8% |     100% / 95.5% |
| **Held-out set**                   | `fc0a8ed`    | **82.0% (41/50)** | **82.0%** |   100% / 100% | 53.8% / 53.8% |    88.0% / 88.0% |

Every figure above matches the committed results files (checked 2026-10-22). The after and held-out files record Refit commit `1706f25`, which differs from `fc0a8ed` only in `scripts/model-hosts-benchmark.mjs`, so the detector is the same.

The held-out row is the honest estimate; the middle row measures the labels the fixes came from. The held-out errors, left as found:

- **Azure false positives (6).** `?api-version=v1` on Azure AI Foundry project endpoints (storage, memory, toolbox), which are not Azure OpenAI model requests.
- **OpenRouter false positives (3).** openclaw's own `provider/model` references, in a file that also mentions OpenRouter.
- **Azure misses (6).** Deployment names in assertions (`toBe("image-deployment")`), in a `modelId:` key, at the end of a line with no comma, or in a non-Azure-named `target.model`.
- **OpenRouter misses (3).** Namespaces outside the list: `xiaomi`, `aion-labs`, `morph`.

Of the detections on labelled lines, most are tests and catalogs: in the first set after the fixes, 65 test, 22 catalog, 10 call, 6 doc and 3 example. That reflects the library-heavy sample, not customer applications.

**Whole sample at `1706f25`:**

- 7,025 host sites: 5,031 Bedrock, 305 Azure and 1,689 OpenRouter.
- 178 OpenRouter IDs in 13 repositories route to a model with a registry deadline. The most common are `openai/gpt-image-1` (31), `openai/gpt-4` (27) and `openai/o1-preview` (12).
- Seven repositories exceed `readRepository`'s scan limits, so `scanDeadlines` refuses them (the benchmark reads their files itself).

## Not covered

- **Python and other languages.** The detector reads JS/TS only.
- **Host SDKs' own model types.** For example, a Bedrock model chosen through a typed enum in another package.
- **Azure deployments set only in infrastructure files** (Bicep, Terraform).
- **OpenRouter's own retirements.** OpenRouter may keep serving or remap an ID after the upstream provider retires it. The report says the ID routes to a retired upstream model; it does not say OpenRouter will stop serving it.

## Reproduce

```sh
node scripts/model-hosts-select.mjs --count 15 --output docs/benchmarks/2026-10-22-model-hosts-repos.json
node scripts/model-hosts-label-candidates.mjs --list docs/benchmarks/2026-10-22-model-hosts-repos.json --root <clones> --seed 20261022
node scripts/model-hosts-benchmark.mjs --list docs/benchmarks/2026-10-22-model-hosts-repos.json \
  --labels docs/benchmarks/2026-10-22-model-hosts-labels.json --root <clones> --output <results.json>
```

Clone each repository at its frozen commit into `<clones>/<owner>_<name>`. Nothing in the clones is installed or run.
