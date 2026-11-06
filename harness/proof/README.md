# harness/proof

Checks that prove platform and rule changes. `runProof(check, input, ctx)` returns a `ProofResult`
(`shared/types.ts`); every check is also an `AgentTool` (`proofTools`, or `buildProofTools({ sandbox,
baselineDir })` to reuse the harness's sandbox) named `proof_<check>`. The checks gather evidence
and never block. They never throw. A check that cannot look (no Docker, no browser, nothing to read)
returns `passed: 'unknown'` and says why. Repo code runs only in the sandbox; the other checks only read
files. Every evidence line passes through `redactSecrets`.

Each result records the commands, what passed, what failed, notes and a log tail, as `command:`,
`passed:`, `failed:`, `note:`, `skipped:` and `log tail:` lines in `evidence`, for the audit trail.
`runProofDetail` returns the same parts as separate fields.

| Check                  | What it proves                                                                                                     | Runs                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `kubernetes`           | Manifests and Helm output use no API version removed in the target release, and still validate                     | pluto, kubeconform, helm in the sandbox when installed        |
| `serverless`           | Runtimes in serverless.yml, SAM/CloudFormation and Terraform are not deprecated; the tests pass on the runtime     | the agent's `testCommand` in the sandbox (or in `image`)      |
| `android-sdk`          | targetSdk and minSdk against Google Play's target API requirement                                                  | reads files                                                   |
| `ios-privacy-manifest` | PrivacyInfo.xcprivacy is valid and declares a reason for each required-reason API the native code uses             | reads files                                                   |
| `browser-extension`    | manifest.json is valid Manifest V3; no MV2-only `chrome.*` calls                                                   | reads files                                                   |
| `tls`                  | No config or client code forces TLS 1.0, 1.1 or SSL                                                                | reads files                                                   |
| `login`                | Authorization-code flows send PKCE where the provider requires it; no password logins to providers that ended them | reads files                                                   |
| `accessibility`        | axe-core scan of the pages before and after, counting only new violations                                          | headless Chromium in the sandbox, next to `startCommand`      |
| `payment-scripts`      | Every script on checkout pages, before and after; new ones flagged for authorization (PCI DSS v4.0 6.4.3)          | headless Chromium in the sandbox, else the page sources       |
| `container-image`      | Each Dockerfile is on the target base image and still builds                                                       | `docker build` on the host: RUN steps run in build containers |

**Before and after.** `accessibility` and `payment-scripts` compare against `ctx.baselineDir` (the
untouched checkout, which the harness should pass) or, without one, against the first call made for
the same pages, which the agent should make with `phase: "before"` before it edits.

**Browsers.** The scan script is written to the sandbox's `/tmp` and run with Node there, so page
code never runs on the host outside the sandbox. It needs Playwright and a Chromium in the sandbox
(`npm root -g` is searched); axe-core is installed into `/tmp/refit-proof-deps` with scripts off when
missing. The default Docker image (`node:22-bookworm`) has no browser, so in Docker mode the
browser checks report `skipped` unless the harness's image has one. `payment-scripts` then falls back
to reading the page sources and says so.

**Data tables** (removed Kubernetes APIs, Lambda runtime deprecations, Play's target API levels,
required-reason APIs, providers that require PKCE or ended password logins) carry their source URL
and the date they were recorded. They are tools for the agent, not gates: inputs such as
`targetVersion`, `deprecated`, `requiredTargetSdk` and `requirePkce` let the agent apply what it
confirmed at the source, and the evidence says when a table may be out of date.

**Grading.** The harness grades ToolPack output by its words (`harness/validators.ts`). The text
form (`formatProofResult`) starts with `<check>: passed`, `<check>: failed`, or an unknown line
that says it counts as failed, so an unknown result is never taken as proof.

Tests use the fixtures in `fixtures/` (illustrative, not real projects) and a scripted sandbox. The
real headless-browser test runs when Playwright is installed globally, and skips itself when axe-core
can't be installed. The real `docker build` test runs only with a Docker daemon. `harness.test.ts`
drives the proof tools through `runTask` with the scripted fake model, so it spends no money.
