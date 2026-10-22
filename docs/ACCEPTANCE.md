# Acceptance test: a customer's install

`pipeline/customer-journey.test.ts` drives the hosted worker the way a customer's GitHub App install does, over real HTTP. It starts `runHostedService` on port 0 against PostgreSQL, sends signed webhook deliveries to it and reads `/status`, while a fake GitHub serves everything the worker asks GitHub for. The operator steps use the real CLI (`refit hosted approve`, `refit hosted retry`) against the same database.

## Run it

It needs a disposable PostgreSQL database and the validation image pulled locally. Each run creates and drops its own schema.

```bash
REFIT_TEST_DATABASE_URL=postgres://refit:refit-local-test@127.0.0.1:55432/refit REFIT_DOCKER_IMAGE=node:22-alpine npx vitest run pipeline/customer-journey.test.ts
```

`REFIT_POSTGRES_URL`, which the other hosted suites read, is accepted too. Without a database URL or `REFIT_DOCKER_IMAGE` the test is skipped, and the reporter shows the reason. No AI, npm registry, Stripe or GitHub request leaves the machine: validation runs in offline Docker, and the Stripe SDK in the fixture is simulated.

## The fake GitHub

[`pipeline/fixtures/fake-github.ts`](../pipeline/fixtures/fake-github.ts) is a local HTTP server. Refit's own GitHub code runs against it unchanged:

- **App identity.** It verifies the App's JWT with the App's public key and answers `GET /app` and `GET /repos/{repo}/installation`.
- **Installation tokens.** `POST /app/installations/{id}/access_tokens` issues a token scoped to one repository with the requested permissions. A token stops working when its repository leaves the installation or the App is uninstalled.
- **Repositories.** It serves repository metadata, branch refs, and issue, comment and collaborator-permission endpoints.
- **Git.** Each repository is a local bare remote served by `git http-backend`. It serves fetches only, and only with a valid token for that repository.
- **Records.** It records every request, every write and every Git fetch, so tests can assert what Refit never did.
- **Webhooks.** Customer actions (`install`, `changeRepositories`, `uninstall`, `redeliver`) change what it serves, then deliver the webhook GitHub would send, signed with the webhook secret.

Tests route Refit's `api.github.com` requests to it with `vi.stubGlobal('fetch', github.fetch)`. Managed checkouts' `git fetch origin` goes to it through `throughFakeGitHub` in [`fake-github-git.ts`](../pipeline/fixtures/fake-github-git.ts), with the same token header git would send to github.com. Checkouts keep their `https://github.com` remote, so Refit's remote checks still run. `pipeline/customer-journey-github.test.ts` runs in the default suite and checks the fake itself against Refit's real App authentication, access check and managed checkout.

The repository the customer installs on is [`pipeline/fixtures/customer-journey`](../pipeline/fixtures/customer-journey/README.md): Stripe code that reads `PaymentIntent.charges`, the contract that removes it, and a simulated Stripe SDK so validation needs no `npm install`.

## Steps

| Step          | What happens                                                                                            | What it proves                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Approve       | The operator inspects the customer's `.refit.json` and stores the approval with `refit hosted approve`. | The CLI and the worker share the approval record.                                                  |
| 1. Install    | The customer installs the App on an approved and an unapproved repository (`installation.created`).     | The delivery is verified and accepted, and only the approved repository is enrolled.               |
| 2. Enroll     | `/status` lists one target. Both repositories get a read-only inventory.                                | Installing never runs anything in an unapproved repository.                                        |
| 3. Doctor     | The job runs `refit doctor` on a fresh App checkout.                                                    | The worker reads the repository only with a scoped installation token, through Git over HTTP.      |
| 4. Scan       | The job finds the `PaymentIntent.charges` removal and proposes Refit's deterministic patch.             | A real Stripe migration rule runs on the hosted path.                                              |
| 5. Validate   | The baseline and patched checks run in offline Docker and both pass.                                    | Validation is isolated and offline.                                                                |
| 6. Receipt    | The job finishes with a `validated` receipt whose evidence passes `verifyArtifacts`.                    | The receipt is complete and its evidence is intact.                                                |
| 7. No writes  | The fake recorded no write other than token requests.                                                   | Refit opened no issue or pull request and pushed nothing.                                          |
| 8. Duplicate  | The install delivery is redelivered with the same delivery ID.                                          | It is answered `duplicate`, and no job is added.                                                   |
| 9. Remove     | The customer removes the approved repository (`installation_repositories.removed`).                     | Its target is cancelled.                                                                           |
| 10. Reinstall | The customer uninstalls, then installs again under a new installation ID.                               | The approved repository enrolls again under the new installation and gets a new receipt.           |
| 11. Uninstall | The customer uninstalls (`installation.deleted`).                                                       | The target is cancelled, nothing stays queued or running, and Refit requests no further App token. |

The worker runs with an hour-long polling interval, so every job in the journey comes from a webhook, not from a scheduled poll.

## A killed worker and an operator retry

A second test starts from the same approval and installs only the approved repository.

| Step       | What happens                                                                                                                                                            | What it proves                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Kill    | A worker in its own process (`pipeline/fixtures/fake-github-worker.ts`, 5-second lease) takes the install's job and is killed with `SIGKILL` once the migration starts. | A worker that dies stops renewing its lease and leaves its job `running`.                                                             |
| 2. Reclaim | After the lease lapses, a second worker sharing the state directory, as a restarted machine keeps its volume, reclaims the job.                                         | The job's second attempt finishes as `interrupted`: the killed run left no evidence, and Refit does not run the checks again unasked. |
| 3. Retry   | The operator runs `refit hosted retry --target <id>`. A restarted worker takes the retry at once, as a running one does at its next poll.                               | The retry validates the same revision in offline Docker, with intact evidence and no GitHub writes.                                   |

The killed worker reaches the fake GitHub through the same `fetch` and `git fetch` routing as the in-process tests. The interrupted run stands in for a failed validation: both are failed jobs that stay failed until the operator retries them.

## Status

Written on 2026-10-22 but not yet run: Docker Desktop's backend was hung and the local PostgreSQL container unreachable while it was written. The fake GitHub's own test, `pipeline/customer-journey-github.test.ts`, runs in the default suite and passes.

## Not covered

- Real GitHub: deliveries, rate limits, redirects for renamed repositories and permission prompts.
- Real Stripe or npm. The contracts are small projections, and the SDK is simulated.
- Fly.io, Supabase, AI patches, draft publication and approval issues (`REFIT_HOSTED_APPROVAL_ISSUES`), which the journey leaves off.
