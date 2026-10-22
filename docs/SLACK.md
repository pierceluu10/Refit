# Slack notifications

Set `REFIT_SLACK_WEBHOOK_URL` to a Slack [incoming webhook](https://api.slack.com/messaging/webhooks) URL (`https://hooks.slack.com/services/…`) and `refit run`, `refit watch`, `refit serve` and `refit hosted serve` post one line to that channel for the outcomes below. Unset, nothing is sent. Any other URL is refused at startup.

| Outcome                                                                     | Message                                                                                                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A validated draft PR was created                                            | `✅ acme/shop: validated fix, draft PR ready https://github.com/acme/shop/pull/12`                                                 |
| Validation returned a regression                                            | `🚨 [URGENT] acme/shop: the patch breaks the repository's own checks (regression); not published.`                                 |
| Publication failed partway                                                  | `🚨 [URGENT] acme/shop: publication failed partway (…); a remote branch or draft PR may remain, reconcile before retrying.`        |
| A `refit serve --deadline-alerts` alert at 7 days or less, or past the date | `🚨 [URGENT] acme/shop: OpenAI model gpt-4 reaches its sunset on 2026-10-23 (3 days left); https://github.com/acme/shop/issues/41` |
| `refit hosted serve` only: a job failed (at most one per target per hour)   | `🚨 [URGENT] acme/shop: hosted job 12 failed (interrupted: Error: …); see refit hosted receipt 12.`                                |

Nothing else is sent. Stops for review, validation environment refusals, an already open PR and deadline stages further than 7 days out stay in the run artifacts and service status. Deadline notices follow the alert state in `registry.json`, so each stage is sent once and a restart does not repeat it.

A failed or slow send (5-second limit) only prints a warning; the run's outcome and artifacts are unchanged. The webhook URL is a credential: keep it in `.env` or the environment, never in `.refit.json`. Refit never prints it. Repository names and error text are escaped, so they cannot mention a channel or user. Messages contain the repository name, the PR or issue link and, for a publication failure, the first 200 characters of the error.

Benchmark commands (`npm run benchmark:stripe`, `npm run benchmark:shopify`) remove the variable before running each repository, so benchmarks never post.
