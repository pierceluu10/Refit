# Harness evaluation on real repos

Five real tasks with known pending changes, for hand-checking the harness's diffs. Each task is a
`MigrationTask` in `tasks/`; `tasks.json` pins the repo and commit. The changes come from the
provider watchers' own reads (`providers/*/fixtures/expected.json`, quotes and URLs as read), except
the openai v3 → v4 change, which round 1 sourced from the openai-node v4 migration discussion. The call
sites were checked by hand against each repo at its commit.

| Task                               | Repo @ commit                              | Change                                               | Package manager    |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------- | ------------------ |
| `commitgpt-openai-v4`              | RomanHotsiy/commitgpt @ `dfbe1eb`          | openai Node SDK v3 → v4 (`sdk-major`)                | npm, lockfile v2   |
| `chatgpt-nodejs-openai-v4`         | MRwangqi/chatGPT-nodejs @ `820401f`        | openai Node SDK v3 → v4 (`sdk-major`)                | yarn 1             |
| `ai-ui-demo-gpt-4o-shutdown`       | kenzic/ai-ui-demo @ `092aaaa`              | `gpt-4o-2024-08-06` shuts down on 2027-01-14         | npm, lockfile v3   |
| `infinite-bundler-shopify-2026-10` | sachin21kumar/Infinite-bundler @ `97af7f1` | Admin API pinned at `ApiVersion.October24` → 2026-10 | npm, lockfile v3   |
| `pdfai-stripe-endive`              | JensenMPillay/pdfai @ `76eee19`            | API pinned at 2023-10-16 → 2026-10-28.endive         | pnpm, lockfile 9.0 |

Why each repo is affected:

- **commitgpt** and **chatGPT-nodejs** construct `Configuration` and `OpenAIApi` from openai 3.x
  and call `createCompletion` (chatGPT-nodejs also `listEngines` and `createImage`), all gone in v4.
- **ai-ui-demo** calls `beta.chat.completions.parse` with `model: "gpt-4o-2024-08-06"`, a snapshot
  the deprecation notice lists by name.
- **Infinite-bundler** pins `ApiVersion.October24` in `app/shopify.server.js` and runs Admin
  GraphQL queries in three routes.
- **pdfai** pins `apiVersion: "2023-10-16"`, reads `subscription.current_period_end` in its webhook
  and passes `payment_method_types` to `checkout.sessions.create`.

## Running it

With `ANTHROPIC_API_KEY` in the environment:

```sh
APTITUDE_AI_BUDGET_USD=6 node harness/scripts/run-evaluation.ts [task id ...]
```

`APTITUDE_AI_BUDGET_USD` caps the whole batch: every model call is counted through `chargeRun`, and
each task gets `APTITUDE_TASK_BUDGET_USD` (default $1.50) or what is left. Repos are cloned outside
this repo and run in the Docker sandbox. Each run writes `results/<id>/` with `record.json`
(outcome, checks, cost, models), `diff.patch` and `pr-body.md`. Nothing is pushed or opened.

## Results

**Not run yet.** On 2026-11-01 `ANTHROPIC_API_KEY` was not set in this session's shell, so no real
run happened and $0 was spent. Hand-checks and verdicts go here once the runs exist: does the diff
handle every call site, and would we merge it?

### $0 baseline in the Docker sandbox

The real harness installed each repo and ran its detected checks, with a scripted agent that
changed nothing. This is what each run starts from, and so what it can prove:

| Task                               | Install               | Baseline checks                                                                                            |
| ---------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `commitgpt-openai-v4`              | npm 8 (`npx`), ok     | typecheck pass, build pass                                                                                 |
| `chatgpt-nodejs-openai-v4`         | yarn 1 (corepack), ok | none detected: no scripts and no tsconfig, so the agent has to register its own                            |
| `ai-ui-demo-gpt-4o-shutdown`       | npm (image's), ok     | typecheck pass; build fails because `new OpenAI()` runs at module scope without `OPENAI_API_KEY`           |
| `infinite-bundler-shopify-2026-10` | npm (image's), ok     | typecheck fails on existing errors in `app/routes/products.tsx`; build pass                                |
| `pdfai-stripe-endive`              | pnpm 9 (corepack), ok | typecheck fails (Prisma client not generated with scripts off); build fails (`OPENAI_API_KEY`); test fails |

pdfai could not install at all before this round's change: the image has no `pnpm`. The failing
builds are why the kickoff now tells the agent to register a variant of a failing check that
supplies a placeholder (`OPENAI_API_KEY=placeholder npm run build`), so the check can prove the
edit.

### $0 checks of the lockfile change

A scripted fake agent (no model) bumped one dependency and called `install` in the Docker sandbox,
through the real harness code:

- **commitgpt**, openai `^3.2.1` → `^4.104.0`: `install` ran `npx -y npm@8`, the release the v2
  lockfile implies. Lockfile diff: 643 lines, against 683 with the image's npm 10.9 (the 40 extra
  are `license` lines). The rest is openai v4's real dependency tree, written twice in a v2 lockfile.
- **pdfai**, stripe `^14.25.0` → `^18.0.0`: `install` ran `corepack pnpm@9`. Lockfile diff:
  `+21 -15`. Before this change the Docker image had no `pnpm`, so neither the install nor the
  checks could run on a pnpm repo.
