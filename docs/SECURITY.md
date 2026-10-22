# Hosted worker security

This is the threat model for the hosted worker (`refit hosted serve`, `pipeline/hosted-*.ts`). Each threat ends in one of these states:

- **Fixed**: a regression test that failed before the fix.
- **Mitigated**: existing controls, with the tests that pin them.
- **Accepted**: a stated reason.
- **Owner action**: only the owner can do the change.

Reviewed on 2026-10-22 against `main` at `fb0143a`. Nothing here was tested against the live Fly app or the Supabase database: every result comes from code reading and local tests.

## What is protected

| Asset | Where it lives | Who may use it |
|---|---|---|
| GitHub App private key | Fly secret `GITHUB_APP_PRIVATE_KEY`, written to `/run/refit/app.pem` (mode 0600) at boot | The worker, to mint per-repository installation tokens |
| Installation tokens | Process memory for one job step; Git gets them through `GIT_CONFIG_*` environment, never arguments or files | Git fetch and GitHub API calls for one repository |
| `REFIT_WEBHOOK_SECRET` | Fly secret, process environment | Webhook signature checks |
| `REFIT_SERVICE_TOKEN` | Fly secret, process environment | `/status` callers |
| `REFIT_DATABASE_URL` | Fly secret, process environment | The `refit_hosted` role, which owns the `refit_*` tables |
| `OPENAI_API_KEY` | Fly secret, process environment | AI patches, behind a per-installation budget ledger |
| Approvals, targets, jobs, receipts | Postgres (`refit_*`, row-level security on with no policies) | The worker; operators through `refit hosted approve` and `retry` |
| Customer code and evidence | `/data/state/targets/<id>` on the Fly volume | The worker and the offline validation container |

## Trust boundaries

1. **Internet → `/github/webhook`.** Anyone can send a request. Only bodies signed with the webhook secret are parsed.
2. **Internet → `/status`.** Anyone can connect. Only the service token reads state. `/health` says only `listening`.
3. **Customer repository → worker.** Its `.refit.json`, sources, tests and lockfiles are hostile input. Approval covers the configuration files, never the code.
4. **Worker → validation container.** The repository's checks run in Docker with no network. OG3 owns the sandbox audit (`docs/SANDBOX.md`); this review covers only what crosses into and out of the container.
5. **Worker → GitHub, OpenAI and Postgres.** These are outbound TLS connections to fixed hosts. The Postgres connection is the exception; see T12.

## Summary

| ID | Threat | Status | Evidence |
|---|---|---|---|
| T1 | Webhook forgery | Mitigated | `github-webhooks.test.ts` (tampering, GitHub test vector); `token-comparison.test.ts` |
| T2 | Webhook replay under a new delivery GUID | **Fixed** | `hosted-security.test.ts`: refuses a signed payload replayed under a new delivery GUID |
| T3 | Delivery GUID reuse with another payload | Mitigated | `hosted-service.test.ts` (409 on reuse); `hosted-security.test.ts` (redelivery is a duplicate) |
| T4 | Installation, account and owner spoofing | Mitigated; login reuse Accepted | `github-webhooks.test.ts` (foreign Apps and owners); `github-app.test.ts` (owner, suspended, permissions) |
| T5 | Approval tampering | Mitigated | `repository-enrollment.test.ts` (tampered receipts, changed inputs, path and link escapes) |
| T6 | Hostile repository: escape, exfiltration, resource exhaustion | Mitigated for this review; sandbox detail is OG3's | `npm-dependencies.test.ts`, `yarn-preparation.test.ts`, `validation.test.ts` (gated) |
| T7 | Lease theft | Mitigated; worker-ID collision Accepted | `hosted-service.test.ts` (expired leases, stale renew and finish refused) |
| T8 | SQL injection | Mitigated | `hosted-security.test.ts`: stores hostile text verbatim |
| T9 | Secret exposure in logs, receipts, evidence and errors | **Fixed** (outputs had no redaction) | `hosted-security.test.ts`, `secret-redaction.test.ts`, `github-checkout.test.ts`, `hosted-service.test.ts` (gated evidence scan) |
| T10 | Status token handling and timing | **Fixed** (length leak) | `token-comparison.test.ts`; `hosted-security.test.ts` (`/status` refusals) |
| T11 | SSRF through configured URLs | Mitigated in hosted mode; operator URLs Accepted | `workflow-configuration.ts` key allowlist; `npm-dependencies.test.ts` (`.npmrc` registry ignored) |
| T12 | Database TLS without certificate verification | **Owner action** | `docs/HOSTED-ONBOARDING.md` URL; `pg-connection-string` 2.14.1 source |
| T13 | GitHub App private key lifetime on disk | Accepted, with a request | `scripts/hosted-entrypoint.sh` |

## T1. Webhook forgery

`verifyWebhook` checks `X-Hub-Signature-256` before the body is parsed or stored. GitHub computes the HMAC-SHA256 of the raw request body ([GitHub: webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), read 2026-10-22).

- **Format first.** The header must match `sha256=` plus exactly 64 hex digits. Other lengths and algorithms are refused by that format check, before any secret material is compared.
- **Constant time.** `timingSafeEqual` compares the two 32-byte digests.
- **Exact bytes.** Signature checks run on the raw bytes, before decoding. Strict UTF-8 decoding and a 1 MiB body cap follow.

Tests:
- `github-webhooks.test.ts` checks tampering, missing signatures and GitHub's published test vector.
- `token-comparison.test.ts` checks that a well-formed wrong signature reaches `timingSafeEqual` and a malformed one is refused before it.

## T2. Webhook replay under a new delivery GUID (Fixed)

**Finding.** The HMAC covers the body but not the `X-GitHub-Delivery` header. Delivery IDs deduplicated only the GUID. So anyone holding one signed body could re-send it with a fresh random GUID, and the worker would act on it again. Such a body could come from a proxy log, a captured request or a debugging paste. Examples:
- a replayed `installation_repositories` *removed* or `installation` *deleted* cancels targets and stops running jobs, at will;
- a replayed *added* or *created* re-enrolls a removed repository and queues a job.

The job-time API check (`confirmRepositoryAccess`) stops a replayed install from running code without real access. The cancellations, however, take effect immediately.

**Fix.** `hosted-store.ts` now refuses a body whose SHA-256 was already accepted under a different GUID, with 409 *"already accepted under another delivery GUID; refusing a replay"*. GitHub's own redelivery reuses the original GUID ("If you request a redelivery, the `X-GitHub-Delivery` header will be the same as in the original delivery", [GitHub: best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), read 2026-10-22). A redelivery therefore still answers `duplicate`. A new index on `refit_deliveries (hash)` keeps the lookup cheap.

**Test.** `hosted-security.test.ts` runs the flow over HTTP against Postgres: add, then remove, then replay the *added* body under a new GUID. The replay gets 409 and the target stays cancelled. A same-GUID redelivery returns `duplicate`, and a genuinely new event for the same repository is still accepted. It failed before the fix (202 instead of 409).

**Residual risks.**
- **Identical events.** Two distinct GitHub events with byte-identical bodies would be refused as a replay. Payloads carry the sender and installation timestamps, so this is unlikely. GitHub records the refusal, and the owner can redeliver.
- **Pruning.** Replay protection lasts only as long as `refit_deliveries` keeps the hash (see Requests).
- **Local service.** `refit serve` (`service-state.ts`) has the same GUID-only deduplication. There, every installation change is held as `waiting for API confirmation` until the API confirms it, and the service binds `127.0.0.1`, so it is listed rather than changed here.

## T3. Delivery GUID reuse

The same GUID with a different body or event is refused with 409 (*"This delivery GUID already belongs to another payload"*). The same GUID with the same body is a `duplicate` and changes nothing. GUIDs must be UUID-shaped and are stored lowercased. Both cases are covered in `hosted-service.test.ts` and `hosted-security.test.ts`.

## T4. Installation, account and owner spoofing

Controls:
- Only signed webhooks are parsed. `installation.app_id` must equal this App's ID.
- Every repository in the payload must belong to `installation.account.login`. Duplicate names, and a repository both added and removed in one delivery, are refused.
- A delivery whose account is not `REFIT_HOSTED_OWNER` is answered `ignored` and stored nowhere.
- An installation ID whose stored owner changes is refused (409).
- **At job time** the worker re-checks through the GitHub API before any work. The App identity must match its ID. The installation must be unsuspended and owned by the repository's owner. The repository must be readable, not archived and not disabled. Its installation ID must equal the target's. The token must be scoped to that one repository with exactly the requested permissions.

Tests: `github-webhooks.test.ts` (foreign Apps and owners), `github-app.test.ts` (app, owner, suspended, permissions, expired, repository, bot).

**Accepted: login reuse.** The owner check compares the account *login*, which GitHub frees when an account is renamed. If the owner account were renamed and someone registered the old login, their installation would pass the webhook owner check. A repository they create still needs a stored approval for its exact name, base and configuration-file hashes. Those files can be copied from a public repository, though, and approval does not cover code. Two things limit the damage:
- their code still runs only in the offline sandbox;
- drafts would open on their own repository.

The cost to the owner is worker time and up to that installation's AI budget. Renaming the owner account is itself an owner action, so this stays accepted until PG10 replaces the owner check. See Requests: the allowlist should key on the numeric account ID.

## T5. Approval tampering

Approvals enter only through `refit hosted approve`, which needs the database credentials.

**Receipt validation.** `readRepositoryApproval` checks:
- the exact key set;
- the lowercase repository;
- a 64-hex fingerprint and a 40-hex reviewed revision;
- each file's role, path, hash and size;
- that the fingerprint equals the hash of the file evidence.

**At job time.** `loadApprovedRepository` recomputes the fingerprint from the fresh checkout's committed files. Any change becomes a `needs-review` receipt and nothing runs. `claim` only takes a job whose target fingerprint equals the stored approval's. Approved inputs are cached outside the checkout and verified byte for byte.

Tests: `repository-enrollment.test.ts`: tampered identity and evidence, changed inputs, parent paths, `.git`, escaping symlinks, cache tampering.

**Accepted.**
- `--approved-by` is free text recorded for audit. Anyone with the database credentials can already write any row.
- Approval deliberately covers configuration, not application code: the code is what gets validated, in the sandbox.

## T6. A hostile repository (`.refit.json`, tests, dependencies)

**Configuration.** `.refit.json` accepts a fixed key set with no URLs, credentials, AI or publication options. It cannot name another repository. Its `image` must already exist locally: `docker run --pull never`, and the hosted entrypoint pulls only the operator's `REFIT_HOSTED_IMAGES`. Check commands are validated arrays.

**Host-side reads.**
- The managed checkout is a depth-1 fetch with hooks, fsmonitor, submodules, redirects and every non-HTTPS protocol disabled, under a clean Git environment.
- The scanner skips symbolic links.
- Committed-file reads are bounded.
- `refit doctor` refuses symlinks that resolve outside the repository.

**Dependency preparation.**
- Only manifests and lockfiles enter the container. A committed `.npmrc` contributes only `legacy-peer-deps`, and `.yarnrc.yml` is limited to `nodeLinker` and `enableTelemetry`.
- The registry is pinned to `https://registry.npmjs.org`, lifecycle scripts are off and every package needs an integrity hash.

**Validation.** It runs with `--network none` as user 65534, with all capabilities dropped, `no-new-privileges`, a read-only root, size-capped tmpfs, 128 pids, a memory and CPU cap, timeouts and capped output. No environment variable except `CI=true` is passed in, and no host secret is mounted.

**Exfiltration.** With no network during validation, the remaining channel is the evidence and the draft PR. Both carry only the repository's own output, on its own repository.

**Resource exhaustion.** Per-step timeouts, output and archive caps and container limits bound one job. Jobs run one at a time, so one approved repository can delay the others but not starve the worker indefinitely.

**Accepted.**
- Checkouts and evidence accumulate on the 20 GB volume. Retention belongs to PP7.
- Docker and `oasdiff` child processes inherit the worker's environment, which includes the Fly secrets. Neither forwards it into a container, but a clean environment would be defence in depth (see Requests).

OG3 owns the full flag audit and the hostile-fixture tests.

## T7. Lease theft

**Controls.**
- Leases live in Postgres, and only the database role can change them.
- `renew` and `finish` succeed only for the current `lease_owner` of a running job. Once a lease expires and another worker reclaims the job, the first worker's renewal fails and aborts its run, and its receipt is refused.
- A job reclaimed three times is failed and needs an explicit retry.

Tests: `hosted-service.test.ts`.

**Accepted: worker-ID collision.** The default worker ID is `<hostname>:<pid>`. Fencing depends on it being unique among live workers. Fly gives each Machine its own hostname. A restarted process on the same Machine reuses PID 1, but its predecessor is dead and its leases simply expire. Two live workers would collide only if an operator ran them with the same hostname and PID, for example two containers with a fixed `--hostname`.

## T8. SQL injection

Every value reaches Postgres as a bound parameter. The only interpolated SQL is the internal `cancel` filter, whose text is a constant in `hosted-store.ts`. Webhook repository names and logins are format-checked before storage, as defence in depth.

`hosted-security.test.ts` stores an approval, delivery body, worker name and receipt containing `'); DROP TABLE` and confirms each is stored verbatim with the tables intact.

## T9. Secret exposure in logs, receipts, evidence and error messages (Fixed)

**Finding.** Hosted progress logs, stored receipts and webhook error responses copied raw error messages from any depth: `${error.name}: ${error.message}`. Receipts are served by `/status`. Only Git applied redaction, for the installation token. The review found no current path that embeds a credential:
- GitHub, OpenAI and authentication errors keep only the method, path and status;
- `pg` errors name the user and host but not the password.

Even so, nothing stopped a future or third-party error from being stored and served.

**Fix.** `pipeline/secret-redaction.ts` removes the worker's own secrets wherever they appear: the webhook secret, the service token, the OpenAI key and the database password (raw and URL-decoded), plus their base64 forms. It also removes known credential shapes it was never given:
- GitHub tokens (`ghs_` and other prefixes, `github_pat_`);
- OpenAI keys;
- PEM private keys, including truncated ones;
- `Authorization` header values and long `Bearer` tokens;
- passwords in Postgres URLs.

`runHostedService` applies it to every progress line, both receipt paths (finished and failed), lease-renewal and storage failures, and 4xx error responses. 5xx responses were already generic.

**Tests.**
- `hosted-security.test.ts` runs the service against Postgres. It feeds the webhook secret, the service token, an OpenAI key, a `ghs_` token, an RSA private key, the database password, a Postgres URL and a Basic credential through:
  - job progress;
  - a failing job;
  - a finished job's report reason;
  - a lease-renewal failure;
  - a storage failure on webhook intake;
  - malformed signed JSON.

  It then checks that none of them, nor their base64 forms, appear in the progress log, `/status`, the stored receipts, the HTTP responses or any file under the state directory. It also checks that each message still says what happened. It failed before the fix.
- `github-checkout.test.ts` makes Git print the installation token and its Basic credential and checks that both are redacted (this path had no test).
- The gated end-to-end test in `hosted-service.test.ts` now scans every file the worker kept: evidence, managed checkouts, approved-input cache and receipts. It checks for the webhook secret, the service token and the installation token. It needs Docker and `oasdiff`; see the PR for whether it ran.

**Accepted.**
- The `pg` connection errors written to the private Fly log name the Supabase pooler user, which includes the project ref. Logs are operator-only, and the ref is an identifier, not a credential.
- `refit serve` (local) keeps its own unredacted outputs. It binds `127.0.0.1` and is out of this hosted scope.

## T10. Status token handling and timing (Fixed)

**Finding.** `authorized()` compared tokens with `timingSafeEqual` only after a length check that returned early, so response timing told a caller whether a guess had the right length.

**Fix.** Both sides are hashed with SHA-256 first, so the comparison always runs on 32 bytes.

**Tests.**
- `token-comparison.test.ts` asserts the comparison runs for equal, shorter, longer, empty and repeated tokens. It failed before the fix: zero comparisons on a length mismatch.
- `hosted-security.test.ts` checks over HTTP that a missing token, the bare token, `Basic`, a token one character short or long, and the webhook secret all get the same 401 body. It also checks that a token in the query string is not accepted.

**Unchanged controls.**
- The service token and the webhook secret must be 32–256 characters from a restricted set, and must differ.
- The token travels only in the `Authorization` header. Fly forces HTTPS.

**Accepted.** `/status` has no rate limit. With 32 or more random characters, guessing is not practical.

## T11. SSRF through configured URLs

In hosted mode no repository-controlled value becomes a URL:
- `.refit.json` has no URL fields;
- the worker passes `documentationSources: []`;
- contracts come from committed files or `latestStripe`, which reads fixed `api.github.com` and `raw.githubusercontent.com` paths;
- GitHub and OpenAI hosts are constants, and every `fetch` uses `redirect: 'error'`;
- package managers ignore repository registry settings (T6).

**Accepted.** `refit serve` and `refit watch` take OpenAPI and documentation URLs from the operator's own configuration. They require HTTPS without credentials, query strings or fragments, but they do not reject private or link-local addresses. That configuration is operator-written, so it is trusted. The Slack webhook URL is pinned to `https://hooks.slack.com/services/`. If those options ever become repository- or customer-controlled, they need a public-address check.

## T12. Database TLS without certificate verification (Owner action)

`docs/HOSTED-ONBOARDING.md` documents `REFIT_DATABASE_URL` with `?uselibpqcompat=true&sslmode=require`. In `pg-connection-string` 2.14.1 (the installed version), libpq compatibility turns `sslmode=require` without `sslrootcert` into `ssl.rejectUnauthorized = false`. The connection is encrypted, but the server certificate is not checked.

An attacker on the network path between Fly and the Supabase pooler could impersonate the database. They would see every approval, receipt and installation, and could tamper with approvals. That would let them enroll repositories the owner never approved.

**Owner action.** Download the project's CA certificate from the Supabase dashboard and ship it with the worker (image or Fly secret). Then switch the URL to `sslmode=verify-full&sslrootcert=<path>`, keeping libpq compatibility. This review could not test that change against the live pooler.

## T13. GitHub App private key lifetime on disk

**Current behaviour.**
- `scripts/hosted-entrypoint.sh` writes the key to `/run/refit/app.pem` with `umask 077`, exports only the file path and unsets `GITHUB_APP_PRIVATE_KEY` before `exec`, so the worker's environment never holds the key.
- `github-app.ts` reads the file, capped at 64 KiB, each time it mints a JWT.
- The file stays for the life of the Machine. It is never mounted into a container, and Git and Docker never see it.

**Accepted.** The only reader besides the worker would be a container escape (T6, OG3). It is not verified whether `/run` is a tmpfs on a Fly Machine. If it is not, the key also persists on the Machine's root filesystem until the Machine is replaced; the `/data` volume is not affected.

**Request.** Load the key once into a `KeyObject` at start-up and delete the file, so a later escape finds nothing on disk (see Requests).

## Requirements for PG2 (approval from GitHub) and PG3 (job machines)

These two lanes add new trust boundaries. Each requirement below names the threat it answers and should ship with a test that fails without it.

### PG2: `/refit approve` from an issue comment

1. **Who may approve.** Before acting, check the commenter's repository permission through the API. It must be `admin` or `maintain`, never `write`. Use the comment's `user.id`, never a login typed in the comment body, and never cache a permission across comments. Answers T4.
2. **What is approved.** The prefix must match the fingerprint recomputed from the default branch's committed files *at the moment the comment is processed*, not the one in the issue body. A config change after the issue was opened makes the old prefix stale. Require at least 12 hex characters and refuse an ambiguous match. Answers T5.
3. **Which repository.** Act only on `issue_comment` deliveries whose `repository.full_name` and `installation.id` match an installed, allowed repository. Act only on the marker issue Refit opened itself, identified by issue number stored in Postgres, never by title or label. Refuse comments on pull requests (`issue.pull_request` present). Answers T4.
4. **Only new comments.** Accept only `action: created`. Edited and deleted comments are refused with a reply. A comment edited after Refit acted must not re-trigger. Answers T2 and T3.
5. **Replay.** Store the comment ID with the resulting approval, and refuse a second approval from the same comment ID. Deduplication on the delivery GUID and the body hash (T2) still applies. Answers T2.
6. **Bots and the App itself.** Ignore comments from any `Bot` account, including Refit Agent, so a reply quoting a command cannot approve. Answers T4.
7. **Replies leak nothing.** Refusal replies say why ("stale fingerprint", "needs admin or maintain"). They never include tokens, internal paths, stack traces or another repository's name. Route them through `secretRedactor`. Answers T9.
8. **Minimum permissions.** Issue writes use a token scoped to the one repository with `issues: write` and `contents: read` only, as `authenticateGitHubIssues` already does. The new `issues` and `issue_comment` events and the Issues permission are Needs owner decision. Answers T4.
9. **Revocation.** `/refit revoke` follows the same permission, issue and fingerprint rules. It must cancel running jobs the same way repository removal does (T7).

### PG3: one Fly Machine per job

1. **No standing secrets on the job machine.** It receives no database URL, App private key, webhook secret or service token. That is the point of the lane. Assert it on the exact Machines API create request, including `env`, `files` and `init.cmd`. Answers T9 and T13.
2. **Repository access.** A job machine gets at most a short-lived installation token scoped to its one repository with `contents: read`, or better, the checkout itself and no token. Never the App key. Answers T4.
3. **Authenticated return channel.** Receipts and evidence come back with a per-job secret generated by the control process. Check it in constant time (hash first, as `authorized()` does) and bind it to the job ID and lease. A receipt for another job, after the lease ended, or with a reused secret is refused. Answers T7 and T10.
4. **Untrusted results.** Receipts and evidence from a job machine are attacker-influenced data. Cap their size before reading (the lane specifies an evidence cap), validate the receipt schema strictly and pass messages through `secretRedactor` before storage. Never let a job machine choose its evidence path. Answers T6 and T9.
5. **No inbound reach.** Job machines should not be able to call the control process's `/status` or webhook routes, or Postgres. Use a separate Fly app or network policy, and no shared 6PN service ports. Document whatever Fly allows, and record what it cannot enforce as accepted. Answers T6.
6. **Teardown.** Destroy on finish, failure, cancel, timeout and control-process crash (the reaper). A machine that outlives its lease must not be able to submit a receipt (point 3). Answers T7.
7. **Machines API token.** The control process's Fly token must be scoped to the job app only. A deploy token for the worker app could redeploy the control process. Never log it; add its shape to `secretRedactor` if Fly tokens appear in errors. Answers T9.
8. **Isolation claim.** Only after 1–7 hold may the docs claim per-job isolation, and only then is lifting the single-owner restriction an owner decision with evidence.

## Requests for other lanes

- **PG10 (tenancy).**
  - Key `REFIT_HOSTED_ACCOUNTS` on the numeric account ID, or record the ID the first time a login is seen and refuse a later installation whose ID differs. This closes the login-reuse case in T4.
  - My changes touch `hosted-store.ts` (`accept`: the replay check) and `hosted-service.ts` (redaction at the outputs). Keep both when merging.
- **PP7 (store and retention).**
  - Keep `refit_deliveries.hash` for as long as any signed body could be replayed: forever, or prune only rows older than GitHub's redelivery window *and* keep their hashes. Pruning hashes reopens T2 for pruned payloads.
  - Fold `refit_deliveries_hash` into your migrations.
- **Pierce (hosted entrypoint, `github-app.ts`, onboarding doc).**
  - T12: switch `REFIT_DATABASE_URL` to `sslmode=verify-full` with the Supabase CA certificate.
  - T13: load the App key once into a `KeyObject` and delete `/run/refit/app.pem` after start-up.
- **OG3 (sandbox).** Spawn `docker` (and `oasdiff`) with a minimal environment rather than the worker's full one (T6). Nothing forwards it today, but it holds every Fly secret.

## Running the security tests

```sh
docker run -d --name refit-hosted-pg -e POSTGRES_USER=refit -e POSTGRES_PASSWORD=refit-local-test \
  -e POSTGRES_DB=refit -p 127.0.0.1:55432:5432 postgres:17-alpine
REFIT_POSTGRES_URL=postgres://refit:refit-local-test@127.0.0.1:55432/refit \
  npx vitest run pipeline/hosted-security.test.ts pipeline/token-comparison.test.ts \
  pipeline/secret-redaction.test.ts pipeline/github-checkout.test.ts --maxWorkers=2
```

Without `REFIT_POSTGRES_URL`, the Postgres tests are skipped and the others still run. The end-to-end evidence scan also needs `REFIT_DOCKER_IMAGE=node:22-alpine` and `REFIT_OASDIFF=1` (`pipeline/hosted-service.test.ts`).
