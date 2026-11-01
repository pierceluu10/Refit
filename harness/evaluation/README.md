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

## Hand-check guide

What a mergeable diff has to cover in each task, from the code at its commit and the provider tool
packs' own data on 2026-11-01. Use it with each run's `diff.patch` and `pr-body.md`.

- **commitgpt-openai-v4:** in `client.ts`, the default `OpenAI` import, `new OpenAI({ apiKey })`,
  `completions.create` and `result.choices` without `.data`; `openai` bumped in `package.json`; the
  v2 lockfile rewritten by npm 8, so no new `license` lines. Under Unproven, the PR should say that
  Completions' models were shut down on 2026-09-28 (per `openai_check_request`), so the endpoint
  still needs its own migration.
- **chatgpt-nodejs-openai-v4:** every v3 shape `openai_sdk_migration` finds in `index.js`:
  `Configuration` and `OpenAIApi`, `createCompletion`, `createImage`, `listEngines` (removed in v4,
  with no direct replacement) and `.data` unwrapping. Its models are retired too: `text-davinci-003`
  shut down on 2024-01-04, and `image-alpha-001` isn't in OpenAI's catalog. A correct PR replaces
  them or says plainly that it didn't. The repo has no checks, so check what the agent registered
  as proof. Lockfile: yarn 1 format.
- **ai-ui-demo-gpt-4o-shutdown:** `gpt-4o-2024-08-06` replaced in `app/api/ui/route.ts`, with
  `openai_model_lookup` or `openai_check_request` run on the new model; the structured output through
  `zodResponseFormat` still works with it; Behaviour changes says the new model's output wasn't
  checked on real prompts. No dependency change should be needed.
- **infinite-bundler-shopify-2026-10:** `ApiVersion.October24` replaced in both places in
  `app/shopify.server.js`, which needs an `@shopify/shopify-app-remix` release that exports the
  2026-10 version; the GraphQL documents validated at 2026-10 (three deprecated fields today, see
  below). Breaking changes accumulate across 2026-01, 2026-04, 2026-07 and 2026-10, per
  `shopify_api_versions`.
- **pdfai-stripe-endive:** `apiVersion` in `src/lib/stripe.ts` moved with a stripe-node release that
  pins it; `subscription.current_period_end` (webhook route, lines 56 and 70) read from the
  subscription items, since 2025-03-31.basil removed subscription-level periods;
  `payment_method_types` dropped from `checkout.sessions.create`, stated as a behaviour change.
  `stripe_api_versions` lists 95 breaking entries between the two versions, so check that the
  agent looked past these three. Lockfile: pnpm 9 format.

## Running it

With `ANTHROPIC_API_KEY` in the environment:

```sh
APTITUDE_AI_BUDGET_USD=6 node harness/scripts/run-evaluation.ts [task id ...]
```

`APTITUDE_AI_BUDGET_USD` caps the whole batch: every model call is counted through `chargeRun`, and
each task gets `APTITUDE_TASK_BUDGET_USD` (default $2) or what is left. The harness keeps
`TURN_RESERVE_USD` ($1) of a task's budget back for the call that crosses it, so a $2 task gets
about $1 of agent work; pdfai's migration crosses five Stripe major versions and may need $3. Repos
are cloned outside this repo and run in the Docker sandbox. Each run writes `results/<id>/` with
`record.json` (outcome, checks, cost, models), `diff.patch`, `pr-body.md` and `summary.md`.
Nothing is pushed or opened.

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

### $0 rehearsal of the verified path on commitgpt

A scripted agent replayed round 1's commitgpt diff through the real harness, the Docker sandbox and
the OpenAI tool pack: `install` ran `npx -y npm@8`, typecheck and build passed before and after, and
`openai_sdk_migration` found the v3 call shapes before the edit and none after. At first the run
graded **verified**. After the review's fixes it grades **needs-review**: `openai_check_request`
reports the Completions endpoint as legacy, and the agent left that failing check out of `finish`.
That's right for this code, as the second point below explains. The rehearsal showed:

- **Validator grading had holes.** Reports of problems from `openai_sdk_migration` (old SDK shapes
  found) and `openai_check_request` (a legacy endpoint) were graded as passing, as were bad inputs
  to the Stripe, Shopify and OpenAI checkers. Fixed in this PR; the same outputs now fail.
- **Round 1's diff is right for this task but leaves a second change open.** `openai_check_request`
  reports that Completions is a legacy endpoint whose models (`gpt-3.5-turbo-instruct`,
  `babbage-002`, `davinci-002`) were shut down on 2026-09-28, per the pack's deprecations snapshot.
  commitgpt still calls `completions.create` with a user-configured model, so after the v4 bump it
  calls an endpoint with no models left. That's a separate change and task (moving `getAnswer` to
  Chat Completions or Responses), but a real run's PR should say so under Unproven. Whether it does
  is part of this task's hand-check.

### What the provider validators say about the real code ($0)

- **pdfai:** `stripe_check_params` on its real `checkout.sessions.create` params at 2026-10-28.endive
  fails on `payment_method_types`, citing the 2026-09-30.endive removal, and passes once it is
  dropped. A correct run has to remove it, which changes which payment methods Checkout offers: a
  behaviour change the PR must state.
- **Infinite-bundler:** `shopify_validate_graphql` on the `app.optionset.jsx` query finds no errors
  at 2026-10 but three deprecations (`Product.images`, `Image.originalSrc`,
  `ProductVariant.barcode`); they grade as passing, since deprecated fields still work. The live
  schema for 2024-10 answered HTTP 400, which fits the task: `ApiVersion.October24` is no longer
  served.

### $0 checks of the lockfile change

A scripted fake agent (no model) bumped one dependency and called `install` in the Docker sandbox,
through the real harness code:

- **commitgpt**, openai `^3.2.1` → `^4.104.0`: `install` ran `npx -y npm@8`, the release the v2
  lockfile implies. Lockfile diff: 643 lines, against 683 with the image's npm 10.9 (the 40 extra
  are `license` lines). The rest is openai v4's real dependency tree, written twice in a v2 lockfile.
- **pdfai**, stripe `^14.25.0` → `^18.0.0`: `install` ran `corepack pnpm@9`. Lockfile diff:
  `+21 -15`. Before this change the Docker image had no `pnpm`, so neither the install nor the
  checks could run on a pnpm repo.
