# Product Requirements Document

## Product name

**Refit**

Use Refit consistently across the product, GitHub App, documentation, page titles, metadata, onboarding, and generated pull requests. Use lowercase `refit` for technical identifiers, `refit.yml` for repository configuration, and `refit/<provider>/<short-change-id>` for generated migration branches. Naming and UI/UX direction are part of this specification.

## Status

MVP specification.

## Product one-liner

Connect a GitHub repository and let Refit monitor the external APIs it uses. When an API changes in a way that affects the repository, Refit identifies the affected code, generates a migration, validates it in an isolated environment, and opens a draft pull request.

## Core product thesis

API providers currently communicate changes through documentation, changelogs, release notes, SDK releases, and API specifications.

Developers must then:

1. notice the change,
2. determine whether it affects them,
3. find the affected code,
4. understand the migration,
5. modify the application,
6. test the change,
7. ship it.

Modern coding models can perform much of steps 2–6. Refit connects provider-side change information to customer repositories and turns API change communication into reviewed code changes.

The MVP should demonstrate this complete loop:

```text
external API changes
        ↓
change detected deterministically
        ↓
normalized provider change
        ↓
customer repository analyzed
        ↓
affected usage identified
        ↓
coding agent generates migration
        ↓
migration validated in sandbox
        ↓
draft GitHub PR opened
```

The pull request is the primary product output.

---

# 1. Builder directive

Treat this PRD as the authoritative implementation specification.

The implementation should optimize for:

- correctness,
- clear architecture,
- observability,
- failure recovery,
- deterministic validation,
- understandable backend engineering,
- an end-to-end demonstration that actually works.

Do not optimize prematurely for hyperscale.

Do not create unnecessary microservices.

Do not turn the product into a generic chat interface.

Do not let the language model decide facts that deterministic tooling can establish.

Do not auto-merge generated changes in the MVP.

Do not hardcode the core pipeline around Stripe even though Stripe is the only MVP provider.

Do not hardcode the repository analyzer so deeply around TypeScript that another language would require rewriting provider/change logic.

The target is a portfolio-quality backend system that can be fully understood and defended technically.

---

# 2. Product inspirations

The product combines patterns from several existing systems without copying their implementations.

### YC Self-Maintaining APIs RFS

Primary product thesis:

```text
API provider change
       ↓
customer codebase
       ↓
automatic migration PR
```

This defines the core problem and desired outcome.

### Dependabot

Borrow:

- continuous monitoring,
- low-friction repository installation,
- PR as the primary artifact,
- human review before merge,
- one change represented as one understandable update.

Do not reduce Refit to dependency version bumping. Refit must operate on application code.

### Context7

Borrow:

- provider documentation should be current,
- provider context should be version-aware,
- model reasoning should be grounded in authoritative external information rather than model memory.

Refit goes one step further:

```text
Context7-like concept:
current docs → coding agent

Refit:
change between versions
        +
current docs
        +
repository context
        ↓
migration PR
```

### Greptile

Borrow:

- repository understanding should extend beyond text search,
- source relationships and symbols should be indexed,
- relevant code should be identified before expensive agent reasoning.

MVP does not need a production-scale whole-repository knowledge graph.

### Screenpipe and Nango — UI and UX references only

Use these references for substantial visual and interaction inspiration:

- [Screenpipe website](https://screenpipe.com/)
- [Screenpipe repository](https://github.com/screenpipe/screenpipe)
- [Nango repository](https://github.com/nangohq/nango)

Screenpipe informs the technical visual character, prominent product demonstrations, and clear narrative from trigger to outcome. Nango informs the application shell, information hierarchy, searchable resource lists, and progressive disclosure of configuration and detail.

These references do not dictate Refit's backend architecture, product features, runtime, provider system, or business model. The backend requirements in this PRD stand on their own. Do not copy their source code, branding, marketing copy, customer claims, or proprietary assets. Translate the observed UI/UX patterns into an original Refit interface; section 80 specifies the result.

### oasdiff

Use directly where appropriate.

OpenAPI contract differences should be determined by deterministic OpenAPI tooling before an LLM interprets their significance.

### Coding-agent/sandbox products

Borrow:

```text
agent proposes
deterministic environment verifies
```

A plausible-looking diff is not success.

Compilation, linting, typechecking, tests, and command exit codes are the source of truth.

---

# 3. MVP scope

The complete MVP supports:

| Dimension | MVP |
|---|---|
| API provider | Stripe |
| Change source | Stripe OpenAPI repository |
| Source control | GitHub |
| Repository language | TypeScript / JavaScript |
| Provider SDK | Stripe Node SDK |
| Change detection | OpenAPI snapshots + oasdiff |
| Reasoning/code generation | OpenAI model |
| Repository understanding | manifests + AST + symbol/reference analysis |
| Execution | isolated Docker sandbox |
| Validation | configurable repository commands |
| Output | GitHub draft pull request |
| Workflow persistence | PostgreSQL |
| UI | polished landing page, documentation, replay demo, onboarding, and focused application UI; see section 80 |

The system must nevertheless expose a provider abstraction so a second provider can be added without changing the orchestration pipeline.

---

# 4. Explicitly out of scope for MVP

Do not implement these until the primary Stripe flow works end-to-end:

- automatic merging,
- GitLab/Bitbucket,
- Python/Go/Java support,
- hundreds of API providers,
- arbitrary website crawling,
- full enterprise RBAC,
- SOC 2 functionality,
- Kubernetes,
- multi-region deployment,
- provider billing,
- provider-facing customer distribution,
- automatic migrations for every new feature,
- complicated vector databases,
- a generalized multi-agent framework,
- an elaborate dashboard,
- autonomous production deployment,
- access to customer production secrets.

New API features may be detected and recorded, but the initial automatic migration path should prioritize breaking or migration-relevant changes.

---

# 5. Product principles

## 5.1 Deterministic before probabilistic

Bad:

```text
"LLM, compare these enormous OpenAPI files and tell me what changed."
```

Good:

```text
OpenAPI A
   +
OpenAPI B
   ↓
oasdiff
   ↓
structured factual diff
   ↓
LLM interprets the migration consequence
```

Likewise:

```text
LLM says TypeScript should compile
```

is irrelevant.

Run:

```bash
npm run typecheck
```

and use the exit code.

## 5.2 Evidence accompanies every decision

An impact result must not simply say:

```json
{ "affected": true }
```

It should identify:

```json
{
  "affected": true,
  "confidence": 0.94,
  "evidence": [
    {
      "path": "src/billing/stripe.ts",
      "lineStart": 48,
      "lineEnd": 57,
      "symbol": "stripe.paymentIntents.create"
    }
  ]
}
```

## 5.3 Human review remains the trust boundary

MVP output is always a **draft PR**.

Never auto-merge.

## 5.4 The agent gets narrow tools, not unrestricted infrastructure access

The model interacts with a sandbox through controlled tools.

It does not receive:

- GitHub organization credentials,
- database credentials,
- production secrets,
- Docker socket,
- host filesystem access.

## 5.5 Core infrastructure is provider-neutral

The orchestration layer should understand concepts such as:

```text
Provider
ProviderSource
ProviderSnapshot
RawChange
ChangeEvent
Repository
ProviderDependency
ImpactAnalysis
MigrationRun
ValidationRun
PullRequest
```

It should not understand:

```text
PaymentIntent
Stripe Customer
Stripe Checkout
```

Those belong to the Stripe provider implementation or normalized event payload.

---

# 6. Primary user

A developer or engineering team using third-party APIs in a GitHub repository.

For the MVP demo, assume:

- one GitHub user,
- one repository,
- one TypeScript service,
- Stripe Node SDK,
- standard package scripts,
- no complicated monorepo permissions.

Architecture should still support multiple repositories and installations in the database.

---

# 7. Primary user journey

## Installation

User installs the Refit GitHub App.

User grants access to one or more repositories.

Refit receives an installation event and stores:

```text
GitHub installation
repositories
default branches
repository metadata
```

Refit clones or inspects the repository.

It detects dependencies such as:

```json
{
  "provider": "stripe",
  "package": "stripe",
  "packageVersion": "x.y.z",
  "language": "typescript"
}
```

It builds an initial provider-usage index.

---

## Provider update

The Stripe provider poller observes a new revision of Stripe's OpenAPI source.

Refit stores an immutable provider snapshot.

The previous and new snapshots are compared.

oasdiff produces machine-readable differences.

The differences become one or more normalized `ChangeEvent`s.

---

## Candidate selection

Instead of running an LLM against every repository:

```text
ChangeEvent
    ↓
which repositories use Stripe?
    ↓
which use relevant SDK/language?
    ↓
which contain potentially affected usages?
```

Only candidate repositories continue.

---

## Impact analysis

The repository analyzer locates relevant API usage.

The OpenAI model receives:

- normalized `ChangeEvent`,
- factual source evidence,
- provider migration context,
- detected API usages,
- surrounding source,
- relevant type information,
- relevant callers where available.

It returns a structured decision:

```text
UNAFFECTED
AFFECTED
UNCERTAIN
```

Only sufficiently supported `AFFECTED` results proceed automatically.

`UNCERTAIN` is displayed/logged but does not create a migration PR by default.

---

## Migration

An isolated sandbox is created.

The repository is checked out at the exact analyzed commit SHA.

The coding agent receives controlled tools for:

- listing files,
- searching code,
- reading files,
- finding symbols,
- applying patches,
- running validation commands.

The model modifies the repository.

Validation commands run.

Failures may be passed back to the model for another attempt.

---

## Completion

If validation succeeds:

```text
create branch
      ↓
commit changes
      ↓
push branch
      ↓
open draft PR
```

PR contains:

- provider,
- API change,
- source revision,
- why the repository is affected,
- affected files,
- migration summary,
- validation commands,
- validation results,
- link/reference to originating provider evidence.

---

# 8. High-level architecture

Use a TypeScript monorepo.

Do not deploy every package as an independent service.

MVP requires only three application processes:

```text
Web/API process
Worker process
Frontend process — later
```

Infrastructure:

```text
                    GitHub
                      │
                      │ webhooks / API
                      ▼
               ┌──────────────┐
               │ Control API  │
               └──────┬───────┘
                      │
                      ▼
                 PostgreSQL
                      │
             durable job queue
                      │
                      ▼
               ┌──────────────┐
               │    Worker    │
               └──────┬───────┘
                      │
      ┌───────────────┼────────────────┐
      ▼               ▼                ▼
 Provider system   Repo analyzer    Sandbox
      │               │                │
      ▼               ▼                ▼
   oasdiff       AST / symbols      OpenAI agent
      │                                │
      └───────────── Change ───────────┘
                                       │
                                       ▼
                                  Validation
                                       │
                                       ▼
                                    GitHub PR
```

---

# 9. Suggested repository structure

```text
/
├── apps/
│   ├── api/
│   ├── worker/
│   └── web/                 # Refit landing page, docs, demo, and application UI
│
├── packages/
│   ├── contracts/
│   ├── database/
│   ├── scheduler/
│   ├── github/
│   ├── storage/
│   ├── providers/
│   │   ├── core/
│   │   └── stripe/
│   ├── repo-analysis/
│   │   ├── core/
│   │   └── typescript/
│   ├── agent/
│   ├── sandbox/
│   ├── validation/
│   ├── observability/
│   └── config/
│
├── fixtures/
│   ├── repositories/
│   └── provider-snapshots/
│
├── docker/
├── docs/
└── docker-compose.yml
```

Exact names may change, but responsibility separation should remain.

---

# 10. Technology choices

## Runtime

TypeScript on modern Node.js.

## Package management

pnpm workspaces.

Do not introduce multiple application languages unless a dependency absolutely requires it.

oasdiff may remain an external Go binary/container; do not rewrite it.

## Database

PostgreSQL.

Use PostgreSQL as:

- system of record,
- workflow state store,
- durable job queue for MVP.

Use a typed query layer such as Drizzle, Kysely, or equivalent.

Raw SQL is acceptable where PostgreSQL primitives are important.

## Object storage

Define a tiny storage interface:

```typescript
interface BlobStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
```

Implement:

```text
LocalBlobStorage    development
S3BlobStorage       deployable environment
```

Store large artifacts here:

- provider snapshots,
- raw oasdiff results,
- migration logs when appropriate.

Do not put multi-megabyte OpenAPI documents directly in ordinary relational rows unless necessary.

## AI

Use the OpenAI Responses API.

The model identifier must be configuration, not application logic:

```env
OPENAI_MODEL=...
```

Current development default may use a high-capability OpenAI coding/reasoning model.

Changing models must not require code changes.

## Execution

Docker containers for MVP sandboxing.

## API schema validation

Zod or equivalent.

Every external boundary should validate input.

---

# 11. Provider architecture

This is the most important anti-hardcoding requirement.

The core pipeline should interact with providers through an adapter.

A possible interface:

```typescript
interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;

  sources(): ProviderSourceDefinition[];

  fetchSnapshot(
    source: ProviderSourceDefinition
  ): Promise<ProviderSnapshotInput>;

  diffSnapshots(
    previous: StoredProviderSnapshot,
    current: StoredProviderSnapshot
  ): Promise<RawProviderChange[]>;

  repoMatchers(): ProviderRepoMatchers;

  enrichChange(
    change: RawProviderChange
  ): Promise<ProviderChangeContext>;
}
```

The exact interface may evolve while implementing.

Maintain the conceptual boundary.

Core orchestration calls:

```text
provider.fetchSnapshot()
provider.diffSnapshots()
provider.repoMatchers()
provider.enrichChange()
```

It never calls:

```text
stripe.getPaymentIntentChanges()
```

---

# 12. Provider sources

A provider may eventually derive change information from multiple source kinds:

```typescript
type ProviderSourceKind =
  | "openapi_git"
  | "openapi_http"
  | "sdk_release"
  | "changelog"
  | "documentation";
```

MVP only needs:

```text
openapi_git
```

The model still supports multiple source records.

Schema:

```text
provider_sources
----------------
id
provider_id
kind
config_json
enabled
last_polled_at
created_at
updated_at
```

Configuration for Stripe might conceptually contain:

```json
{
  "repository": "stripe/openapi",
  "branch": "master",
  "specPath": "latest/openapi.spec3.json"
}
```

Provider-specific configuration belongs in the Stripe package, not generic orchestration code.

---

# 13. Stripe MVP adapter

Stripe adapter responsibilities:

### Detect repository usage

Recognize signals such as:

```text
package.json contains "stripe"
import Stripe from "stripe"
require("stripe")
new Stripe(...)
```

### Fetch provider revisions

Track the Stripe OpenAPI repository revision.

Store:

```text
provider
source
git commit SHA
content hash
retrieval timestamp
blob storage key
```

### Compare revisions

Run oasdiff against previous and current specification snapshots.

Generate both:

```text
breaking changes
consumer-visible changelog changes
```

Machine-readable output is mandatory.

### Enrich changes

Attach:

- provider name,
- source revision,
- OpenAPI endpoint/method,
- changed request/response field,
- change classification,
- source evidence,
- relevant documentation when available.

Stripe-specific normalization happens here or through provider-specific context supplied to the generic normalizer.

---

# 14. Provider snapshots

Snapshots must be immutable.

Schema:

```text
provider_snapshots
------------------
id
provider_id
source_id
revision
content_hash
blob_key
metadata_json
created_at
```

Uniqueness:

```text
(provider_id, source_id, revision)
```

and preferably deduplicate identical content hashes.

A snapshot is historical evidence.

Never overwrite it when a provider changes again.

---

# 15. ChangeEvent

`ChangeEvent` is the core domain object.

It separates:

```text
"What changed in the API?"
```

from:

```text
"Does this repository care?"
```

Schema concept:

```typescript
type ChangeEvent = {
  id: string;

  providerId: string;

  fromSnapshotId: string;
  toSnapshotId: string;

  fingerprint: string;

  category:
    | "breaking"
    | "behavioral"
    | "feature"
    | "deprecation"
    | "documentation";

  severity:
    | "info"
    | "warning"
    | "breaking";

  affectedOperations: Array<{
    method?: string;
    path?: string;
    operationId?: string;
  }>;

  affectedSchema?: {
    resource?: string;
    field?: string;
    changeType?: string;
  };

  summary: string;

  migrationGuidance?: string;

  evidence: ChangeEvidence[];

  providerContext: Record<string, unknown>;

  createdAt: string;
};
```

Do not require every provider to populate every field.

---

# 16. Change normalization

oasdiff output is factual input.

The OpenAI model may convert complicated machine output into normalized `ChangeEvent`s, but it must not invent provider facts.

Structured output should be schema validated.

Each normalized statement should be traceable to evidence.

If model output is invalid:

```text
retry limited number of times
        ↓
still invalid
        ↓
mark normalization failed
        ↓
do not continue
```

No silent fallback to unstructured text.

---

# 17. Change fingerprints

Duplicate provider polling must not create duplicate migrations.

Generate a stable fingerprint using normalized components such as:

```text
provider
source
old revision
new revision
affected operation
change type
field/path
```

or oasdiff's stable identifiers where appropriate.

Enforce uniqueness at the database level.

---

# 18. Repository ingestion

When GitHub App access is granted:

1. store installation,
2. enumerate authorized repositories,
3. fetch repository metadata,
4. capture default branch,
5. resolve current head SHA,
6. scan manifests,
7. determine language,
8. detect supported providers,
9. index relevant source files.

Do not immediately send the whole repository to an LLM.

---

# 19. GitHub integration

Use a GitHub App.

Do not use a personal access token.

Request only permissions required by the implementation.

Likely MVP repository permissions:

```text
Metadata: read
Contents: read/write
Pull requests: read/write
```

Potentially add narrowly scoped permissions only if implementation requires them.

Use short-lived GitHub App installation tokens.

Do not persist installation tokens.

Persist:

```text
installation ID
account metadata
repository IDs
permission metadata
```

Generate installation tokens on demand.

---

# 20. GitHub webhook handling

At minimum handle relevant lifecycle events such as:

```text
installation
installation_repositories
push
```

Validate GitHub webhook signatures.

Store GitHub delivery ID.

Webhook ingestion must be idempotent.

Schema:

```text
webhook_deliveries
------------------
provider
delivery_id
event_type
payload_hash
processed_at
status
created_at
```

Uniqueness:

```text
(provider, delivery_id)
```

Duplicate delivery should be safe.

---

# 21. Repository dependency inventory

Create a provider inventory per repository.

Example:

```json
{
  "provider": "stripe",
  "language": "typescript",
  "package": "stripe",
  "packageVersion": "18.0.0",
  "manifest": "package.json",
  "confidence": 1
}
```

Schema:

```text
repository_dependencies
-----------------------
id
repository_id
provider_id
ecosystem
package_name
package_version
manifest_path
metadata_json
detected_at
```

This enables cheap candidate filtering.

---

# 22. Repository analysis architecture

Define a language analyzer abstraction.

Conceptually:

```typescript
interface LanguageAnalyzer {
  readonly language: string;

  detect(root: string): Promise<boolean>;

  indexRepository(
    root: string
  ): Promise<RepositoryIndex>;

  findProviderUsages(
    index: RepositoryIndex,
    matchers: ProviderRepoMatchers
  ): Promise<ProviderUsage[]>;

  expandContext(
    usage: ProviderUsage
  ): Promise<CodeContext>;
}
```

MVP implementation:

```text
TypeScriptAnalyzer
```

Future:

```text
PythonAnalyzer
GoAnalyzer
JavaAnalyzer
```

---

# 23. TypeScript repository analysis

Use deterministic analysis in layers.

## Layer 1 — manifests

Inspect:

```text
package.json
pnpm-lock.yaml
package-lock.json
yarn.lock
```

Detect Stripe dependency and version.

## Layer 2 — imports

Find:

```typescript
import Stripe from "stripe";
```

and reasonable variations.

## Layer 3 — AST

Use TypeScript compiler APIs, ts-morph, tree-sitter, or an appropriate combination.

Identify:

- Stripe client construction,
- method calls,
- arguments,
- containing function,
- source location,
- imported aliases.

Example:

```typescript
const stripe = new Stripe(key);

await stripe.paymentIntents.create({
  amount,
  currency
});
```

should become structured usage information.

## Layer 4 — references

Where practical, identify local callers.

Example:

```text
stripe.paymentIntents.create
        ↓
createPayment()
        ↓
checkout()
        ↓
POST /api/checkout
```

MVP does not require a perfect whole-program call graph.

One or two useful reference-expansion levels are enough.

---

# 24. RepositoryIndex

Do not treat embeddings as the primary repository representation.

Maintain structured data resembling:

```typescript
type RepositoryIndex = {
  headSha: string;

  manifests: ManifestInfo[];

  files: SourceFileInfo[];

  imports: ImportInfo[];

  symbols: SymbolInfo[];

  providerUsages: ProviderUsage[];

  references: ReferenceEdge[];
};
```

For MVP this may be generated on demand and partially persisted.

Persist enough information to avoid repeatedly scanning unchanged commits.

Repository index identity:

```text
repository_id + commit_sha + analyzer_version
```

---

# 25. Candidate repository filtering

Never call the expensive agent immediately after every provider change.

Pipeline:

```text
ChangeEvent
     ↓
repositories with provider dependency
     ↓
supported language?
     ↓
repository head/index available?
     ↓
relevant usage candidates?
     ↓
impact reasoning
```

Each layer should reduce the candidate set.

This architecture becomes important when supporting many repositories later.

---

# 26. Impact analysis

Input should include:

```text
ChangeEvent
provider evidence
provider docs/migration guidance
dependency version
provider usages
relevant source snippets
nearby types
local callers when useful
repository config
```

Output schema:

```typescript
type ImpactDecision = {
  status: "affected" | "unaffected" | "uncertain";

  confidence: number;

  summary: string;

  evidence: Array<{
    file: string;
    lineStart: number;
    lineEnd: number;
    symbol?: string;
    explanation: string;
  }>;

  suggestedMigration?: string;
};
```

Every referenced file and line must be validated against the checked-out repository before accepting the decision.

The model cannot claim nonexistent source evidence.

---

# 27. Impact gating

Use conservative policy.

Suggested initial behavior:

```text
unaffected
→ stop

uncertain
→ store result
→ require human/manual trigger
→ no automatic PR

affected + evidence
→ migration run
```

Do not rely purely on a numerical confidence score.

Require valid source evidence.

---

# 28. Agent architecture

Do not build many autonomous agents for the MVP.

Use one main coding agent controlled by the migration runner.

Logical AI tasks may still be separated:

```text
change normalization
impact classification
migration execution
```

but they can use the same configured OpenAI model.

The application orchestrates them.

---

# 29. Agent tools

The coding model should receive a constrained tool set similar to:

```text
list_tree(path, depth)

search_code(query, glob?)

read_file(path, startLine?, endLine?)

find_symbol(name)

find_references(symbol)

apply_patch(diff)

run_validation(commandId)

get_change_event()
```

Do not provide an unrestricted arbitrary shell tool directly to the model unless carefully sandboxed.

Preferred design:

The model can request one of the repository's predefined validation commands through identifiers.

For development/debugging, a controlled `run_command` may exist inside the isolated sandbox with:

- timeout,
- output limits,
- command logging,
- environment sanitization.

---

# 30. Agent prompt contract

The migration agent should be told:

```text
You are modifying a customer repository to adapt it to a documented external API change.

The provider change supplied to you is authoritative.

Do not modify unrelated code.

Do not invent provider behavior.

Inspect the repository before editing.

Prefer the smallest correct patch.

Preserve existing architectural patterns.

Update tests when behavior changes.

Do not weaken tests to make the migration pass.

Do not remove validation.

Do not modify CI/security configuration unless the migration directly requires it.

Finish only after required validation commands succeed or you have exhausted the allowed attempts.
```

The agent should receive explicit changed-provider evidence, not merely a prose description.

---

# 31. Model isolation from source-of-truth logic

The LLM may:

- interpret change impact,
- understand wrappers,
- plan migrations,
- edit code,
- explain changes.

The LLM must not be the authority for:

- whether two specs differ,
- whether a dependency exists,
- whether a file exists,
- whether a command passed,
- whether tests passed,
- whether a GitHub PR was successfully created.

Those are deterministic system facts.

---

# 32. Sandbox

Every migration runs in an isolated environment.

MVP implementation:

```text
Docker container
```

Sandbox properties:

- disposable,
- non-root user,
- CPU limit,
- memory limit,
- execution timeout,
- no Docker socket,
- no host credentials,
- no production secrets,
- dedicated working directory,
- sanitized environment.

Repository files are copied/cloned into the sandbox.

After the migration completes, destroy the environment.

---

# 33. Network policy

Dependency installation may require network access.

Therefore support execution phases:

```text
SETUP
  network optionally enabled
  npm/pnpm install

MIGRATION
  network restricted where practical

VALIDATION
  external API calls should generally be mocked
```

Do not inject real Stripe API keys into arbitrary repositories.

If a repository's tests require production credentials, mark those validations unavailable rather than supplying secrets.

---

# 34. Repository configuration

Allow optional configuration through a committed file.

Example:

```yaml
version: 1

providers:
  - stripe

validation:
  install: pnpm install --frozen-lockfile
  commands:
    - pnpm typecheck
    - pnpm lint
    - pnpm test

migration:
  maxAttempts: 3
  draftPullRequests: true

ignore:
  - dist/**
  - generated/**
```

Configuration filename:

```text
refit.yml
```

Use this name consistently in configuration parsing, examples, documentation, and fixture repositories.

Configuration must be schema validated.

Reasonable defaults should allow a simple project to work without this file.

---

# 35. Validation

Validation has ordered stages:

```text
install
  ↓
syntax/build
  ↓
typecheck
  ↓
lint
  ↓
tests
```

Not every repository has every stage.

Auto-detect common package scripts where possible.

User config overrides auto-detection.

Store each result:

```text
command
started_at
completed_at
exit_code
duration
stdout summary
stderr summary
status
```

Large output should be truncated or stored separately.

---

# 36. Repair loop

Migration attempts are bounded.

Example:

```text
Attempt 1
   ↓
tests fail
   ↓
failure returned to agent
   ↓
Attempt 2
   ↓
typecheck fails
   ↓
failure returned to agent
   ↓
Attempt 3
   ↓
passes
```

Maximum attempts default:

```text
3
```

No infinite loops.

If attempts are exhausted:

```text
migration_run.status = failed_validation
```

No automatic PR by default.

Retain enough information for debugging.

---

# 37. Pull request creation

Successful migration:

```text
base SHA analyzed
      ↓
create branch
      ↓
commit exact validated working tree
      ↓
push
      ↓
draft PR
```

Branch naming:

```text
refit/<provider>/<short-change-id>
```

Example:

```text
refit/stripe/chg_81df2a
```

Do not place raw user-controlled text directly in branch names.

---

# 38. Pull request body

Template:

```markdown
## Stripe API migration

Refit detected an API change affecting this repository.

### Provider change

<normalized description>

### Why this repository is affected

- `src/billing/stripe.ts:48`
- `src/payments/create-payment.ts:91`

<short explanation>

### Changes made

- ...
- ...

### Validation

- ✅ `pnpm typecheck`
- ✅ `pnpm lint`
- ✅ `pnpm test`

### Source

Stripe OpenAPI revision:
<revision>

Change ID:
<change-event-id>

---
Generated as a draft by Refit. Review before merging.
```

Do not include hidden model reasoning.

---

# 39. Workflow orchestration

Long-running operations must not live inside HTTP request handlers.

Use durable jobs.

Primary job types:

```text
FETCH_PROVIDER_SNAPSHOT

DIFF_PROVIDER_SNAPSHOTS

NORMALIZE_PROVIDER_CHANGE

SCAN_REPOSITORY

ANALYZE_IMPACT

RUN_MIGRATION

VALIDATE_MIGRATION

PUBLISH_PULL_REQUEST
```

Some may later be collapsed or split.

The domain boundaries matter more than exact job names.

---

# 40. PostgreSQL job queue

For the MVP, implement a small durable PostgreSQL-backed queue instead of introducing Redis/BullMQ/Temporal immediately.

Schema concept:

```text
jobs
----
id
type
status
payload_json
idempotency_key
priority
attempt
max_attempts
run_after

lease_owner
lease_expires_at

last_error

created_at
started_at
completed_at
updated_at
```

Statuses:

```text
queued
running
succeeded
failed
cancelled
```

Workers claim jobs transactionally using PostgreSQL row locking, e.g. the equivalent of:

```sql
FOR UPDATE SKIP LOCKED
```

Use leases so a crashed worker does not permanently own a task.

---

# 41. Worker crash recovery

When claiming a job:

```text
lease_owner = worker UUID
lease_expires_at = now + lease duration
```

Worker periodically renews the lease for long-running operations.

If worker dies:

```text
lease expires
      ↓
job becomes eligible
      ↓
another worker retries it
```

Operations must therefore be idempotent.

---

# 42. LISTEN/NOTIFY optimization

Polling is sufficient for correctness.

Optionally add PostgreSQL `LISTEN/NOTIFY` so workers wake when work arrives.

Architecture:

```text
job persisted in table
        ↓
COMMIT
        ↓
NOTIFY workers
```

The database row remains the source of truth.

Notifications are only a wake-up mechanism.

If a notification is lost, polling still processes the job.

This mirrors a useful durable-system design principle:

```text
durability first
realtime notification second
```

---

# 43. Retry strategy

Jobs specify whether errors are retryable.

Retry examples:

```text
GitHub 5xx        retry
OpenAI 429        retry
temporary network retry

invalid schema    limited model retry
GitHub 401        refresh installation token then retry

unsupported repo  do not retry
invalid config    do not retry
```

Use bounded exponential backoff with jitter.

Never retry forever.

---

# 44. Idempotency requirements

Every externally triggered workflow needs an idempotency boundary.

Examples:

```text
GitHub webhook
→ GitHub delivery ID

provider snapshot
→ provider/source/revision

ChangeEvent
→ change fingerprint

impact analysis
→ change_event + repository + head_sha

migration
→ impact_analysis + head_sha

PR
→ migration_run
```

Enforce critical idempotency using database uniqueness, not application memory.

---

# 45. Database model

Minimum entities:

```text
users

github_installations
repositories
webhook_deliveries

providers
provider_sources
provider_snapshots

change_events

repository_dependencies
repository_indexes
provider_usages

impact_analyses

migration_runs
migration_attempts
validation_runs

pull_requests

jobs
```

---

# 46. Important entity relationships

```text
Provider
   │
   ├── ProviderSource
   │       │
   │       └── ProviderSnapshot
   │                 │
   │                 └── ChangeEvent
   │                          │
   │                          ▼
Repository ── RepositoryDependency
   │                          │
   └─────────────── ImpactAnalysis
                              │
                              ▼
                         MigrationRun
                              │
                      ┌───────┴────────┐
                      ▼                ▼
              MigrationAttempt    ValidationRun
                      │
                      ▼
                 PullRequest
```

---

# 47. MigrationRun state machine

Possible states:

```text
queued
preparing
analyzing
editing
validating
repairing
ready_to_publish
publishing
pr_opened

failed_setup
failed_agent
failed_validation
failed_publish
cancelled
```

Persist transitions.

Do not infer important workflow state from log text.

---

# 48. Exact-code-version requirement

Impact analysis and migration must be tied to a commit SHA.

Example:

```text
Impact analysis used SHA A.

User pushes SHA B before migration runs.
```

Refit must not silently apply an analysis from A to B.

Policy:

Either:

```text
re-run impact against B
```

or intentionally perform migration against A and detect branch divergence before publishing.

For MVP, prefer re-analysis when default-branch head changed.

---

# 49. Concurrency controls

Prevent duplicate migrations.

Useful lock dimensions:

```text
provider source snapshot fetch
repository scan
change-event + repository impact
migration per repository/change
```

Database uniqueness and job idempotency should handle most cases.

Do not rely on in-process mutexes.

---

# 50. OpenAI integration

Model calls should be wrapped behind an internal interface.

Example:

```typescript
interface ReasoningClient {
  normalizeChange(...): Promise<ChangeEventDraft>;
  analyzeImpact(...): Promise<ImpactDecision>;
  runMigration(...): Promise<AgentResult>;
}
```

Do not scatter direct OpenAI SDK calls throughout the codebase.

This makes:

- model changes,
- testing,
- fixtures,
- cost accounting

much easier.

---

# 51. Structured model outputs

Use strict schemas for classification tasks.

Examples:

```text
ChangeEventDraft
ImpactDecision
MigrationPlan
```

Validate every response.

If structured output cannot be validated, the application treats the operation as failed.

Do not parse important application state from natural-language paragraphs.

---

# 52. Agent execution record

Persist an execution record containing:

```text
model
model request ID if available
started/completed timestamps
tool calls
tool outcomes
token/cost metadata if available
final status
```

Do not persist private chain-of-thought.

Do not show chain-of-thought in the product.

Useful explanations should come from structured summaries/evidence.

---

# 53. Code privacy

Ordinary application logs must not contain entire customer source files.

Logs may contain:

```text
repository ID
file path
symbol
operation
duration
status
error category
```

Avoid logging source contents by default.

Sandbox contents are ephemeral.

Generated patch/diff may be persisted because it is part of the product artifact, but this should be explicit.

---

# 54. Provider documentation context

Provider facts should follow source precedence:

```text
1. machine-readable provider specification
2. official migration documentation
3. official provider changelog
4. official SDK source/types
5. model interpretation
```

Model memory is never the authoritative source.

A future Context7 integration may provide additional current documentation context, but the system should not require Context7 for the Stripe MVP.

---

# 55. Version awareness

Record all useful versions:

```text
provider API revision
provider snapshot commit SHA
Stripe SDK version
repository commit SHA
analyzer version
agent model
prompt version
```

This makes a migration reproducible and debuggable.

---

# 56. Prompt versioning

Store prompts/templates in source control.

Each should have a logical version.

Example:

```text
change-normalizer:v1
impact-analyzer:v1
migration-agent:v1
```

Migration records store the prompt version.

Do not silently modify production prompts without version traceability.

---

# 57. Observability

Every workflow receives:

```text
trace_id
run_id
```

Structured logs.

Core metrics:

```text
provider_snapshots_total

change_events_total

impact_analysis_total
impact_affected_total
impact_unaffected_total
impact_uncertain_total

migration_runs_total
migration_success_total
migration_failure_total

validation_duration
migration_duration
provider_poll_duration

model_requests
model_tokens/cost

github_prs_opened
```

OpenTelemetry is desirable but should not block the initial working pipeline.

---

# 58. Audit timeline

Every change/repository pairing should expose an internal timeline such as:

```text
12:01 Stripe snapshot detected
12:01 API diff generated
12:02 ChangeEvent created
12:02 repository selected
12:03 impact analysis: affected
12:03 migration sandbox started
12:04 patch generated
12:04 typecheck passed
12:05 tests failed
12:05 repair attempt started
12:06 tests passed
12:06 draft PR opened
```

This becomes useful both for debugging and later UI.

---

# 59. API surface

Exact route naming is flexible.

Expected control-plane capabilities:

```text
GET  /health

POST /github/webhook

GET  /repositories
GET  /repositories/:id
POST /repositories/:id/rescan

GET  /providers
GET  /providers/:id/changes

GET  /changes/:id

GET  /impact-analyses/:id

POST /impact-analyses/:id/migrate

GET  /migration-runs/:id
GET  /migration-runs/:id/logs

POST /internal/providers/:id/poll
```

Internal/provider polling endpoints must be authenticated or unavailable publicly.

---

# 60. Development replay mode

Waiting for Stripe to ship a change is unacceptable for development and demonstrations.

Implement a replay capability.

Input:

```text
old Stripe OpenAPI revision
new Stripe OpenAPI revision
fixture repository
```

Then execute the normal pipeline.

Do not create a completely separate fake demo implementation.

Replay should insert the same snapshots and jobs production ingestion would.

This makes the demo deterministic.

---

# 61. Demo fixture repository

Create a realistic TypeScript backend fixture.

Example structure:

```text
demo-saas/
├── src/
│   ├── api/
│   ├── billing/
│   │   ├── stripe-client.ts
│   │   └── payments.ts
│   └── services/
├── tests/
├── package.json
├── tsconfig.json
└── refit.yml
```

Avoid putting the affected Stripe call directly in a trivial `index.ts`.

Use one abstraction layer so impact analysis has something meaningful to understand.

Example:

```text
checkout route
     ↓
PaymentService
     ↓
StripeGateway
     ↓
Stripe SDK
```

---

# 62. MVP demo sequence

A successful live/demo recording should show:

### Before

Repository contains working code against older API expectations.

### Trigger

Replay or ingest a real historical Stripe OpenAPI difference.

### Change detection

System displays/logs a normalized change.

### Repository matching

System detects repository uses Stripe.

### Impact

System identifies the exact Stripe integration and source evidence.

### Migration

Sandbox starts.

Agent changes implementation.

### Validation

Show real command execution:

```text
typecheck ✓
tests ✓
```

### Result

A real GitHub draft PR appears.

The PR should contain a meaningful diff.

No mocked final PR screenshot.

---

# 63. Test strategy

## Unit tests

Test:

- provider snapshot hashing,
- Stripe adapter,
- oasdiff parser,
- change fingerprinting,
- config parsing,
- job transitions,
- retry rules,
- GitHub signature validation,
- dependency detection,
- AST extraction,
- structured AI output validation.

## Integration tests

Use temporary PostgreSQL.

Test:

```text
job claim
job lease expiry
retry
duplicate idempotency key
LISTEN/NOTIFY fallback
```

Test provider diff pipeline with committed fixtures.

## Repository-analysis tests

Fixture repositories should cover:

```text
direct Stripe import
aliased import
wrapped Stripe call
unused Stripe dependency
multiple Stripe calls
unrelated PaymentIntent code
```

## Agent tests

Do not require every CI run to call a paid model.

Provide recorded deterministic fixtures/mocks for ordinary CI.

Maintain optional live-model end-to-end tests.

## End-to-end test

One command should eventually be able to execute:

```text
known Stripe diff
      ↓
fixture repository
      ↓
impact
      ↓
migration
      ↓
validation
      ↓
local/mock GitHub publishing boundary
```

Live demo mode can target a real demo GitHub repository.

---

# 64. Failure cases that must be tested

The implementation is incomplete unless these have explicit behavior:

### Provider poll returns same revision

No duplicate work.

### Provider snapshot changes but no relevant API changes

No ChangeEvent requiring migration.

### Duplicate GitHub webhook

Processed once.

### Repository does not use Stripe

No model call for migration.

### Repository uses Stripe but not affected operation

Impact = unaffected.

### Model references nonexistent file

Reject evidence.

### Model emits malformed structured response

Retry then fail cleanly.

### npm install fails

Migration = failed setup.

### Tests fail after maximum repair attempts

No PR.

### Worker dies while migrating

Lease expires and workflow can resume/retry safely.

### GitHub token expires

Create a fresh installation token.

### Default branch changes during workflow

Detect stale SHA and re-evaluate.

### PR already exists for migration

Do not create another.

---

# 65. Security requirements

Minimum requirements:

- webhook signature validation,
- least-privilege GitHub App,
- ephemeral installation tokens,
- encrypted application secrets,
- no production customer credentials in sandbox,
- isolated repository execution,
- strict path validation,
- no `../` path escapes,
- no Docker socket exposure,
- non-root container,
- execution timeout,
- CPU/memory limits,
- request validation,
- rate limiting on externally accessible mutation endpoints,
- sanitized logs.

Treat cloned repositories as untrusted code.

---

# 66. Repository instructions and prompt injection

Customer repositories may contain text intended to manipulate coding agents.

Repository content is untrusted data.

The migration agent's system instructions must explicitly establish precedence:

```text
provider change evidence + Refit system rules
        >
repository instructions
```

Repository instructions may guide style/build commands but cannot authorize:

- accessing secrets,
- uploading source elsewhere,
- disabling security controls,
- bypassing validation,
- changing Refit system behavior.

---

# 67. Cost controls

Before using an expensive model:

```text
provider dependency filter
     ↓
AST usage filter
     ↓
small context selection
     ↓
model
```

Set limits for:

```text
maximum source files
maximum source bytes
maximum agent steps
maximum migration attempts
maximum model tokens
```

Track cost per:

```text
ChangeEvent
ImpactAnalysis
MigrationRun
repository
```

---

# 68. Performance goals

These are engineering goals, not claims.

For a small/medium TypeScript repository:

```text
dependency scan: seconds, not minutes

impact analysis:
target under roughly 1–2 minutes

successful migration:
target under several minutes

HTTP endpoints:
ordinary control-plane requests should not wait for agent work
```

Long work is asynchronous.

---

# 69. Quality benchmark

Create an evaluation set before claiming the agent is reliable.

Example benchmark:

```text
10–20 repository/change scenarios
```

Include:

```text
affected direct usage
affected wrapped usage
unaffected usage
similar-but-unrelated code
multiple relevant files
migration that requires test changes
```

Record:

```text
impact precision
impact recall
migration success rate
validation pass rate
false PR rate
average attempts
average runtime
```

Never fabricate metrics.

Only add measured numbers to a resume after running the benchmark.

---

# 70. Implementation order

## Phase 0 — foundation

Build:

```text
monorepo
PostgreSQL
database migrations
configuration
logging
Docker Compose
```

Done when API + worker start locally and worker can claim a test durable job.

## Phase 1 — GitHub integration

Build:

```text
GitHub App auth
installation storage
repository listing
clone/read access
webhook validation
repository metadata
```

Done when a real GitHub App can connect a demo repository and Refit records it.

## Phase 2 — repository analysis

Build:

```text
package dependency detection
TypeScript analyzer
Stripe usage extraction
repository index
```

Done when fixture repository usage is extracted deterministically.

## Phase 3 — Stripe change ingestion

Build:

```text
ProviderAdapter
StripeAdapter
snapshot storage
Stripe OpenAPI retrieval
oasdiff execution
ChangeEvent normalization
replay mode
```

Done when two historical/provider fixture revisions generate normalized changes.

## Phase 4 — impact analysis

Build:

```text
candidate filtering
relevant context extraction
OpenAI structured decision
evidence validation
```

Done when affected and unaffected fixtures are correctly distinguished.

## Phase 5 — migration agent

Build:

```text
sandbox
agent tool loop
file edits
validation commands
bounded repair attempts
```

Done when a known migration produces a passing local working tree.

## Phase 6 — GitHub PR publishing

Build:

```text
branch creation
commit
push
draft PR
PR body
idempotency
```

Done when the end-to-end workflow opens a real draft PR.

## Phase 7 — hardening

Add:

```text
worker leases
retry behavior
stale SHA handling
duplicate handling
security constraints
observability
benchmark suite
```

## Phase 8 — UI

Implement the visual and interaction requirements in section 80. The landing page and design exploration can be developed earlier, but connected application behavior and the replay demo must use the reliable backend pipeline. UI completion is required for the finished product; it is not an optional future design pass. Never substitute a simulated success state for a working migration.

---

# 71. MVP acceptance criteria

The MVP is complete when all of the following are true:

1. A GitHub App can be installed on a repository.

2. Refit can identify that the repository uses Stripe.

3. The Stripe provider is implemented through the generic provider interface.

4. Refit can store two Stripe OpenAPI snapshots.

5. Refit can run a deterministic OpenAPI diff.

6. A meaningful API difference becomes a persisted normalized `ChangeEvent`.

7. Candidate filtering avoids running migration analysis against unrelated repositories.

8. TypeScript analysis can locate Stripe usages in realistic wrapper code.

9. An OpenAI model can produce an evidence-backed impact decision.

10. Invalid evidence is rejected.

11. Affected code is modified in an isolated Docker environment.

12. Actual repository validation commands are executed.

13. The agent receives validation failures and can attempt bounded repairs.

14. A PR is created only after required validation succeeds.

15. The PR is a draft.

16. The PR clearly explains the provider change, code impact, edits, and validation results.

17. Duplicate provider events/webhooks do not create duplicate PRs.

18. Worker/process failure does not permanently lose a workflow.

19. A deterministic replay mode can reproduce the entire demo.

20. The Stripe-specific implementation can be removed/replaced without rewriting the generic orchestration, job, repository, agent, or PR systems.

---

# 72. Second-provider test

Before considering the provider architecture successful, perform a design-only or small experimental second adapter.

It does not need full product support.

For example:

```text
OpenAI
Twilio
Resend
```

Implement enough to verify:

```text
new provider
    ↓
new provider adapter
```

rather than:

```text
modify 14 Stripe assumptions across core code
```

If adding another provider requires widespread `if provider === "stripe"` conditions, refactor before continuing.

---

# 73. What not to abstract yet

Avoid speculative abstraction.

Keep these GitHub-specific during MVP:

- pull request publication,
- installation authentication,
- repository webhooks.

Do not build a generic `SourceControlProvider` until another source-control platform is actually being added.

Keep Docker-specific sandbox implementation behind a simple boundary, but do not build a generalized compute platform.

Generalize only obvious product seams:

```text
provider
language analyzer
AI client
blob storage
sandbox runner
```

---

# 74. Future expansion

After the MVP is stable, likely extensions include:

### More provider sources

```text
official changelogs
documentation diffs
SDK releases
GitHub releases
OpenAPI HTTP sources
```

### More providers

```text
OpenAI
Twilio
Resend
Clerk
Supabase
Plaid
```

### More languages

```text
Python
Go
Java
```

### Better repository intelligence

```text
cross-file call graph
type graph
framework-aware route graph
test-to-code relationships
```

### New-feature recommendations

Instead of only:

```text
"You must migrate."
```

support:

```text
"The provider introduced a feature that could replace this workaround."
```

These should initially require manual review.

### Provider-facing product

Long-term:

```text
API provider publishes change
          ↓
Refit identifies affected customers
          ↓
customer-specific migration PRs
```

Provider can supply first-party migration context directly.

This moves closer to a true self-maintaining API ecosystem.

---

# 75. Resume-project engineering priorities

When tradeoffs exist, prioritize backend systems that produce strong technical discussion:

```text
durable jobs
worker leases
idempotency
GitHub App authentication
webhooks
OpenAPI contracts
AST analysis
provider plugins
sandbox isolation
agent tool design
validation
observability
failure recovery
```

Deliver the startup-quality UI and purposeful landing-page text and object animations specified in section 80. Scope visual work deliberately so backend correctness remains protected.

Avoid disproportionate effort on:

```text
an elaborate design-system platform
unrelated visual effects
auth-provider customization
billing
marketing analytics
```

The implementation should demonstrate why the system is more than an LLM wrapper.

---

# 76. Expected interview explanation

The finished project should make it possible to explain:

> Refit monitors authoritative API sources such as OpenAPI specifications. I normalize provider changes into a provider-neutral ChangeEvent and use dependency and AST analysis to determine which repositories are candidates before invoking a model. For affected repositories, an OpenAI-powered coding agent operates inside an isolated container with narrow repository tools. Generated changes must pass the project's actual typechecks and tests before the system creates a draft GitHub PR. Long-running workflows are backed by a PostgreSQL job system with idempotency, worker leases, retries, and persisted state, so duplicate webhooks and worker failures do not result in duplicate or lost migrations.

Every sentence above should correspond to functionality that actually exists.

---

# 77. Coding standards

Use:

- strict TypeScript,
- explicit domain types,
- schema validation at boundaries,
- migrations for database changes,
- dependency injection where it improves testing,
- structured errors,
- structured logs,
- unit tests around deterministic logic.

Avoid:

- massive service classes,
- business logic inside route handlers,
- hidden global state,
- swallowing errors,
- generic `any`,
- enormous prompts assembled ad hoc,
- model calls with no schema,
- arbitrary `if provider === "stripe"` logic throughout core modules.

---

# 78. Definition of "agent"

For this product, an agent is not merely a model call.

The migration agent consists of:

```text
OpenAI model
     +
authoritative provider context
     +
repository context
     +
controlled tools
     +
persistent orchestration
     +
sandbox environment
     +
validation feedback
     +
bounded repair loop
```

The OpenAI model is the reasoning engine.

Refit is the agentic system.

---

# 79. Definition of successful MVP

The MVP is not successful because a dashboard says:

```text
"Stripe change detected."
```

It is successful when this happens for real:

```text
real Stripe specification revisions
              ↓
deterministic API difference
              ↓
real TypeScript repository
              ↓
actual affected usage discovered
              ↓
OpenAI model modifies real source
              ↓
real tests/typechecking pass
              ↓
real GitHub draft PR appears
```

That single loop should work reliably before broadening the product.

---

# 80. UI / UX — REFIT PRODUCT DESIGN REQUIREMENTS

## 80.1 Design objective

Refit must look and feel like a focused developer-tool startup: confident typography, an identifiable visual system, direct product language, convincing product demonstrations, and carefully finished interactions.

The interface should answer three questions immediately: what changed, whether my repository is affected, and what I need to review.

The landing page should make the product understandable before asking visitors to connect a repository. The application should make evidence and outcomes easy to inspect. Do not turn either into a generic AI chat interface.

## 80.2 Reference interpretation

Use Screenpipe and Nango heavily for UI/UX inspiration only. Build an original composition around Refit's migration workflow.

| Reference | Observed UI/UX pattern | Refit application |
|---|---|---|
| Screenpipe landing page | Bold technical typography, neutral surfaces, thin rules, geometric background detail | Strong headline hierarchy, restrained grid/line motifs, generous whitespace, crisp boundaries |
| Screenpipe interactive previews | A visible trigger followed by understandable steps and a result | A visitor-controlled explanation of API change → impact evidence → validated patch → draft PR |
| Screenpipe onboarding source | Explicit setup stages and consistent framing | A short GitHub installation flow with clear progress and recovery |
| Nango dashboard layout and sidebar | Persistent navigation, consistent headers, aligned title/action/content regions | A coherent shell for repositories, changes, migration runs, and settings |
| Nango integration picker | Searchable resource rows, provider identity, compact metadata, loading and no-match states | Searchable repositories and provider changes with concise status and useful empty states |
| Nango public website | Product/code visuals beside concise benefit statements | Show a concrete code migration and its evidence instead of abstract AI imagery |

Research basis: the public websites and the linked frontend source files were inspected on September 26, 2026. Nango's authenticated dashboard was not accessed; application observations are grounded in its public source. Revisit live references before implementation because their designs may change.

Source files for design reference:

- [Screenpipe global styles](https://github.com/screenpipe/screenpipe/blob/main/apps/screenpipe-app-tauri/app/globals.css)
- [Screenpipe onboarding](https://github.com/screenpipe/screenpipe/blob/main/apps/screenpipe-app-tauri/app/onboarding/page.tsx)
- [Nango dashboard layout](https://github.com/nangohq/nango/blob/master/packages/webapp/src/layout/DashboardLayout.tsx)
- [Nango sidebar](https://github.com/nangohq/nango/blob/master/packages/webapp/src/layout/AppSidebar/index.tsx)
- [Nango integration picker](https://github.com/nangohq/nango/blob/master/packages/webapp/src/pages/Integrations/CreateList.tsx)
- [Nango typography and global styles](https://github.com/nangohq/nango/blob/master/packages/webapp/src/index.css)
- [Nango public website](https://nango.dev/)

The references are not permission to import their product scope. Refit does not gain recording, memory, credential-brokering, or integration-building features because those appear in a reference.

If a reference cannot be accessed during implementation, tell the user immediately what is unavailable and ask for the missing direction. Do not claim to have inspected an inaccessible screen.

## 80.3 Brand and visual system

Use **Refit** in all visible branding and product copy. The existing one-line descriptor is: **The agent that keeps your API integrations up to date.**

Design an original, simple Refit mark that remains legible as a favicon, repository avatar, and navigation logo. A refitting or realignment motif can inform it; do not trace either reference's logo.

Starting visual direction:

- Light neutral marketing canvas, near-black headings, white work surfaces, and fine neutral borders. Dark code panels provide deliberate contrast.
- One restrained blue brand accent for interactive emphasis. Status colors have separate semantic roles and always include text or an icon.
- A modern sans-serif family for headings and UI, paired with monospace for code, paths, versions, and compact technical annotations. Self-host licensed font files.
- Large, concise headlines; body text with comfortable line height; restrained corner radii; shadows only where they establish depth.
- A consistent spacing scale and shared tokens for colors, typography, borders, radii, focus rings, and motion. Marketing and application surfaces should belong to the same product.
- Sparse technical geometry that relates to the migration story. No generic glowing AI orb, unrelated stock photography, or decorative metrics dashboard.

Use a coherent theme rather than mixing the references' palettes. Dark mode is optional for the initial release; it must be complete across surfaces if offered.

The design should feel specific through its typography, composition, code evidence, and motion. Avoid repetitive feature-card grids, excessive pill badges, unnecessary gradients, and a large collection of unrelated effects.

## 80.4 Landing page structure and copy

### Navigation

Use a compact, single-line desktop header: Refit, How it works, Demo, Docs, GitHub, and one primary action. Collapse navigation into an accessible menu on small screens.

### Hero

Suggested headline: **APIs change. Your code keeps up.**

Supporting copy: **Refit finds affected code, validates a migration, and opens a draft pull request for your review.**

Primary action: **Connect GitHub**, once GitHub installation is operational. Secondary action: **See a migration**, leading to the demo.

Before installation is available, make **Explore the demo** the primary action only if the demo exists; otherwise link to the actual project documentation. Do not ship a dead CTA, invent a waitlist, or make a simulated connection look successful.

Pair the copy with a prominent migration visual: provider change, affected source, validation result, and draft PR. Keep the complete message available as readable text even while the visual animates.

### Product explanation

Explain the sequence through an interactive product story:

1. Detect a provider change from a versioned, authoritative source.
2. Identify affected usage in a connected repository.
3. Generate and validate a migration in isolation.
4. Open a draft PR for human review.

Selecting a step should reveal its associated evidence or artifact. Visitors should control the pace. Do not require an account just to understand the workflow.

### Proof through the product

Show one coherent Stripe/TypeScript migration example with source context, a readable diff, actual validation output, and its resulting draft PR when those artifacts exist.

A marketing illustration may be labeled **Illustrative example**. A recorded run must be labeled **Recorded replay** and retain its actual result. Neither satisfies the working demo acceptance criteria in sections 60–62.

Do not invent GitHub PR links, passing checks, execution times, supported providers, customer logos, testimonials, user counts, or performance claims.

### Review and control

Explain the concrete controls: repository selection, configuration in `refit.yml`, isolated execution, required checks, and human review before merge. Link to the documentation that describes permissions and data handling.

### FAQ and final action

Answer the practical questions: supported provider and language, GitHub permissions, what happens when checks fail, whether code is auto-merged, and how to inspect a migration.

Finish with one clear next step and a compact footer linking to real project resources. Do not include pricing, contact, policy, or status links until corresponding content exists.

## 80.5 Landing-page motion

Include animation for both text and visual objects. Its purpose is first-visit delight and explanation of the migration workflow.

| Element | Required behavior |
|---|---|
| Hero text | A short line-by-line opacity and upward-translation entrance; preserve one semantic heading and stable layout |
| Migration visual | Move a change marker through detection, impact analysis, validation, and draft-PR stages; reveal matching evidence as each stage becomes active |
| Code diff | Briefly emphasize the changed lines when selected, then leave them still and readable |
| Section entrances | Subtle one-time reveals as sections enter the viewport; content must remain accessible without animation |
| Buttons and interactive objects | Small, immediate hover/press feedback; hover transforms apply only to fine pointers that support hover |

Motion defaults are shared named tokens: interaction feedback 160 ms, standard transitions 220 ms, marketing entrances 600 ms, and text stagger 60 ms. Use `cubic-bezier(0.23, 1, 0.32, 1)` for entrances. Animate transform and opacity rather than layout properties.

The marketing sequence may autoplay once, then settle into a readable final state. Provide pause and replay controls for the sequence. Manual stage selection interrupts autoplay and retains the visitor's selection. Pause offscreen animation and stop timers/listeners when the component unmounts.

Honor reduced-motion preferences: replace spatial travel and staggered text with an immediate or short opacity change, disable autoplay, and retain all stages and controls. No flashing, scroll hijacking, mandatory intro, endless typewriter headline, or movement behind source code while someone is reading it.

Actual run progress is driven by persisted backend events. Animation timing must never fabricate completion, a passing validation stage, or a successful PR.

## 80.6 Routes and application shell

Required public surfaces:

```text
/
/docs
/demo
```

Required application surfaces:

```text
/app
/app/repositories
/app/repositories/:id
/app/changes
/app/changes/:id
/app/runs
/app/runs/:id
/app/settings
```

The application uses a persistent sidebar, a consistent page header, and a primary content region. Navigation contains Overview, Repositories, API changes, Migration runs, and Settings. Put documentation and account controls in predictable secondary positions.

Maintain selected navigation and relevant filters on deep links and browser back/forward navigation. Do not add organization or environment selectors unless the product actually supports those concepts.

The overview prioritizes actionable work: repositories needing attention, changes awaiting review, active migrations, and failed runs. Avoid empty charts or vanity counters. A new account gets a useful setup state rather than a dashboard filled with zeroes.

## 80.7 Onboarding

Keep the first-use flow short and explicit:

1. Explain what Refit does and the GitHub permissions it needs; begin the real GitHub App installation.
2. Let the user choose repositories within the granted installation scope.
3. Show initial scan progress and the detected supported integrations.
4. Confirm monitoring only when the backend has successfully initialized it; offer the replay demo as a separate learning path.

Support installation cancellation, denied permissions, no repositories, unsupported repositories, and failed scans with specific recovery actions. Preserve completed steps across navigation and refresh. Do not ask for unrelated team, billing, or production credential setup.

## 80.8 Resource and detail views

### Repositories

Use a searchable list with repository identity, detected supported providers, scan/monitoring status, last successful scan, and outstanding action. Link each row to repository detail. Offer a rescan only when available and show the accepted operation's real progress.

Repository detail includes monitored providers, source revision, relevant configuration, recent changes, and migration history. Distinguish “not scanned” from “no supported integrations found.”

### API changes

Use a searchable, filterable list with provider, concise change summary, provider revision, detection time, affected repositories, and impact state. Preserve selected filters in the URL.

Change detail leads with what changed and why it matters. Then show authoritative provider evidence, repository-specific impact, affected files and symbols, and available migration actions. Clearly separate “unaffected” from “not analyzed” and “uncertain.”

### Migration runs

The run list supports repository and state filters. Detail shows a chronological timeline, current stage, bounded repair attempts, code diff, validation commands with exit codes, and a draft-PR link once publication succeeds.

Keep a concise summary visible while allowing logs and evidence to expand. Failure views identify the failed stage and actionable cause. An unavailable or skipped check cannot appear as a passing check.

### Settings and documentation

Group settings by repository access, monitoring, and validation. Explain which settings come from `refit.yml`; do not introduce a conflicting configuration source. Show successful persistence before reporting a setting as saved.

Documentation covers installation, permissions, supported scope, configuration, migration review, failures, and the replay demo. Code blocks are readable and copyable. Documentation uses Refit names and working links throughout.

## 80.9 State model and feedback

Keep impact classification separate from run execution. The backend remains authoritative.

| State | Meaning and UI treatment |
|---|---|
| Safe / unaffected | Analysis found no affected usage for the stated change and repository revision; retain evidence and timestamp |
| Affected | Evidence identifies relevant code; expose the next available migration action |
| Uncertain | Evidence is insufficient; explain uncertainty and the review required |
| Queued | Work was accepted and is waiting; do not imply execution has begun |
| Analyzing | Impact assessment is running |
| Patching | A migration is being generated |
| Validating | Actual configured checks are executing |
| Repairing | A bounded repair attempt is responding to validation failure |
| PR ready | Draft publication succeeded; show the real GitHub link |
| Failed | Show the failed stage, reason, retained evidence, and supported recovery action |

Also design initial loading, empty, no search results, disconnected installation, permission denied, stale data, missing artifact, unavailable service, and request failure states. Keep existing results visible when a refresh fails, label their freshness, and never replace an error with an empty-state success message.

Use explicit status labels and icons so color is never the only signal. Announce meaningful async updates accessibly without stealing focus or streaming every log line into an announcement region.

## 80.10 Responsive behavior and accessibility

The landing page, docs, and demo must work on phone, tablet, and desktop. Stack the hero and workflow stages on narrow screens. Avoid page-level horizontal overflow; source and diff panels may have their own labeled horizontal scroll areas.

Application navigation becomes an accessible drawer on narrow screens. Resource tables must retain essential identity, status, and actions through a compact layout or an explicitly scrollable region. Do not copy fixed desktop minimum widths from the references.

Use semantic landmarks and heading order, keyboard-operable controls, visible focus, accessible dialogs and menus, meaningful link labels, and labeled form errors. Meet WCAG 2.2 AA contrast requirements and preserve usability at 200% zoom. Aim for 44-pixel touch targets for primary controls.

## 80.11 UI completion criteria

The UI is complete only when:

1. Refit branding is consistent across public pages, application UI, metadata, documentation, configuration examples, and generated artifacts.
2. The landing page has a distinct, coherent developer-tool identity and explains the real workflow without inflated claims.
3. Text and object animations are implemented, interruptible where appropriate, and have reduced-motion behavior.
4. All advertised navigation and primary actions lead to functioning destinations.
5. The interactive demo uses the normal replay pipeline for its actual execution and distinguishes recorded/illustrative content from a live run.
6. Installation, repository browsing, change evidence, run progress, validation results, and draft-PR review are usable end to end.
7. Loading, empty, error, uncertainty, and disconnected states are designed and exercised.
8. Representative phone, tablet, and desktop views are visually inspected after significant changes; keyboard, zoom, and reduced-motion behavior are verified.
9. No invented success data, inert controls, placeholder sections, or fabricated customer evidence remains.
10. Tests cover meaningful behavior: onboarding recovery, filter/navigation persistence, backend-driven states, failed validation, missing PRs, and animation controls.

Backend acceptance in section 71 and UI completion here are separate requirements. A polished interface cannot substitute for the working migration loop, and the finished Refit product should satisfy both.

---

# END OF PRD

When implementing from this document, begin with Phase 0 and proceed in dependency order. Preserve the complete end-to-end architecture, but prefer the simplest implementation capable of satisfying each acceptance criterion. Backend correctness takes precedence when behavior and presentation conflict. Deliver the Refit branding, UI/UX, and landing-page motion specified in section 80 as part of the finished product.
