# Hosted deadline monitoring

With `REFIT_HOSTED_ALERTS=1`, the hosted worker (`refit hosted serve`) watches every repository it has an [inventory](INVENTORY.md) for, approved or not, and alerts it before a registry deadline the way `refit serve --deadline-alerts` does for enrolled repositories (see [API deadlines](DEADLINES.md#alerts-from-the-service)). It is off by default. Alerts are advice: they never change code, enroll a repository or start a migration.

## What it does

Each worker pass (on a webhook that wakes it, or every `--interval` seconds, 300 by default):

1. **Re-scan triggers.** It queues a new inventory for a repository when one of these is pending and its last re-scan was at least 10 minutes ago:
   - a push to the repository's default branch (`push` webhook; see [Needs owner decision](#needs-owner-decision)),
   - a deadline registry that differs from the one the stored inventory was matched against,
   - 24 hours since the last re-scan.

   A repository is first seen when its inventory exists; its clock starts then. The inventory itself works as described in [repository inventory](INVENTORY.md): an unchanged commit and registry is checked, not fetched or scanned again. A push that arrives while an inventory is queued or running asks for one more once it is done.

2. **Alerts.** For every complete inventory of an allowed, active installation, it takes the stored deadline exposures and counts the days left again from today, without a checkout. A deadline reaches a stage at 90, 30 and 7 days before its date and again on the date. When a deadline reaches a tighter stage than the last one sent for that repository, Refit opens one GitHub issue for the repository and deadline, or updates the one it opened before (new title and body, plus a comment so watchers are notified). Crossing several stages between passes sends one alert at the tightest. A closed issue stays closed. The issue text is the same as the local service's.

Only live evidence counts: model names in tests, comments, catalogs and tokenizer calls never open an alert.

## Ignores

The committed `.refit-deadlines-ignore.json` (see [API deadlines](DEADLINES.md)) is read when the inventory is taken. Active entries that cover every piece of live evidence silence that deadline; expired entries do not. An invalid file accepts nothing, so a broken exception can never silence an alert. A changed ignore file takes effect at the next re-scan (push or 24 hours).

## Exactly one alert per stage

Before writing to GitHub, a worker takes the stage in PostgreSQL (`refit_deadline_alerts`): the row moves to the new stage only if its stored stage is wider. Another worker, or the same worker after a restart, finds the stage taken and sends nothing. A write that fails is recorded as `failed` and is not retried until the next stage, as locally. A worker that stops mid-write leaves the row `sending`; Refit does not send that stage again, so an interrupted alert can be missed but is never sent twice. If GitHub refuses the issue token (for example, the Issues permission is missing), nothing is taken and the next pass tries again.

## Removal and uninstall

Monitoring rows and alert state belong to the installed repository. Removing the repository from the installation or uninstalling the App deletes them, together with the inventory, and nothing is sent for it afterwards. Issues already opened stay in the repository. Installing it again starts with no alert state, so the current stage is alerted again in a new issue.

## What it stores

PostgreSQL tables created by `pipeline/monitoring-store.ts`, both deleted with the installed repository:

| Table                   | Columns                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refit_monitoring`      | `installation_id`, `repository`, `pushed` (a default-branch push not yet re-scanned), `rescanned_at` (last re-scan Refit asked for, or when monitoring first saw the repository). |
| `refit_deadline_alerts` | `installation_id`, `repository`, `deadline`, `stage` (90, 30, 7 or 0), `issue`, `status` (`sending`, `opened`, `updated` or `failed`), `message` (the failure), `sent_at`.        |

`GET /status` adds `monitoring`: whether alerts are on, and for each installation its exposed deadlines across repositories, soonest first (at most 50, with `more` counting the rest): repository, deadline, date, days left, whether an ignore accepts it, and the last alert's stage, issue and status. It is listed even when alerts are off, from the stored inventories.

## Configuration

| Setting                   | Effect                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `REFIT_HOSTED_ALERTS=1`   | Turns re-scans and alerts on with lead times of 90, 30 and 7 days. `0` or unset leaves them off. |
| Issues: Read and write    | GitHub App permission the alerts need.                                                           |
| `push` event subscription | Lets a default-branch push trigger a re-scan. Without it, new commits are found within 24 hours. |

## Needs owner decision

- **Enable alerts.** Setting `REFIT_HOSTED_ALERTS=1` on the deployed worker opens issues in customer repositories that never approved Refit. That is customer-facing and stays off until the owner decides.
- **App permission and event.** Alerts need the App's **Issues: Read and write** permission, and push re-scans need the App to subscribe to the **Push** event. Both are App settings changes, which existing installations must accept. Until then, a missing permission shows as a failed token on each pass, and new commits are picked up by the 24-hour re-scan.

## Not covered yet

- Slack or email notices: the hosted worker only writes GitHub issues.
- Recovering an interrupted `sending` alert by looking for the issue's marker on GitHub.
- Re-scans when Refit's own scanners change: an inventory is taken again only for the triggers above.
