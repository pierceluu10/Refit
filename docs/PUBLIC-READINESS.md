# Public-repository readiness

`pierceluu10/Refit` is private and meant to become public. This audit covers everything a visitor could read once it is: every branch, tag and pull-request ref, every commit's metadata, and pull-request and issue text. Found values are shown only up to their first four characters. No credential was tested against any service.

Audited on 2026-10-22 from a fresh `git clone --mirror` of GitHub (204 branches, 194 pull-request refs, 25 tags, 982 commits). The `main` head was `fb0143a`.

## Verdict

- **No live credential was found** in any reachable commit, PR, issue or comment. Every secret scanner finding is a test placeholder or a test-only key.
- **Owner decisions remain before publishing:**
  - personal emails in about 1,000 commit, committer and tag fields;
  - third-party code without a license inside one benchmark result;
  - the default branch;
  - the PP5 test keys if that branch merges as is.
- See [Needs owner decision](#needs-owner-decision).

## How the scan was done

1. **Secrets.** gitleaks v8.30.1 ran in Docker, with its default rules, over all refs:

   ```sh
   git clone --mirror https://github.com/pierceluu10/Refit.git refit-mirror.git
   docker run --rm --network none -v "$PWD/refit-mirror.git:/repo:ro" -v "$PWD:/out" \
     zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
     git /repo --log-opts="--all" --report-format json --report-path /out/gitleaks.json --exit-code 0
   ```

   gitleaks scanned 708 commits with diffs (merges carry none), 22.6 MB. The raw report stayed outside the repository and was deleted after this summary.
2. **Account identifiers.** A script read every blob reachable from any ref (`git rev-list --all --objects` → `git cat-file --batch`) and matched these patterns:
   - AWS account IDs (in ARNs, ECR hosts, or near `aws`, `account`, `arn` or `sts`);
   - EC2, security-group, VPC, subnet, AMI, volume and snapshot IDs;
   - `s3://` buckets;
   - Supabase project refs (`<ref>.supabase.co`, pooler users `postgres.<ref>`, dashboard URLs);
   - Fly tokens (`FlyV1 `, `fo1_`) and `*.fly.dev` hosts;
   - personal email domains;
   - private IPv4 ranges;
   - `*.internal`, `*.corp`, `*.lan` hosts;
   - `/Users/<name>` and `/home/<name>` paths;
   - EC2 public hostnames.

   The same patterns ran over all commit messages, all 182 pull-request titles and bodies, 27 issue comments and 0 review comments, via `gh api`. The repository has no issues.
3. **Metadata.** Author, committer and tagger emails of every commit and tag.
4. **Third-party data and licenses.**
   - License or copyright notices anywhere in `HEAD`.
   - The provenance of `pipeline/fixtures` and `public/`.
   - Code-like strings in `docs/benchmarks` and `docs/ai-evals`.
   - Each stored third-party diff's repository license, from the GitHub API.
   - Files that exist only in history.

## Findings

### Secrets (gitleaks)

| # | File:line | Commit | Kind | Where | Still valid? |
|---|---|---|---|---|---|
| S1 | `pipeline/generated-checks.test.ts:33` | `d3e4df3` | stripe-access-token `sk_t…` | `main` | No: letters-only placeholder in a test source string |
| S2 | `pipeline/property-moves.test.ts:134` | `58c3177` | stripe-access-token `sk_t…` | `main` | No: same placeholder |
| S3 | `pipeline/property-moves.test.ts:339` | `9541119` | stripe-access-token `sk_t…` | `main` | No: same placeholder |
| S4 | `pipeline/stripe-package-upgrade.test.ts:252` | `1232923` | stripe-access-token `sk_t…` | `main` | No: same placeholder |
| S5 | `pipeline/stripe-package-upgrade.test.ts:297` | `1232923` | stripe-access-token `sk_t…` | `main` | No: same placeholder |
| S6 | `pipeline/secret-redaction.test.ts:29` | `0a93014` | curl-auth-header `0123…` | `fix/hosted-security` (#171) | No: digits-and-letters sequence for a redaction test |
| S7 | `pipeline/hosted-ops.test.ts:26` | `b001fb8` | private-key `----…` | PP5 branch | Assume valid as an RSA key; a test key not known to be registered anywhere |
| S8 | `pipeline/hosted-ops-logging.test.ts:12` | `b001fb8` | private-key `----…` | PP5 branch | Assume valid as an RSA key; same |
| S9 | `pipeline/hosted-ops.test.ts:119` | `b001fb8` | github-app-token `ghs_…` | PP5 branch | No: letters then a digit run, a synthetic token |
| S10 | `pipeline/hosted-ops.test.ts:132` | `b001fb8` | github-app-token `ghs_…` | PP5 branch | No: same synthetic token |
| S11 | `pipeline/hosted-ops-logging.test.ts:20` | `b001fb8` | github-app-token `ghs_…` | PP5 branch | No: synthetic |

**HEAD fix.** `.gitleaksignore` lists S1–S6 by gitleaks fingerprint (commit, file, rule, line; no values), so a future scan or CI step reports only new findings. With it, the full-history scan reports exactly S7–S11. S7–S11 are deliberately not ignored: see Requests.

### Account identifiers

| # | Value | Files | Introduced in | Where | Kind |
|---|---|---|---|---|---|
| I1 | `/Users/pier…` | 10 docs, plus `AGENTS.md`, `docs/READINESS.md`, `OVERNIGHT-AGENTS.md` | `fe7d095` (AGENTS.md), `f958954` (READINESS), `fb0143a` (OVERNIGHT), docs from `dac5eb3` on | `main` | Local username in example commands and evidence paths |
| I2 | `/Users/otab…` | 10 files under `.planning/phases/` | `2878f84`, `6b0f77b`, `a1c2362`, `29d3948`, `b377766` | History only (removed from `main`) | Local username in planning notes |
| I3 | `/Users/furq…` | `experiments/agent-baseline/agent-settings.json`, `…/refit-rules/typecheck.json` | `d23d7ed` | History only | Local username in agent settings |
| I4 | `refi….fly.dev` | `AGENTS.md` | `6411338` | `main` | The hosted worker's public hostname: an endpoint, not a credential |
| I5 | `pier…@gmail.com` | Author, committer and tagger of 576 / 484 / 23 entries | Since the first commit | Commit metadata, all refs | Personal email |
| I6 | `otab…@gmail.com` | Author and committer of 322 / 252 entries | Throughout | Commit metadata | Personal email |
| I7 | `furq…@gmail.com` | Author of 13 entries | Throughout | Commit metadata | Personal email |
| I8 | `oali…@uwaterloo.ca` | Author and committer of 1 entry | One commit | Commit metadata | University email |

No AWS account ID, Supabase project ref, bucket name, EC2 or network ID, Fly token, private IP or internal hostname appears in any blob, commit message, PR, issue or comment. The docs name these only as placeholders: `refit-benchmarks-<account>-<region>`, `refit_hosted.<project-ref>`. No personal email appears in file contents; the only email in `docs`, `data`, fixtures, `src` and examples is `pagination@example.com`.

**HEAD fix (I1).** The ten docs no lane owns now use `~/…`, with one exception: the JSON example in `docs/APP-ONBOARDING.md` uses `/home/you/…`, because Node does not expand `~` there. The shared docs are PP10's and `OVERNIGHT-AGENTS.md` is never edited by lanes, so those stay listed under Requests. I2, I3 and I5–I8 are history and need an owner decision.

### Private customer and third-party data

| # | What | Where | Assessment |
|---|---|---|---|
| D1 | Diffs of 17 public repositories, inside agent-generated patches. Mostly context lines, 13 to 715 lines each, 89 KB in total. | `docs/benchmarks/2026-10-21-agent-comparison-results.json` (`main`) | **13 of the 17 repositories declare no license**, so their code is all rights reserved, including the 715- and 328-line diffs. 3 are MIT. 1 is NOASSERTION. Publishing these is a licensing risk. |
| D2 | One source line per PayPal call site: 98 lines, at most 98 characters | `docs/benchmarks/2026-10-21-paypal-results.json` and similar `text` fields | Single-line excerpts from public code as benchmark evidence; low risk |
| D3 | Names of public repositories with verdicts such as `broken` and file and line references | Benchmark labels and results | Public repositories at pinned commits; no code beyond D1 and D2. Naming them is an owner choice. |
| D4 | `pierceluu10/refit-billing-demo` and `~/Repos/refit-stripe-lab` used as examples | `examples/local-service*.refit.json`, several docs | The demo repository is not visible to this account (HTTP 404), so a public reader cannot reproduce those examples |
| D5 | Waitlist schema and client (email signups) | `pre-launch-website` branch only | No signup data is in the repository. The client reads the Supabase URL and publishable key from build-time environment, not from code. |

`pipeline/fixtures` are hand-authored (see `pipeline/fixtures/README.md`), and `public/` holds Refit's own favicon and avatar.

### Vendored code and licenses

- Refit is MIT (`LICENSE`, © 2026 Pierce Luu). No file in `main` carries another license header or copyright notice. The one match was the Meta SDK class name `AudioCopyright` in `data/meta-business-sdk-edges.json`.
- `data/meta-business-sdk-edges.json` and `data/paypal-requests.json` are generated lists of names from SDK tarballs and specifications, not copied code.
- The `pre-launch-website` branch has 12 brand logos in `src/logos/`, attributed in its README:
  - Simple Icons (CC0);
  - Lobe Icons (MIT, notice included);
  - Devicon (MIT, notice included).

  The marks remain their owners' trademarks and are used only to name the APIs.
- `package.json` has no `license` field. That belongs to OP7, which audits the published tarball.

### Repository settings visible to the public

| # | Setting | Finding |
|---|---|---|
| R1 | Default branch | `pre-launch-website`, not `main`. Visitors and new clones land on the website branch. |
| R2 | Workflows | `ci.yml` runs on `pull_request` with `contents: read` and no secrets, so fork PRs get a read-only token. `deadlines-sync.yml` runs on a schedule only. Neither uses `pull_request_target`. Actions are pinned by tag, not SHA (OP7). |
| R3 | Actions secrets | Not verified: listing them needs admin access, which this account (WRITE) lacks. |
| R4 | Pull-request refs | `refs/pull/*` keep every PR's commits even after a branch is deleted or rewritten. Purging anything from history means publishing a fresh repository, not force-pushing this one. |

## `HEAD` hygiene

- **`.gitignore`.** It already covers `.env`, `.env.*` (except `.env.example`), `*.pem`, build output and `.impeccable/review/`. It now also covers:
  - `.claude/worktrees/` and `.claude/settings.local.json` (agent worktrees hold other branches; local settings hold personal paths);
  - `.planning/` (it was committed once with personal paths, I2);
  - `.npmrc` (registry tokens).

  On one machine, `.claude/worktrees/` and `.planning/` had been excluded only through that clone's `.git/info/exclude`, which other clones do not share.
- **`.env.example`.** It holds variable names, a model name and a budget default; credential variables are empty.
- **`examples/`.** No tokens, URLs with credentials or account IDs. Repository names are `pierceluu10/refit-billing-demo` (D4).
- **Docs.** No AWS account, bucket or Supabase ref in any doc: `docs/AWS-BENCHMARKS.md` and `docs/HOSTED-ONBOARDING.md` use `<account>` and `<project-ref>` placeholders.

## Needs owner decision

History rewrites and key rotations are listed here, never done.

1. **Personal emails in commit metadata (I5–I8).** Choose one:
   - **(a) Accept** them as public.
   - **(b) Publish a fresh repository** whose history is rewritten with a mailmap (for example `git filter-repo --mailmap`). Because of R4, rewriting this repository leaves the old commits reachable through `refs/pull/*`.

   Either way, each contributor should turn on GitHub's *Keep my email addresses private* and *Block command line pushes that expose my email*, and commit with their `users.noreply.github.com` address from now on.
2. **Unlicensed third-party code in D1.** Options:
   - replace each `diff` with its stats and a SHA-256 before publishing (keeps the comparison's numbers; loses the patches);
   - keep only the MIT repositories' diffs;
   - accept the risk.

   History keeps the diffs unless (1b) is chosen. I did not edit the file, because it is benchmark evidence other docs cite.
3. **History-only personal paths (I2, I3).** Low sensitivity (local usernames). Removing them also needs (1b).
4. **Default branch (R1).** Switch it to `main` before publishing, or decide the website branch is the front door.
5. **Hosted hostname (I4).** Publishing `refi….fly.dev` advertises the worker's endpoint. Every route except `/health` needs a signature or the service token (`docs/SECURITY.md` on #171), so this is a disclosure choice, not a vulnerability.
6. **Example repositories (D4).** Make `refit-billing-demo` public, or mark those examples as needing your own repository.

## Requests for other lanes

- **PP10.** Replace `/Users/pier…` in `AGENTS.md` (Stripe lab path) and `docs/READINESS.md` with `~/…`, as this PR does for the other docs. Fold the public-facing proposals below into `README.md` if accepted.
- **PP5.** Generate the test RSA keys at runtime (`generateKeyPairSync`), as `pipeline/hosted-security.test.ts` on #171 does, instead of committing PEM blocks (S7, S8). Build the fake `ghs_` tokens from parts so they don't match token scanners (S9–S11). Otherwise every public scanner and any gitleaks CI step will flag them.
- **OP7 / OG9.** A CI step that runs gitleaks pinned by digest with this `.gitleaksignore` would keep `main` clean after publishing. OP7 covers the supply-chain side; the job belongs in OG9's `ci*.yml`.

## Proposals for PP10 (not applied)

These are drafts for the shared files, which only PP10 edits. Text in angle brackets is for the owner to fill in; nothing here commits the project to a response time or a contact it does not have.

### `README.md`: a section for public visitors

Proposed after "Use it on your repository":

```markdown
## Project status

Refit is in early access. Releases are GitHub pre-releases (`vX.Y.Z`) with a packaged CLI and its checksums; there is no npm registry package yet. Stripe is the best-tested integration; [readiness](docs/READINESS.md) lists what each provider supports and what was verified. The hosted GitHub App currently serves a single allow-listed account.

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
```

The README's "See benchmarks on 781 real repositories" link should stay only if `docs/BENCHMARKS.md` still supports that count after the morning merge (OP10's claims checker).

### `CONTRIBUTING.md` (new, repository root)

```markdown
# Contributing to Refit

## Set up

Refit needs Node.js 22.12+ (or 24+) and npm. Docker is needed only for validation and the gated suites.

    npm ci
    npm run typecheck && npm run format:check && npm test && npm run build

All four must pass before a pull request is reviewed. CI runs them on Node 22 and 24.

## Gated suites

Docker, Postgres, oasdiff and real-SDK tests are skipped unless you opt in, for example `REFIT_DOCKER_IMAGE=node:22-alpine`, `REFIT_POSTGRES_URL=…`, `REFIT_OASDIFF=1`, `REFIT_STRIPE_SDK=1`. Say in your pull request which gated suites you ran; a skipped suite is not a passing one. These suites use simulated provider APIs; the live AI evaluations make paid model calls and are run only by maintainers.

## Changes we can accept

- Automatic edits stay limited to supported, evidence-backed migrations. Anything ambiguous (API versions, request or response semantics, webhook policies) must stop for review rather than guess.
- New deterministic rules come with tests on real code snippets that show behaviour is preserved.
- Never loosen an assertion, skip a test, raise a timeout or add a retry to make a test pass.
- Registry and catalog data (`data/deadlines.json`, `data/meta-graph-changes.json` and similar) take facts only from a provider page you read, recorded with `source` and `checkedAt`. Run the matching check script after editing.
- Recorded lockfile fixtures are byte-exact; list new ones in `.prettierignore` instead of reformatting them.
- Benchmark repositories are other people's code: never install or run them outside Refit's offline Docker sandbox.

## Commits and pull requests

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`). Keep pull requests focused, describe what changed and how you tested it (commands and counts), and list anything you could not verify. Maintainers merge; Refit itself never auto-merges.

## Secrets

Never commit credentials, `.env` files, private keys or account identifiers. Generate test keys at runtime. A secret scan runs against the full history <if the gitleaks CI step is adopted>.
```

### `SECURITY.md` (new, repository root)

```markdown
# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report privately through GitHub's private vulnerability reporting (the "Report a vulnerability" button on the Security tab) <or: email address the owner chooses>. Include the affected version or commit, how to reproduce, and the impact you expect.

<Owner: state a response window you can keep, for example "We aim to acknowledge reports within N business days.">

## Supported versions

Only the latest pre-release receives security fixes during early access.

## Scope

In scope: the `refit` CLI, the local service (`refit serve`), the hosted worker (`refit hosted serve`) and the Refit Agent GitHub App's use of its permissions. The hosted worker's threat model is in `docs/SECURITY.md`.

Out of scope: vulnerabilities in third-party repositories Refit analyses, in provider APIs, or in the user's own validation image; findings that need an already compromised maintainer account or database credentials.

## How Refit handles your code

In App mode, Refit runs a repository's checks only after an explicit approval of its configuration. Checks run in a Docker container with no network and no credentials; dependencies are installed beforehand from the public npm registry with lifecycle scripts disabled. It opens draft pull requests only when publishing is enabled, and never merges them. AI patches are opt-in and send the relevant source to the configured model provider.
```

Owner settings these drafts depend on: turn on private vulnerability reporting, or pick a contact address, before publishing `SECURITY.md`.

## Not verified

- Actions secret names (needs admin).
- Contents of release assets attached to the 25 tags; OP7 audits the packaged tarball.
- Workflow run logs, which become public with the repository.
- Whether `refit-billing-demo` exists but is private, or does not exist.
