# providers

Per-provider watchers and knowledge (F1), plus tool packs and playbooks (F2).

A watcher is an AI agent. It reads a provider's changelog, release notes, SDK releases and deprecation pages, then writes `ProviderChange[]`. Each change has a `MigrationKind`, the affected operations and fields, an effective date and an exact source quote. The model decides what matters and how to classify it. Code only fetches pages, checks quotes and output shape, and hands every problem back to the model to fix. It never drops a change.

## Layout

```
providers/
  core/                 shared watcher: agent loop, page tools, prompts, fetch, budget, registry
  <provider>/
    provider.json       id, name and the starting pages (changelog, deprecations, SDK releases, specs)
    prompt.md           a few paragraphs on how this provider versions and announces changes
    knowledge.json      versions, retirements, docs and SDKs; every entry has a source URL and date
    watcher.ts          two lines: folderWatcher('<provider>')
    fixtures/live/      saved text of each starting page (from `live-read`, no AI)
    fixtures/expected.json   hand-drafted changes for the replay test
    fixtures/live-run.json   a recorded run of the real model on the saved pages
```

Providers today: `stripe`, `shopify`, `meta` (Graph and Marketing API), `openai`, `twilio`, and `github`. `github` has no `watcher.ts`. It shows that a new provider needs only a folder with `provider.json`, `prompt.md`, `knowledge.json` and fixtures. The registry finds it, `watchAll()` runs it, and `core/providers.test.ts` tests it.

## Adding a provider

1. Create `providers/<id>/provider.json` with 3–6 starting pages. Pick pages whose server response holds the real text: server-rendered HTML, RSS or Atom feeds, the GitHub releases API (`"format": "github-releases"`), raw `CHANGELOG.md` files, or a docs site's `.md` pages.
2. Write `prompt.md`. Explain how versions work, where breaking changes show up, what to put in `affects`, and what to ignore. Write it as guidance, not rules.
3. Run `npm run live-read -w providers -- <id>` and check that `fixtures/live/*.txt` holds real content.
4. Draft `knowledge.json`, either by hand from the docs or with `npm run knowledge -w providers -- <id>` (spends AI). Every entry needs `source: { url, retrievedAt, quote? }`.
5. Write `fixtures/expected.json` with changes quoted word for word from the snapshot, then run `npx vitest run providers`.

## Running

- `npm run live-read -w providers -- <id|all>` fetches every starting page and saves it under `fixtures/live`. It makes no AI calls.
- `npm run watch -w providers -- <id|all> [since]` runs the watcher with Claude through the SDK and prints the full `WatchReport`. Spend is capped by `REFIT_AI_BUDGET_USD` (default $1 a run).
- In code:
  - `folderWatcher(id)` returns a `WatchProvider`.
  - `runWatch(provider, since, deps)` returns the full report: changes, issues, unverified quotes, cost and a per-turn log.
  - `watchAll()` runs every provider against one shared budget.
  - Pass `deps.model` to use any `ModelClient`. `messagesApiModel({ send })` wraps any function that posts a Messages API body.

A `WatchProvider` that never reached a submission throws `WatchFailedError` rather than returning `[]`, so "no changes" is never a silent failure.

## Hard limits in code

- Every model call goes through a `BudgetLedger`, which stops at the run's dollar cap. The SDK client is built with `maxRetries: 0`, so every retry is a new call that goes through the cap check.
- Fetching only goes to public https URLs, and every redirect hop is checked. An optional GitHub token is sent to `api.github.com` only.
- Nothing reads or prints secrets. Credentials resolve the SDK's usual way.
