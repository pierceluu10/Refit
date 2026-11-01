# app

Aptitude's GitHub App. It receives webhooks, turns them into jobs for the orchestrator, reports what
humans did with Aptitude PRs, and opens PRs for the harness. Founder setup and local development are
in [SETUP.md](SETUP.md).

## What it does

| Webhook                                                     | Result                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `installation.created`                                      | Lists every repo via the API, queues `understand` for each |
| `installation.deleted`, `installation_repositories.removed` | Queues `forget` for each repo                              |
| `installation_repositories.added`                           | Queues `understand` for each repo                          |
| `push` to the default branch                                | Queues `understand` (a re-read) with the new sha           |
| `pull_request.closed` on an `aptitude/` branch              | Records the human verdict, `merged` or `closed`, in memory |

Every request's signature is checked against `GITHUB_WEBHOOK_SECRET` before it is handled.

## Files

| File            | Purpose                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `types.ts`      | Job, verdict and PR types, and `BRANCH_PREFIX` (`aptitude/`)                                 |
| `github.ts`     | Installation-token client: app JWT (RS256), token cache, `listInstallationRepos`             |
| `pr.ts`         | `openPullRequest`: branch and commit via the Git Data API, then a draft PR                   |
| `webhooks.ts`   | Signature verification and the handlers above                                                |
| `server.ts`     | `POST /webhooks`, `GET /healthz`                                                             |
| `main.ts`       | Entry point                                                                                  |
| `config.ts`     | Reads the env vars listed in SETUP.md                                                        |
| `stubs.ts`      | In-memory job queue and a logging verdict recorder, until `orchestrator/` and `memory/` land |
| `fixtures/`     | Illustrative webhook payloads for the tests                                                  |
| `manifest.json` | The App's permissions and events; source of truth for its GitHub settings                    |

## Opening a PR from the harness

`openPullRequest` refuses any branch that doesn't start with `aptitude/` or that equals the base, and
any change with no files. `base` defaults to the repo's default branch.

```ts
import { createInstallationTokens } from '../app/github.ts';
import { openPullRequest } from '../app/pr.ts';

const tokens = createInstallationTokens(appId, privateKey);

const pr = await openPullRequest(tokens, installationId, {
  repo: 'acme/payments',
  branch: 'aptitude/stripe-node-17',
  title: 'Upgrade stripe-node from 14 to 17',
  body: 'What changed, and the checks that prove it.',
  commitMessage: 'chore: upgrade stripe-node to 17',
  files: [
    { path: 'package.json', content: updatedPackageJson },
    { path: 'src/legacy-charge.ts', delete: true },
  ],
  draft: true,
});
// pr: { url, number, branch, sha }
```

The repo, branch and files above are an illustrative example.

## Tests

From the repo root:

```sh
npx vitest run app
```
