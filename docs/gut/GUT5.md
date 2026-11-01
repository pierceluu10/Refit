# GUT5: the sandbox judge

Written 2026-10-31 for wave 2 of [the gut plan](../GUT-PLAN.md) (SC-S1 to SC-S4 in [the inventory](../GUT-INVENTORY.md#shared)).

## The check GUT2 and GUT3 pass to `fixWithAgent`

```ts
import {
  disposeSandboxBaseline,
  sandboxBaseline,
  sandboxCheck,
} from './validation-sandbox-check.ts';

const baseline = await sandboxBaseline({ repository }); // the git clone; once per repository
try {
  await fixWithAgent({ ...input, check: (repoDir) => sandboxCheck(repoDir, baseline) });
} finally {
  await disposeSandboxBaseline(baseline);
}
```

- `sandboxBaseline({ repository, image?, checkTimeoutSeconds?, signal?, onProgress? })`
  - Installs the committed tree in the build sandbox, with scripts allowed.
  - Runs its checks on the original tree once.
  - Throws only when the repository cannot be read or Docker fails. That is the `infrastructure` outcome.
- `sandboxCheck(repoDir, baseline)` returns `{ passed, errors, unproven, parts }`:
  - `errors`: the exact failing lines the edit added, each tagged `[typecheck]`, `[build]`, `[tests]` or `[install]`. `passed` is `errors.length === 0`. A regression is returned here and does not end the repository (SC-S3).
  - `unproven`: why a pass proves less than it claims. A non-empty list means `needs-review`, not `validated`. It is filled when:
    - no check could run (SC-S4);
    - a check already fails on the original code (SC-S1; the `baselineStop` name is kept in the note);
    - the original tree did not install.
  - `parts`: for each check, its command, its status before and after, the new failures, and the generators that ran before it.
- **Checks, from the tree's `package.json`:**
  - **Type check:** the `typecheck`, `type-check`, `check-types`, `types` or `tsc` script, which may run typegen first. Otherwise `tsc --noEmit -p .` when `tsconfig.json` exists, using the repository's compiler or else Refit's.
  - **Build:** the `build` script.
  - **Tests:** the `test` script, unless it is npm's placeholder.
  - Each check runs on its own, offline, in the validation sandbox.
  - A check the edit adds runs on the edited tree only, and every failure it reports counts.
- **Counting** (`newFailures`):
  - Type errors are matched by file, code and message, so an error that moves to another line is not counted again.
  - Tests that already fail are compared with `newTestFailures`.
  - Build output lines are compared with their positions and timings removed.
  - A check that times out only on the edited tree is an error.
- **Generated clients.** Before every check, `containerCheck` runs the declared generators (`prisma generate`, `next-env.d.ts`; see `declared-generators.ts`). The install also runs lifecycle scripts, so a `postinstall` generator runs there too.
- **Reinstalls.** An edit to `package.json`, a lockfile or the workspace files triggers a new install from the edited tree. The result is cached by those files' hash, so later rounds reuse it.
- **Concurrency.** At most two sandboxes run at once in one process (`REFIT_SANDBOX_CHECKS`), so three parallel attempts fit a 16 GB runner.

## Installs (SC-S2)

- `installInSandbox` (`repository-environment.ts`) tries plans in this order and uses the first that installs:
  1. The repository's own frozen install (Dockerfile, devcontainer, CI step or lockfile).
  2. `unlockedPlans` (`repository-install.ts`): `npm install`, then `npm install --legacy-peer-deps`. For pnpm it is `pnpm install --no-frozen-lockfile` and for Yarn `yarn install`. The manager comes from the `packageManager` pin, else the lockfile, else npm.
- Lifecycle scripts run in every plan, in the build sandbox:
  - no secrets;
  - egress only through the allowlisting proxy.
- `prepareEnvironment` now falls back to the sandbox install on every repository-side refusal: no lockfile, an out-of-sync lockfile, failed integrity checks, peer conflicts, Git dependencies, several lockfiles. Only the archive size limit still stops.
- A failed install does not stop `sandboxBaseline`. The checks run without dependencies, only new failures count, and the note goes into `unproven`.

## refit-bench (`gut/sandbox` branch)

`shopify.yml` and `meta.yml` gain two inputs:

- **`agent`:**
  - The Refit commit must declare `@anthropic-ai/claude-agent-sdk`. The `Agent runtime` step checks that `npm ci` installed it and its bundled `claude` CLI, at the locked version, and puts the CLI on `PATH`.
  - `ANTHROPIC_API_KEY` goes only into the private AI env file (`umask 077`), never into an input or a log.
  - `size` must be 1.
  - Shards get 360 minutes, the GitHub-hosted maximum. That covers 3 attempts of 3 rounds: each round is up to 10 minutes of agent work plus a check of up to 3 × 10 minutes, and at most two sandboxes run at once.
- **`mode: sandbox-check`:**
  - Runs `pipeline/validation-sandbox-check-cli.ts` on each repository in the shard and skips the merge job. No AI runs.
  - Each repository is judged three times: unchanged, after a trivial edit (a comment) and after a probe that adds one type error.

## Real check

See the PR description for the runs.
