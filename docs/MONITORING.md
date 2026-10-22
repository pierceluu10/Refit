# Hosted deadline monitoring

With `REFIT_HOSTED_ALERTS=1`, the hosted worker (`refit hosted serve`) watches every repository with a stored approval that it has an [inventory](INVENTORY.md) for, and alerts it before a registry deadline the way `refit serve --deadline-alerts` does for enrolled repositories (see [API deadlines](DEADLINES.md#alerts-from-the-service)). It is off by default, and repositories without an approval are inventoried but never monitored or alerted (owner decision, 2026-10-22). Alerts are advice: they never change code, enroll a repository or start a migration.

## What it does

Each worker pass (on a webhook that wakes it, or every `--interval` seconds, 300 by default):

1. **Re-scan triggers.** It queues a new inventory for a repository when one of these is pending and its last re-scan was at least 10 minutes ago:
   - a push to the repository's default branch (`push` webhook; see [Needs owner decision](#needs-owner-decision)),
   - a deadline registry that differs from the one the stored inventory was matched against, unless the last inventory attempt failed (so a failing repository does not spend the daily inventory cap every 10 minutes),
   - 24 hours since the last re-scan.

   A repository is first seen when its inventory exists; its clock starts then. The inventory itself works as described in [repository inventory](INVENTORY.md): an unchanged commit and registry is checked, not fetched or scanned again. A push that arrives while an inventory is queued or running asks for one more once it is done.

2. **Alerts.** For the last complete inventory of every approved repository of an allowed, active installation (kept when a later re-scan stops), it takes the stored deadline exposures and counts the days left again from today, without a checkout. A deadline reaches a stage at 90, 30 and 7 days before its date and again on the date. When a deadline reaches a tighter stage than the last one sent for that repository, Refit opens one GitHub issue for the repository and deadline, or updates the one it opened before (new title and body, plus a comment so watchers are notified). Crossing several stages between passes sends one alert at the tightest. A closed issue stays closed. The issue text is the same as the local service's.

Only live evidence counts: model names in tests, comments, catalogs and tokenizer calls never open an alert. Report-only registry entries (a derived date or a method, endpoint, field or feature kind) never open one either. Issues list where each match is (file and line), not the source line, since inventories do not store it.

## Weekly digest

With `REFIT_HOSTED_ALERT_DIGEST=1` as well (off by default; it requires `REFIT_HOSTED_ALERTS=1`), each approved repository with at least one listed deadline also gets one digest issue, titled "Refit weekly digest: deadlines this repository depends on" and marked `<!-- refit-deadline-digest -->`. It lists the deadlines alerts could reach: within 90 days, not report-only and not accepted by a valid ignore, soonest first (at most 50): its date, days left, the first piece of evidence, and either the ignore that accepts it or the alert issue opened for it. Refit updates it, with a comment, every 7 days. Once Refit has opened a digest, it keeps updating it weekly; when nothing is exposed any more, the digest says so. The week is taken before the issue is written, like an alert stage, so a digest is written at most once a week and a failed one waits for the next week. A worker that stops after GitHub created the digest but before Refit stored its number opens a second digest the next week. A closed digest is still updated, with a comment.

## Ignores

The committed `.refit-deadlines-ignore.json` (see [API deadlines](DEADLINES.md)) is read when the inventory is taken. Active entries that cover every piece of live evidence silence that deadline; expired entries do not. An invalid file accepts nothing, so a broken exception can never silence an alert. A changed ignore file takes effect at the next re-scan (push or 24 hours).

## Exactly one alert per stage

Before writing to GitHub, a worker takes the stage in PostgreSQL (`refit_deadline_alerts`): the row moves to the new stage only if its stored stage is wider. Another worker, or the same worker after a restart, finds the stage taken and sends nothing. A write that fails is recorded as `failed` and is not retried until the next stage, as locally. A worker that stops mid-write leaves the row `sending`; Refit does not send that stage again, so an interrupted alert can be missed but that stage is never sent twice. Because a `sending` or failed first write keeps no issue number, the next stage opens a new issue rather than updating one. If GitHub refuses the issue token (for example, the Issues permission is missing), nothing is taken and the next pass tries again.

## Removal and uninstall

Monitoring rows and alert state belong to the installed repository. Removing the repository from the installation deletes them, together with the inventory. Uninstalling the App deletes the inventories at once, so nothing is sent afterwards, and keeps the alert state for the uninstall grace period (see [hosted onboarding](HOSTED-ONBOARDING.md)), so a reinstall within it does not alert the same stage again. Revoking an approval stops alerts at the next pass. Issues already opened stay in the repository.

## What it stores

PostgreSQL tables created by hosted migration 6 (`pipeline/hosted-migrations.ts`), both deleted with the installed repository row:

| Table                   | Columns                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refit_monitoring`      | `installation_id`, `repository`, `pushed` (a default-branch push not yet re-scanned), `rescanned_at` (last re-scan Refit asked for, or when monitoring first saw the repository), `digest_issue` and `digest_at` (the weekly digest). |
| `refit_deadline_alerts` | `installation_id`, `repository`, `deadline`, `stage` (90, 30, 7 or 0), `issue`, `status` (`sending`, `opened`, `updated` or `failed`), `message` (the failure), `sent_at`.                                                            |

`GET /status` adds `monitoring`: whether alerts are on, and for each installation its exposed deadlines across repositories, soonest first (at most 50, with `more` counting the rest): repository, deadline, date, days left, whether an ignore accepts it, and the last alert's stage, issue and status. It is listed even when alerts are off, from the stored inventories of approved repositories, and left out of a single target's view (`/status?target=`).

## Configuration

| Setting                       | Effect                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `REFIT_HOSTED_ALERT_DIGEST=1` | Adds the weekly digest issue. Requires `REFIT_HOSTED_ALERTS=1`; off by default.                  |
| `REFIT_HOSTED_ALERTS=1`       | Turns re-scans and alerts on with lead times of 90, 30 and 7 days. `0` or unset leaves them off. |
| Issues: Read and write        | GitHub App permission the alerts need.                                                           |
| `push` event subscription     | Lets a default-branch push trigger a re-scan. Without it, new commits are found within 24 hours. |

## Needs owner decision

- **Enable alerts.** Setting `REFIT_HOSTED_ALERTS=1` (and the digest) on the deployed worker opens issues in approved customer repositories. That is customer-facing and stays off until the owner decides.
- **App permission and event.** Alerts need the App's **Issues: Read and write** permission, and push re-scans need the App to subscribe to the **Push** event. Both are App settings changes, which existing installations must accept. Until then, a missing permission shows as a failed token on each pass, and new commits are picked up by the 24-hour re-scan.

## Not covered yet

- Slack or email notices: the hosted worker only writes GitHub issues.
- Recovering an interrupted `sending` alert by looking for the issue's marker on GitHub.
- Re-scans when Refit's own scanners change: an inventory is taken again only for the triggers above.
