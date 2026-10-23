# GitHub API detection

`refit github-api` lists the GitHub API use a repository makes and matches it to what GitHub has published about deprecations, removals and version support. It reads source only: nothing is installed, run or sent to GitHub, and nothing is changed. There is no GitHub provider adapter (`adapter: null` in the agent catalog), so Refit does not propose or validate migrations for GitHub.

```
refit github-api [--repository <root>] [--all] [--json]
```

By default, the text output prints only requests that have a notice or a note. `--all` prints every request, with the breaking changes a newer REST API version makes to each endpoint. `--json` prints the full scan.

## What it reads

| Use                  | Example                                                                                                                                                               | Reported as                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Octokit REST methods | `octokit.rest.issues.create(…)`, `octokit.issues.create(…)` in older clients                                                                                          | `octokit`, with the method and the route Octokit sends                                        |
| Routes               | `octokit.request('GET /repos/{owner}/{repo}')`, `octokit.paginate('GET /…')`                                                                                          | `request`, with the route (`:owner` read as `{owner}`)                                        |
| Method references    | `octokit.paginate(octokit.rest.issues.listForRepo, …)`, `paginate.iterator`                                                                                           | `octokit`                                                                                     |
| GraphQL              | `octokit.graphql(query)`, `graphql(query)` from `@octokit/graphql`, `graphql.defaults(…)`, `withCustomRequest(…)`                                                     | `graphql`, with the schema fields the query selects that GitHub's breaking-changes list names |
| Raw HTTP             | `fetch('https://api.github.com/…')`, axios and helpers, and URLs built from a base such as `process.env.API_URL \|\| 'https://api.github.com'` or a parameter default | `url`, with the method and path where they are written                                        |
| Version pins         | `'X-GitHub-Api-Version': '2022-11-28'` in an object, `headers.set(…)`, `headers['…'] = …`                                                                             | `pins`, with the end-of-support date GitHub publishes                                         |

Clients are recognised from `new Octokit` (`octokit`, `@octokit/rest`, `@octokit/core`, `@octokit/action` and `@octokit/app`), `getOctokit()` from `@actions/github`, and Probot's `context.octokit`. Recognition also follows:

- `Octokit.plugin(…)` and `Octokit.defaults(…)` classes;
- class names ending in `Octokit`;
- typed parameters and fields, and functions that return a client;
- clients exported from another file;
- scopes destructured from a client: `const { issues, paginate } = octokit(token)`.

A receiver Refit cannot resolve is still read when the call names a recorded Octokit method. A `.rest.<scope>.<method>` call is read in any file. A `<client>.<scope>.<method>` call is read only in a file that uses a GitHub package, and only when the receiver is named like a client. A receiver named `octokit` is read without the import, because Octokit is often passed in as a parameter.

Values built at runtime are reported as unknown, with the reason. A URL that never reaches a request call, such as a default base URL or a configuration value, is not reported as a request.

## What it matches

| Source                                                                                                | Notice                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub's OpenAPI description, `x-github.deprecationDate` and `removalDate`                            | `openapi`: the operation is deprecated, with its removal date when GitHub gives one                                                       |
| `@octokit/plugin-rest-endpoint-methods` `deprecated` and `renamed` entries, releases 4.15.1 to 18.0.0 | `octokit`: Octokit's own deprecation message. A note says when a method is missing from the newest release or from every recorded release |
| REST API version breaking changes (2026-03-10)                                                        | `versionChanges`: kept apart from notices, because they apply only when a request moves to that version                                   |
| GraphQL upcoming breaking changes                                                                     | `graphql`: one notice per `Type.field` (or `Type.field.argument`) coordinate a query selects                                              |

Unknown scopes such as `app.webhooks.on` and `app.oauth.createToken` are not REST requests and are skipped.

## Deadline registry

The registry has provider `github`, with three entry kinds. `refit deadlines` reports them through `githubDeadlineUses`.

| Entry                                    | Kind          | Date       | Matches                                             |
| ---------------------------------------- | ------------- | ---------- | --------------------------------------------------- |
| `github-rest-2022-11-28`                 | `api-version` | 2028-03-10 | Pinned `X-GitHub-Api-Version: 2022-11-28`           |
| `github-teams-legacy-endpoints`          | `endpoint`    | 2021-02-01 | The 16 legacy `/teams/{team_id}` operations         |
| `github-source-imports-endpoints`        | `endpoint`    | 2024-04-12 | The 8 source imports operations                     |
| `github-org-security-product-enablement` | `endpoint`    | 2025-07-22 | 1 operation                                         |
| `github-org-security-managers-endpoints` | `endpoint`    | 2026-01-01 | 3 operations                                        |
| `github-classroom-endpoints`             | `endpoint`    | 2026-08-28 | 6 operations                                        |
| `github-dependency-graph-sbom-export`    | `endpoint`    | 2026-11-13 | 1 operation                                         |
| `github-graphql-databaseid-2027`         | `field`       | 2027-01-01 | `Artifact.databaseId`, `CheckAnnotation.databaseId` |

The endpoint entries are every OpenAPI operation that has a `removalDate`, grouped by date. Three deprecated codespaces access operations have no removal date and are not in the registry. Past-due entries stay listed, because the operations are still in GitHub's description. A request that pins an unsupported version gets `410 Gone`. Requests without the header use the oldest supported version, so they move too.

## Sources

`data/github-api.json` is generated by `scripts/github-api-data.mjs` from pinned inputs. Each source is recorded in the file with its commit and `checkedAt` 2026-10-22.

| Fact                                                                                                          | Source                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported versions (2022-11-28 and 2026-03-10), the default version, the 24-month support rule and `410 Gone` | [`content/rest/about-the-rest-api/api-versions.md`](https://github.com/github/docs/blob/5815d11586b0796688963a98c889680e60d72dc4/content/rest/about-the-rest-api/api-versions.md), [`data/tables/rest-api-versions.yml`](https://github.com/github/docs/blob/5815d11586b0796688963a98c889680e60d72dc4/data/tables/rest-api-versions.yml) (`end_of_support: 'March 10, 2028'`), github/docs at 5815d11 |
| 28 breaking changes in 2026-03-10, with the endpoints each lists                                              | [`data/reusables/rest-api/breaking-changes-changelog.md`](https://github.com/github/docs/blob/5815d11586b0796688963a98c889680e60d72dc4/data/reusables/rest-api/breaking-changes-changelog.md) and `src/rest/lib/config.json`, github/docs at 5815d11                                                                                                                                                  |
| 38 deprecated operations, 35 of them with a removal date                                                      | [`descriptions/api.github.com/api.github.com.json`](https://github.com/github/rest-api-description/blob/755ee33b4a81d51f6f07a902cce26cbec3b822f2/descriptions/api.github.com/api.github.com.json), github/rest-api-description at 755ee33, sha256 `3177ad6a…`, 1,242 operations                                                                                                                       |
| 1,289 GraphQL upcoming changes, and the schema used to walk queries                                           | [`src/graphql/data/fpt/graphql_upcoming_changes.public.yml`](https://github.com/github/docs/blob/5815d11586b0796688963a98c889680e60d72dc4/src/graphql/data/fpt/graphql_upcoming_changes.public.yml) and `schema.docs.graphql`, github/docs at 5815d11                                                                                                                                                 |
| Octokit method routes and deprecations                                                                        | `dist-src/generated/endpoints.js` in each `@octokit/plugin-rest-endpoint-methods` npm tarball, 15 releases from 4.15.1 to 18.0.0 (latest), parsed and never run                                                                                                                                                                                                                                       |

Only 2 of the 1,289 GraphQL changes have a future date (2027-01-01). The rest are past their stated dates but are still listed by GitHub as upcoming, so a query that selects one of those fields still gets a notice with that date.

**Blocked**

- **docs.github.com:** the rendered pages (`/en/rest/about-the-rest-api/api-versions`, `/breaking-changes` and `/en/graphql/overview/breaking-changes`) were not fetched here. The same content was read from the github/docs repository at the commit above.
- **The GitHub changelog** (`github.blog/changelog`): the host refused the connection, so the API deprecations announced there were not read. Removals announced only in the changelog are not in the data; the OpenAPI `removalDate` values are.

## Benchmark

These numbers are measured on public repositories; none of these projects is a customer.

| Item                    | Value                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen sample           | `docs/benchmarks/2026-10-22-github-repos.json`, 70 repositories                                                                                                                                                                              |
| Selector                | `scripts/github-select.mjs`: npm search over 14 queries; the latest manifest declares `octokit`, an `@octokit` client, `@actions/github` or `probot` in `dependencies`; published since 2022-01; ranked by monthly downloads; frozen at HEAD |
| Excluded from selection | GitHub's own scopes and packages                                                                                                                                                                                                             |
| Labelled sets           | First 20 repositories in rank order with 1 to 50 candidate lines (dev), then the next 10 (held-out)                                                                                                                                          |
| Labelling               | By hand, from the source, before any scan                                                                                                                                                                                                    |

Both label files and their rules were committed (5629c35) before the first scan.

| Set                 | Refit commit | Repositories scanned | Labels | Reported | Precision | Recall | Route agreement |
| ------------------- | ------------ | -------------------: | -----: | -------: | --------: | -----: | --------------: |
| Dev, first scan     | c21cdd9      |                   17 |    156 |       96 |     0.865 |  0.532 |           0.988 |
| Dev                 | cd4a34a      |                   17 |    156 |      154 |       1.0 |  0.987 |             1.0 |
| Held-out, blind     | c21cdd9      |                    8 |    121 |       44 |       1.0 |  0.364 |           0.976 |
| Held-out, not blind | cd4a34a      |                    8 |    121 |      121 |       1.0 |    1.0 |             1.0 |

The held-out set was scored once at c21cdd9 before any detection change. Its misses were seen when that score was printed, so the later held-out numbers are not blind; the blind held-out number is the c21cdd9 row. Five labelled repositories exceed Refit's repository scan limits (10,000 files, 2 MiB per file, 50 MiB total) and are skipped, not scored:

- `napi-rs/napi-rs`, `googleapis/release-please` and `aws-amplify/amplify-category-api` (dev);
- `electron/github-app-auth` and `favware/cliff-jumper` (held-out).

Version pins: the one labelled pin (held-out) was missed at c21cdd9, because it was set with `headers.set`, and found at cd4a34a.

The two remaining dev misses:

- **`danger/danger-js` `customGitHubRequire.ts:70`:** a URL passed to a fetch function that arrives as a parameter named `api`.
- **`release-it/release-it` `util.js:22`:** `client.search.issuesAndPullRequests` on a parameter, in a file that imports no GitHub package.

Across all 70 repositories at cd4a34a:

- 956 live requests are reported: 805 Octokit methods, 87 routes, 37 GraphQL queries and 27 raw requests;
- 12 live version pins are reported;
- one GraphQL notice is reported (`PullRequestReviewComment.databaseId`);
- no request reaches an OpenAPI-deprecated operation.

Requests in the 50 unlabelled repositories are not checked by hand, so precision there is not measured.

Rerun:

```
node scripts/github-select.mjs --count 70 --output repos.json   # reselects; the frozen list is in docs/benchmarks
node scripts/github-benchmark.mjs --root <clones> --output results.json
node scripts/github-score.mjs --labels docs/benchmarks/2026-10-22-github-labels.json --results results.json
```

Results are in `docs/benchmarks/2026-10-22-github-first-results.json` (c21cdd9) and `2026-10-22-github-results.json` (cd4a34a). Both scans ran from a clean checkout of those commits.

## Limits

- **Languages:** only `.js`, `.ts`, `.mjs`, `.cjs`, `.jsx` and `.tsx` files are read. Requests in `.svelte` and `.vue` files are not; `upptime/status-page` makes all of its calls from Svelte components.
- **Wrappers:** a wrapper is reported where it calls the client or the URL, not at each place the wrapper is called.
- **GraphQL:** fragments interpolated into a template are not followed. Queries built at runtime are reported as unknown.
- **GitHub Enterprise Server:** hosts are not matched, and Enterprise Server API versions are not in the data.
