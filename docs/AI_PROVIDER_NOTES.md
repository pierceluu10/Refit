# AI provider pipeline notes

## Existing Stripe flow

| Step | Entry point | Core implementation |
| --- | --- | --- |
| Snapshot | `pipeline/snapshot-cli.ts`; `stripe:snapshot`; `refit stripe-snapshot` | `pipeline/snapshots.ts` |
| Replay and scan | `pipeline/cli.ts`; `stripe:replay`; `refit replay` | `pipeline/run.ts`, `pipeline/analyzer.ts` |
| Deterministic patch | `--propose-patch` | `pipeline/patches.ts`, `pipeline/history-migration.ts` |
| Validation | `pipeline/validation-cli.ts`; `refit validate` | `pipeline/validation.ts` |
| Publication | `refit run --publish-draft` | `pipeline/publication.ts`, `pipeline/workflow.ts` |
| Demo | `pipeline/demo-cli.ts`; `refit demo` | `pipeline/fixtures/stripe-sdk/`, `pipeline/demo.test.ts` |

Provider adapters are defined and validated in `pipeline/providers.ts`. SDK calls and
response findings are traced in `pipeline/analyzer.ts`. Findings and source edits are
typed in `pipeline/types.ts`. Review artifacts are written by `pipeline/review.ts`.

Stripe real-SDK tests are gated by `REFIT_STRIPE_SDK=1`; Docker tests additionally use
`REFIT_DOCKER_IMAGE`. Provider SDK contract tests use provider-specific opt-ins.

## AI provider implementation

- `pipeline/deprecation-snapshots.ts` owns the strict deprecation snapshot contract,
  canonical model-array hash, loader, and verifier.
- `pipeline/ai-snapshot-cli.ts` implements snapshot construction and verification.
- `pipeline/providers.ts` supports dotted resources and model-ID request checks while
  retaining response-schema operations used by the OpenAPI pipeline.
- `pipeline/deprecated-models.ts` traces configured request checks, emits conservative
  `deprecated-model` findings, proposes literal-only replacements, and rescans the result.
- `pipeline/fixtures/provider-api/server.mjs` is the shared loopback provider simulator.
- `pipeline/ai-replay.ts` and `pipeline/ai-replay-cli.ts` run the bundled OpenAI replay.
- `pipeline/openai-demo.ts` validates the OpenAI migration in offline, restricted
  containers and writes a local review bundle.
- `pipeline/fixtures/anthropic/` and `pipeline/fixtures/anthropic-messages/` exercise the
  same contracts without adding provider-specific detection mechanisms.
- `eval/` measures detector findings in temporary shallow clones and keeps third-party
  source outside this checkout.

## Contract fit

The deprecation snapshot, finding, fake API, and command contracts fit as separate
inputs beside the existing OpenAPI before/after pipeline. Keeping the deprecation
orchestrator separate avoids making OpenAPI inputs optional and preserves existing
Stripe report behavior.

Adapter operations require one or both of `schema` and `requestChecks`: `schema` drives
response-field analysis, while `requestChecks` drives request argument analysis. Dotted
resources are represented as dot-separated identifier paths.

Deprecation findings use the contract value `needs-review`; existing OpenAPI findings
retain their established `review` value. The two report types are not conflated.

Committed deprecation fixtures are explicitly synthetic. Real vendor retirement dates,
replacements, and source notes must only be added from a pinned vendor source.

## File ownership and overlap

The original work split has unavoidable registration overlap in `package.json` and
`bin/refit.mjs` for snapshot and replay commands. Adapter and detector work meet at the
`ProviderAdapter` contract but otherwise remain separate. Replay and demo consume the
fake API, snapshots, and detector without changing their semantics. Anthropic adds only
adapter and fixture coverage; evaluation adds only the `eval/` tooling.
