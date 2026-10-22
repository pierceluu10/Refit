# Webhook lifecycle

How the hosted worker (`refit hosted serve`) handles each GitHub App event a real installation can send. Status (2026-10-22): every row below has a passing test against local PostgreSQL, with payloads built from GitHub's published webhook schemas. No real installation, rename or transfer has been exercised; see [what is not verified](#what-is-not-verified).

Tests live in `pipeline/hosted-lifecycle.test.ts` unless another file is named. They need a PostgreSQL URL and skip without one:

```bash
REFIT_POSTGRES_URL=postgres://refit:refit-local-test@127.0.0.1:55432/refit npx vitest run pipeline/hosted-lifecycle.test.ts pipeline/hosted-service.test.ts pipeline/github-webhooks.test.ts
```

## Which events reach the App

Sources: GitHub's [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) reference, read on 2026-10-22, and the payload schemas in [octokit/webhooks](https://github.com/octokit/webhooks/tree/aa80c24a3f55354465b8b1438d33dd5602956d0d/payload-schemas/api.github.com) at commit `aa80c24`.

| Event | How the App gets it | What GitHub says |
|---|---|---|
| `installation` | Always | "All GitHub Apps receive this event by default. You cannot manually subscribe to this event." |
| `installation_repositories` | Always | Same sentence as `installation`. |
| `github_app_authorization` | Always | "A GitHub App receives this webhook by default and cannot unsubscribe from this event." |
| `installation_target` | Not stated | Listed for GitHub Apps only: activity on "the user or organization account that a GitHub App is installed on". The reference does not say whether it is delivered by default. |
| `repository` | Only with a subscription | "To subscribe to this event, a GitHub App must have at least read-level access for the "Metadata" repository permission." Metadata read is granted automatically ([GitHub App setup](GITHUB-APP.md)), so only the subscription is missing. |
| `pull_request` | Subscribed today | Used by the local service's [agent suggestions](PROVIDER-AGENTS.md#suggestions-on-pull-requests); the hosted worker records and ignores it. |
| `ping` | When the webhook is created | Recorded and acknowledged. |

Before this change the hosted worker read only `installation` and `installation_repositories`. It refused any other action on those two events with HTTP 422, so GitHub recorded a failed delivery for every action GitHub adds later. It also let `new_permissions_accepted` or any `installation_repositories` delivery reactivate a suspended installation, and an `installation` event arriving after `deleted` revive a deleted one. An account rename was never recorded: the owner filter dropped deliveries under the new login, and the store would have refused them with 409 "Installation owner changed unexpectedly". Renamed repositories kept running under their old names, which GitHub answers with a redirect.

## Handling

| Event | Action | Handling | Test |
|---|---|---|---|
| `installation` | `created` | Records the installation and the repositories it lists, and enrolls those with a stored approval. Unapproved repositories are recorded and never run. | `enrolls the approved repositories an installation lists when it is created and records the rest` |
| `installation` | `deleted` | Marks the installation deleted and cancels every target and open job; a running job is aborted. Installation IDs are never reused, so any later delivery for that ID, including a `created` that arrives late, is answered `stale` and changes nothing. | `treats a deleted installation as final when its created delivery arrives late`; `hosted-service.test.ts`: `enrolls an approved repository on App installation, validates it in offline Docker, stores the receipt and cancels on uninstall` (needs Docker) |
| `installation` | `suspend` | Cancels every target. Repository changes delivered while suspended are recorded without enrolling anything. | `cancels every target on suspend, records repositories added while suspended without enrolling them, and resumes every approved repository on unsuspend` |
| `installation` | `unsuspend` | Resumes every installed repository that has an approval. | same test |
| `installation` | `new_permissions_accepted` | Records the repositories it lists and enrolls the approved ones when the installation is active. It never lifts a suspension. | `keeps a suspension in place when new permissions are accepted, and enrolls the listed repositories once active` |
| `installation_repositories` | `added` | Records each repository with its GitHub ID and enrolls the approved ones. | `enrolls an approved repository added to an installation and records an unapproved one without enrolling it` |
| `installation_repositories` | `removed` | Forgets the repository, cancels its targets and open jobs, and aborts a running job. | `cancels a removed repository’s targets and running job and forgets the repository`; `hosted-service.test.ts`: `leases jobs durably, stops a running job on repository removal and keeps its evidence as cancelled` |
| `repository` | `renamed` | Finds the stored repository by GitHub ID. Its row and approvals move to the new name; the approval is rebound to the new name over the same reviewed files. The old target is cancelled ("Repository renamed to …") and the new name enrolls. A rename already applied changes nothing; one whose previous name is not the stored name is refused with 409, so it can be redelivered after the earlier event. | `follows a renamed repository by its ID: the approval moves, the old target stops and the new name enrolls` |
| `repository` | `transferred` | GitHub sends this only to the new owner's installation. Every stored row with that GitHub ID in another installation is removed and its targets cancelled. The repository is recorded under the receiving installation only if this service already accepted that installation, and it enrolls only under an approval for its new name: an approval does not cross accounts. | `stops a repository transferred to another account and enrolls one transferred in only under an approval for its new name` |
| `repository` | `archived`, `unarchived` | Archiving cancels the repository's targets (the access check refuses archived repositories); unarchiving enrolls the approved ones again. | `stops an archived repository’s targets and resumes them when it is unarchived` |
| `repository` | `deleted` | "GitHub Apps and repository webhooks will not receive this event." Before every job the worker confirms access; a 404 cancels the repository's targets ("GitHub no longer serves …"). The repository and its approval stay recorded, so access granted again re-enrolls it. | `retires a target before its job when GitHub answers 404 for its repository` |
| (job start) | | If GitHub serves the name with a different repository ID than the installed one, the repository was deleted and re-created. Its targets are cancelled, its approvals are deleted and the new ID is recorded; it runs again only after a fresh approval. | `retires a target whose name now belongs to a different repository and requires a new approval` |
| `installation_target` | `renamed` | The account's login changed. If the stored login is the previous one, the installation's owner, every repository name, the approvals and the targets move to the new login, as for a repository rename. A rename already applied changes nothing; one from another login is refused with 409. | `follows an account rename: the login, repository names, approvals and targets move together` |
| `installation_target` | `renamed` (configured account) | `REFIT_HOSTED_OWNER` matches by login. A rename away from it is still accepted, and the worker logs "Account … is now …; set REFIT_HOSTED_OWNER=… to keep accepting its webhooks." Until the operator does, deliveries under the new login are ignored; enrolled targets keep running. | `accepts a rename away from the configured account over HTTP and tells the operator to update REFIT_HOSTED_OWNER` |
| any | out of order | `installation` events carry `installation.updated_at`. One older than the newest applied is answered `stale` and changes nothing. Equal times apply in arrival order. | `skips an installation event older than the newest one applied, so a late suspend cannot stop a resumed installation` |
| any | redelivered | GitHub keeps the delivery ID: "If you request a redelivery, the `X-GitHub-Delivery` header will be the same as in the original delivery" ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)). A stored ID with the same payload is answered `duplicate` and changes nothing, however late; the same ID with another payload is refused with 409. | `treats a redelivery hours later as a duplicate and prunes delivery IDs after 30 days`; `hosted-service.test.ts`: `leases jobs durably, …` (409) |
| any | retention | Delivery IDs older than 30 days are deleted on the next delivery. GitHub redelivers only "webhook deliveries that occurred in the past 3 days" ([redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)), so a pruned ID can never come back. | `treats a redelivery hours later as a duplicate and prunes delivery IDs after 30 days` |
| `installation`, `installation_repositories`, `installation_target`, `repository` | any other action | Acknowledged with 202 and ignored. | `acknowledges unknown events and actions with 202 and changes nothing` |
| `github_app_authorization`, `pull_request`, `push`, `issues`, anything else | any | Acknowledged with 202 and ignored. Refit uses no user-to-server tokens, so a revoked user authorization needs no action. | same test |
| any | malformed or oversized | 4xx and no state change: bad signature 401, bad JSON or UTF-8 400, wrong media type 415, body over 1 MiB 413, missing or invalid fields 422. | `refuses malformed and oversized webhooks with a 4xx and changes nothing`; `github-webhooks.test.ts`: `refuses every malformed lifecycle payload with a 4xx` |

The local `refit serve` shares the parser. It records repository and account events and does not act on them, because its targets come from a configuration file.

## What is not verified

- **No real installation.** Payloads follow the octokit schemas above. Field names were checked against them; GitHub's own behaviour was not observed.
- **Ordering by `installation.updated_at`.** GitHub's reference does not promise delivery order or say whether `updated_at` changes on every installation event. If it does not, equal times apply in arrival order, which is the old behaviour. `installation_repositories` deliveries are not ordered this way: an older delivery redelivered after a newer one would drop a repository added later. A repository removed from GitHub but left recorded by a late delivery is caught by the 404 check before its next job.
- **Switching an installation from all repositories to selected ones.** GitHub's reference says `repositories_removed` is empty in that case, so repositories that lost access stay recorded until their next job gets a 404.
- **Repositories created later in an installation with access to all repositories.** Nothing records them without the `repository` subscription (`created` is ignored today) or a listing of the installation's repositories.
- **Renames and transfers without the `repository` subscription.** GitHub answers the old name with a redirect, and `requestGitHub` refuses redirects, so each job fails with an error receipt until the subscription is added or the repository is removed and added again. The same happens after a transfer to an account that has not installed the App, which receives no event at all.
- **`installation_target` delivery.** Whether the App receives it by default is not documented (above).

## Needs owner decision

1. **Subscribe the App to Repository events.** It needs no new permission. Without it, renames, transfers and archiving are not followed. This is an App settings change; nobody has made it.
2. **Confirm `installation_target` is delivered.** After the next account rename, check the App's advanced delivery log, or subscribe to it if GitHub's settings offer it.
3. **Match accounts by ID, not login.** `REFIT_HOSTED_OWNER` (and any allowlist that replaces it) matches a login, so an account rename stops new enrollment until the operator updates it. Storing the account ID would survive renames.
4. **Approvals across accounts.** A repository transferred between two accounts that may both use Refit keeps its approval under the old name and needs a new one. Carrying it over is a policy choice.
5. **Following redirects by repository ID.** A job could resolve a moved repository through `GET /repositories/{id}` instead of failing on the redirect. That changes the access check every job uses.
