# Cloud SDK end of support

Refit monitors two cloud SDK retirements: the AWS SDK for JavaScript v2 (`aws-sdk`) and Microsoft's legacy ("track 1") Azure SDK for JavaScript packages. Neither provider has a Refit agent (`adapter: null`): Refit reports where a repository depends on them and which services a migration touches, and proposes no edit. Nothing here installs, runs or contacts AWS or Azure.

## What the providers say

| Package                                                          | End of support | Replacement                                                          | Source (read 2026-10-22)                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aws-sdk` (v2)                                                   | 2025-09-08     | AWS SDK for JavaScript v3 (`@aws-sdk/client-*`)                      | [aws/aws-sdk-js README](https://github.com/aws/aws-sdk-js/blob/master/README.md): "reached end-of-support on September 8, 2025. It will no longer receive updates or releases." npm's notice on `aws-sdk` 2.1693.0 says the same.                                |
| 109 legacy Azure packages, including `azure-storage`             | 2023-03-31     | The `@azure/*` package Microsoft names for each                      | Microsoft's release data, [`_data/releases/latest/js-packages.csv`](https://github.com/Azure/azure-sdk/blob/671a60848e02af18b43dd08aad5f67ad9e0e81fb/_data/releases/latest/js-packages.csv), which renders azure.github.io/azure-sdk/releases/deprecated/js.html |
| `azure-sb`, `azure-asm-sb`, `azure-arm-sb`, `azure-arm-eventhub` | 2023-12-31     | `@azure/service-bus`, `@azure/arm-servicebus`, `@azure/arm-eventhub` | same                                                                                                                                                                                                                                                             |
| `azure-arm-machinelearning`                                      | 2024-02-02     | `@azure/arm-machinelearningcompute`                                  | same                                                                                                                                                                                                                                                             |

Neither provider says that requests through the old packages stop working; support, fixes and security patches end. Every date has passed, so `refit deadlines` lists each matching manifest as past due.

`aws.amazon.com`, `learn.microsoft.com`, `azure.github.io` and Google's documentation hosts did not resolve from the cloud environment on 2026-10-22, so the AWS blog announcement and Microsoft's rendered page were not read directly. The facts above come from the providers' own GitHub repositories, which those pages cite or are generated from.

### Which Azure packages count

`scripts/azure-sdk-retirements.mjs` keeps a CSV row when it says `deprecated` with an end-of-life date and the whole package was retired: an unscoped name (every track-1 package), or an `@azure/` name whose row names a different package as its replacement (for example `@azure/keyvault` → `@azure/keyvault-keys`, `@azure/cognitiveservices-*`). 89 deprecated rows retire only old versions or previews of a package Microsoft still maintains (`@azure/event-hubs` 2.x, `@azure/cosmos` 2.x, most `@azure/arm-*` previews) or a modern package without a named replacement; matching those by name would flag current users, so they are left out. Every kept name exists on npm. The output, `data/azure-sdk-retirements.json`, records each package's date, Microsoft's replacements and npm's own deprecation notice.

## Where it shows up

- **`refit deadlines`** and the hosted inventory: the registry entries (`aws-sdk-js-v2-2025-09-08`, `azure-sdk-legacy-2023-03-31`, `azure-sdk-legacy-2023-12-31`, `azure-sdk-legacy-2024-02-02`, all `kind: "sdk"`) match every `package.json` that declares one of the packages, as for `@google/generative-ai`. Manifests in test and example paths are listed but not counted.
- **`refit agents`** (`detectProviders`): catalog entries `aws` (`aws-sdk`; no hostname, since `amazonaws.com` also appears in asset URLs and CSP lists) and `azure` (the 113 legacy packages). Both have `adapter: null`, so they are detected but never suggested or added.
- **`refit cloud-sdk`** (`scanCloudSdkClients` in `pipeline/cloud-sdk-clients.ts`): the service clients a migration would touch.

```sh
refit cloud-sdk --repository /path/to/app
refit cloud-sdk --repository /path/to/app --json
```

It reports, with file and line:

- **v2 clients**, constructed from `aws-sdk` in any import style: `new AWS.S3()` with `AWS` from `require('aws-sdk')`, a default, namespace or `import =` import; named and destructured clients (`import { S3 } from 'aws-sdk'`, `const { SNS } = require('aws-sdk')`, `const { Kinesis } = AWS`, `const Firehose = AWS.Firehose`); per-client paths (`require('aws-sdk/clients/s3')`, `import { DocumentClient } from 'aws-sdk/clients/dynamodb'`); and classes nested under a service (`new AWS.DynamoDB.DocumentClient()`, `new AWS.S3.ManagedUpload()`), counted under that service. Each lists the v3 package that replaces it.
- **v3 clients**, constructed from an `@aws-sdk/client-*` package (`new S3Client()`, the aggregated `new S3()`, `new sqs.SQSClient()` through a namespace). Commands, exceptions and errors are not clients. v3 clients have no deadline; they are listed so a half-migrated repository shows both sides.
- **Legacy Azure packages**, where each is loaded (`require`, `import`, `import =`, `import()`), with Microsoft's replacements.

A `services` table counts live and test sites per SDK and service. Classes that belong to no service (`AWS.Config`, `AWS.Credentials`, `AWS.Endpoint`) and same-named local classes are not reported.

### The v2 to v3 client map

`data/aws-sdk-v2-clients.json` is generated by `scripts/aws-sdk-clients.mjs` from the downloaded, never-installed `aws-sdk` 2.1693.0 tarball: `apis/metadata.json` gives each client's name and `aws-sdk/clients/<id>` path, and the newest API model of each service gives its `serviceId`, which v3's generator turns into `@aws-sdk/client-<service-id>`. Each derived name was checked on the npm registry: 382 of 385 v2 clients have a published v3 package. `ImportExport`, `MobileAnalytics` and `SimpleDB` have none and are reported with a null replacement. The tarball is read as JSON only; no SDK code runs. Regenerate it rather than editing it.

## Benchmark

All numbers are from Refit at commit `921878d` in a clean detached worktree, scanning shallow checkouts at the pinned commits. Nothing in the sample was installed or run.

```sh
node scripts/cloud-sdk-benchmark.mjs --root <dir> --labels docs/benchmarks/2026-10-22-cloud-sdk-labels.json
```

### The sample

`docs/benchmarks/2026-10-22-cloud-sdk-repos.json`: 64 public repositories, selected on 2026-10-22 by `scripts/cloud-sdk-select.mjs` from npm search (GitHub code search is not available here), in three groups by what the published package's `dependencies` declare: 32 declare `aws-sdk` (v2), 20 declare only `@aws-sdk/client-*` (v3), and 12 declare a legacy Azure package. The vendors' own organizations and scopes are excluded. The exact queries, quotas and rejection counts are in the file.

10 repositories exceed Refit's scan limits (10,000 files, 50 MiB, or 128 source-configuration files) and were not scanned: `payloadcms/payload`, `backstage/backstage`, `DataDog/serverless-plugin-datadog`, `remotion-dev/remotion`, `DefinitelyTyped/DefinitelyTyped`, `oblador/loki`, `serverless-stack/sst`, `serverless-nextjs/serverless-next.js`, `pagopa/io-functions-commons`, `Microsoft/azure-pipelines-tasks`.

### Who still uses v2, and for what

Of the 54 scanned repositories (`docs/benchmarks/2026-10-22-cloud-sdk-results.json`):

| Group                           | Scanned | Construct v2 clients in live code | Construct v3 clients | Load a legacy Azure package |
| ------------------------------- | ------: | --------------------------------: | -------------------: | --------------------------: |
| Declares `aws-sdk`              |      29 |                                21 |                    1 |                           0 |
| Declares only v3                |      15 |                                 0 |                   13 |                           0 |
| Declares a legacy Azure package |      10 |                                 1 |                    1 |                          10 |
| **All**                         |  **54** |                            **22** |               **15** |                      **10** |

22 repositories still construct v2 clients: 91 live sites. By repositories using each service: S3 11, Lambda 5, CloudFront 4, DynamoDB 3, IAM 3, APIGateway 2, CloudFormation 2, CognitoIdentityServiceProvider 2, KMS 2, SQS 2, SSO 2, STS 2, and ACM, CloudWatchEvents, CostExplorer, ECR, EventBridge, Iot, Kinesis, SNS and StepFunctions 1 each. No scanned repository constructs both v2 and v3 clients in live code. Legacy Azure loads: `azure-storage` in 9 repositories, `azure-sb`, `azure-keyvault` and `azure-arm-containerinstance` in 1 each.

Recounted from these results with the widened test paths (2026-10-22, [Benchmarks](BENCHMARKS.md#test-paths-widened-october-22)): `jagregory/cognito-local` constructs one v2 client in `integration-tests/aws-sdk/setup.ts`, a Vitest harness, which is now `test`. That makes 90 live sites and CognitoIdentityServiceProvider 1 repository. The 22 repositories are unchanged, because cognito-local still constructs KMS and Lambda clients in `src/`. Precision and recall below are unchanged, since cognito-local is not labelled.

8 of the 29 scanned repositories that declare `aws-sdk` construct no v2 client in live code: `dwyl/aws-sdk-mock` and `localstack/serverless-localstack` construct them only in tests (localstack's plugin code patches `AWS.S3.prototype` and builds credentials), Serverless Framework plugins call AWS through the framework's `provider.request` (`aghadiry/serverless-cloudfront-invalidate`, `medikoo/serverless-plugin-vpc-eni-cleanup`), `serverless-appsync/serverless-appsync-simulator` uses only v2's HTTP utilities (`AWS.HttpClient`, `AWS.Endpoint`, `AWS.HttpRequest`), `jeremydaly/dynamodb-streams-processor` uses only v2's DynamoDB converter, `NimperX/react-aws-s3-typescript` constructs the v3 `S3` client despite also declaring v2, and `motdotla/node-lambda` builds its clients from an SDK object passed in from another module (see the gap below). The registry still flags each of them, from the manifest.

### Precision and recall

25 repositories were labelled blind (`docs/benchmarks/2026-10-22-cloud-sdk-labels.json`): a seeded sample of 12 v2, 7 v3 and 6 Azure repositories, with `DefinitelyTyped/DefinitelyTyped` replaced by the next seeded v3 pick because its file count, counted before any scan, is over Refit's limit. Candidates came from `scripts/cloud-sdk-label-candidates.mjs`, an independent text search that imports no pipeline code: every `new …` in a live file that names `aws-sdk` (built-ins and v3 `…Command` objects aside), every `new AWS.…` anywhere, and every quoted legacy Azure package. Four fresh-context labelling agents read the 370 candidates against written rules, never seeing Refit output, and the labels were committed before Refit scanned any labelled repository. It is one AI-assisted pass; 12 labels were spot-checked against the code, and none was second-labelled.

113 candidates are client or load sites. Two labelled repositories exceeded the scan limits (`payloadcms/payload`, `DataDog/serverless-plugin-datadog`; 7 labelled v3 sites). Failed scans stay in the denominator, so those 7 sites count as misses and 113 sites in 25 repositories are scored. The committed results file's `score` excludes them (106):

| SDK          | Labelled sites | Reported | True positives | Precision |    Recall |
| ------------ | -------------: | -------: | -------------: | --------: | --------: |
| AWS SDK v2   |             19 |       19 |             19 |      100% |      100% |
| AWS SDK v3   |             83 |       76 |             76 |      100% |     91.6% |
| Legacy Azure |             11 |       11 |             11 |      100% |      100% |
| **All**      |        **113** |  **106** |        **106** |  **100%** | **93.8%** |

Every reported service matched its label. Among scanned repositories, every service row is at 100% precision and recall: v2 DynamoDB 5 sites, S3 4, IAM 3, and ACM, CloudFormation, CloudFront, CostExplorer, Lambda, SSO and STS 1 each; v3 21 client packages from 1 site (several) to 16 (`@aws-sdk/client-cloudformation`); Azure `azure-storage` 8 and three other packages 1 each; per-service rows are in the `score.byService` field of the results file. The scorer compares the service only; the v3 replacement packages are not scored. These are small counts: a 100% on 19 v2 sites says the forms in this sample are covered, not that every form is.

Recall is measured inside the candidate net. A client built in a file that names neither `aws-sdk` nor `AWS.` is outside both the net and the detector. The sample has one such repository outside the labelled set: `motdotla/node-lambda` exports the SDK from `lib/aws.js` (`sdk: aws`) and passes it to constructors that call `new aws.Lambda()` and `new aws.S3()` on the parameter. Following an SDK object across modules and through parameters is not implemented; the manifest entry still reports the repository.

## Google Cloud (not added)

Blocked: Google's Node.js library pages (`cloud.google.com/nodejs/docs/reference`, which redirects to `docs.cloud.google.com`) did not resolve from the cloud environment on 2026-10-22, retried once through a second fetcher. `googleapis/google-cloud-node`'s `libraries.json` lists 245 libraries as `stable` or `preview` with no deprecation field, and none of its package READMEs carries a deprecation notice. Two separate Google repositories are marked deprecated or archived: `googleapis/cloud-trace-nodejs` (`@google-cloud/trace-agent`, also deprecated on npm, pointing to OpenTelemetry) and `googleapis/cloud-debug-nodejs` (`@google-cloud/debug-agent`, "archived and no longer supported"). Neither page gives a date, and the registry needs one, so no Google Cloud entry was added. Someone who can read Google's deprecation pages should add dated entries the same way.

## Not covered

- Python, Go and other ecosystems' AWS and Azure SDKs (boto2, `azure-storage` for Python): JavaScript and TypeScript only.
- Requests a v2 client makes are not listed one by one; the unit is the client, which is what a v3 migration replaces.
- Azure track-1 packages Microsoft retired only in part (old majors of a package still maintained) are not matched, by design.
