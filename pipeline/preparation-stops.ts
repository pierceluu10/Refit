// Named stops for dependency preparation and baseline checks that Refit cannot fix itself, each
// matched on the message Refit or the package manager raises. See docs/PREPARATION-FAILURES.md.

// Where Refit's own preparation refuses, it runs the repository's own install in its build
// sandbox (repository-environment.ts); a stop's action is what is left when that fails too. No
// action asks the customer to configure Refit (founder decision, 2026-10-28).
const REFIT_BUILD =
  "Refit also tried the repository's own install in its build sandbox. The draft is published untested; run your own checks on its branch, which the Refit validation workflow does in your CI once its pull request is merged.";

export const PREPARATION_STOPS = [
  {
    reason: 'dependency-tree-too-large',
    pattern: /^Dependency archive exceeds \d+ MiB|^\w+ dependency preparation ran out of space/,
    summary: "the installed dependencies do not fit Refit's validation sandbox",
    action:
      "Run your own tests and type check on the draft branch before merging; Refit's sandbox could not hold this dependency tree.",
  },
  {
    reason: 'non-registry-dependency',
    pattern:
      /^Automatic preparation supports public npm registry dependencies only|^Package tarballs must use public registry\.npmjs\.org|^Every pnpm package needs a registry name|^pnpm declarations must use public registry|^pnpm dependencies must resolve to recorded registry packages/,
    summary: 'a dependency comes from Git, a URL, a local path or a private registry',
    action: REFIT_BUILD,
  },
  {
    reason: 'conflicting-dependency-files',
    pattern: /^Tracked node_modules, conflicting lockfiles, shrinkwrap or pnpm hooks/,
    summary: 'the repository commits dependency files Refit cannot install from',
    action: REFIT_BUILD,
  },
  {
    reason: 'unsupported-lockfile',
    pattern:
      /^Automatic preparation requires a root npm lockfile version 2 or 3|^npm preparation inputs exceed|^Automatic preparation reads dependencies only from the repository root|^Automatic preparation reads a bun\.lock only|^Automatic preparation does not read bunfig\.toml/,
    summary: 'the lockfile is too old, too large or not at the repository root',
    action: REFIT_BUILD,
  },
  {
    reason: 'unsupported-workspace',
    pattern:
      /^Unsupported pnpm settings|^npm workspaces require|^Automatic preparation supports at most 64 committed npm workspace|^Each workspace requires an explicit npm name|^npm links may only target|^Injected, runtime-managed or bundled pnpm|^pnpm configuration dependencies|^Root bundled dependencies/,
    summary: 'the workspace layout or pnpm settings need files the installer does not receive',
    action: REFIT_BUILD,
  },
] as const;

// Baseline checks that fail before the patch for a reason in the repository's setup.
export const BASELINE_STOPS = [
  {
    reason: 'no-tests-found',
    // Jest's, Vitest's and Mocha's own results (Mocha prints its line in red).
    pattern:
      /^No tests found, exiting with code 1|^No test files found, exiting with code 1|^(?:\u001b\[31m)?Error: No test files found\b/m,
    summary: 'the configured test command finds no tests',
    action:
      'Refit ran the test command it selected and found no tests; the draft is published untested. Run your own checks on the draft branch before merging.',
  },
  {
    reason: 'native-build-required',
    pattern: /Could not locate the bindings file|was compiled against a different Node\.js version/,
    summary: 'a dependency needs a native build its install script would run',
    action: `Refit's own preparation installs with install scripts disabled, so native addons are not built. ${REFIT_BUILD}`,
  },
] as const;

export function preparationStop(message: string) {
  return PREPARATION_STOPS.find((stop) => stop.pattern.test(message));
}

export function baselineStop(output: string) {
  return BASELINE_STOPS.find((stop) => stop.pattern.test(output));
}
