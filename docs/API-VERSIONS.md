# Verify the application's API version

Refit keeps SDK package versions, API versions and OpenAPI's format version separate. `stripe@10.17.0` does not mean API version `2022-08-01`. An operator supplies `apiVersion`; Refit compares it exactly with the before contract's `info.version` before automatic migration. If a provider's `info.version` is not its API-version identifier, this comparison needs a reviewed contract projection.

Refit also checks supported SDK constructor declarations and request overrides when the adapter describes their option locations. A literal declaration conflicting with the operator pin stops automatic work under either policy, before AI, dependency preparation, Docker checks or draft publication. A scan still records affected usages and the conflict. Proposals may not introduce a conflicting declaration or weaken an existing verified declaration.

## Choose a policy

Add these fields alongside the existing contracts and checks in `.refit.json`:

```json
{
  "apiVersion": "2022-08-01",
  "apiVersionPolicy": "source-verified"
}
```

This fragment is not a complete workflow.

- `operator-pin` is the compatibility default. A literal conflict blocks the run. Missing, dynamic or unsupported declarations remain visibly unverified; the explicitly approved operator pin is still used for applicability.
- `source-verified` additionally blocks automation unless all supported declarations resolve and match the pin. An adapter without a version mapping cannot pass. Runtime configuration requires review rather than inference.

For a manual check without changing the approved profile:

```sh
refit scan --repository /path/to/application \
  --before /path/to/before.json --after /path/to/after.json \
  --api-version 2022-08-01 --api-version-policy source-verified
```

The same flag works with `run`, `validate` and `watch`. `doctor`, `enroll` and the App service use the workflow's policy. Changing a checked-in policy requires a new configuration approval. Changing only application code preserves the configuration fingerprint, but declarations are rechecked when the App loads the approved repository. Worker identity includes the adapter and policy; use fresh state when these change, preserving earlier evidence.

## Describe another SDK

A provider adapter can add:

```json
{
  "apiVersion": {
    "constructorArgument": 0,
    "property": "headers.version",
    "requestArguments": [1]
  }
}
```

This example describes `new Client({ headers: { version: '1' } })` and `client.resource.method(parameters, { headers: { version: '1' } })`. Indexes are zero-based, unique and bounded from 0 to 16. The property is a dot-separated identifier path. Use `requestArguments: []` only when that SDK has no version overrides in its supported calls. The mapping applies to every observed SDK resource method on a traced client, including nested resources and methods without an operation mapping. Verify the metadata against the actual SDK; it is an operator-authored assumption.

The built-in Stripe mapping checks both `new Stripe(...)` and its documented callable initialization through supported ESM/CommonJS client modules. It checks constructor argument 1, property `apiVersion`, and request arguments 1 and 2 for optional overloads. Both configuration mechanisms appear in [Stripe's official migration guide](https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v12). Refit does not infer the account default used by older SDKs or the default embedded in newer SDKs.

Where the value comes from, for Stripe (founder decision, 2026-10-28):

- A literal, a `const` alias, or a property of an exported `const` config object in another module is a pin. The patch moves it where it is written.
- `process.env.NAME ?? '<version>'` (or `||`) is a pin with a repository default. The patch moves the default, and the draft names `NAME`: a value set where the code is deployed still overrides it. Version-dependent request edits, such as the card rename, do not ride on such a pin.
- `process.env.NAME` with no default is not a hold. The draft names `NAME` and asks you to set it to the target where you deploy.
- `apiVersion: null` sets no version. stripe-node sends `apiVersion || DEFAULT_API_VERSION`, from 11.18.0 through 23.0.0, so the client is treated like one that omits the option.
- `export default` config objects and JSON settings files are not read yet, and stay untraced.

## Read the evidence

`scan.json` and `report.json` include `apiVersion.policy` and `apiVersion.source`:

- `verified`: supported constructor declarations resolve to the configured literal version; supported requests inherit it or use a matching override.
- `conflict`: a resolved declaration disagrees with the pin; its file and line are recorded.
- `unknown`: a declaration is absent, dynamic, mutated, exposed or otherwise unsupported.
- `not-configured`: the adapter has no version-option mapping.

Declarations contain locations, constructor/request kind, version value and an explanation. They do not export other constructor options, keys, request arguments or source text. PR summaries and readiness diagnostics explain the source status in plain language.

Supported expressions include string literals, constant strings, immutable options objects and aliases, direct relative named imports, nested option properties, shorthand properties and TypeScript assertions. Configuration-loading calls, environment lookups, object spreads, computed option keys, getters, duplicates, mutable bindings, client/constructor mutations, unknown reference exposure, optional invocations and spread arguments remain unverified. The analysis does not execute code, load application environment files, query a provider account or establish the version of untraced requests, webhooks, wrappers or other languages. `verified` describes supported declarations under the recorded mapping; it is not proof of every runtime request's effective version.

## Stripe billing demo

The independent billing demo obtains its version through `readConfiguration()` and switches historical simulator contracts at runtime. Refit records this as `unknown`; its existing approved pilot uses `operator-pin`. Adding strict policy stops it for review before execution. Its before/after HTTP contract tests remain the behavioral evidence. Do not rewrite the independent demo merely to satisfy static analysis.

The conformance suite separately uses real Stripe SDKs 10.17.0 and 19.1.0, asserts their `Stripe-Version` headers over loopback HTTP, and verifies a conflicting request override. A generic SDK migration passes real `oasdiff` and offline Docker under strict policy. Controlled AI proposals that change or weaken verified declarations are rejected before patched execution. These evaluations do not contact Stripe servers or spend on a live model.
