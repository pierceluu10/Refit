// Named stops for dependency preparation and baseline checks that Refit cannot fix itself. Each
// tells the repository owner the exact change to make, in .refit.json or in the repository, and
// is matched on the message Refit or the package manager raises. See docs/PREPARATION-FAILURES.md.

const CUSTOM_IMAGE =
  'In .refit.json, remove "prepareDependencies", set "image" to a local image that already has this repository\'s dependencies installed (for example in /opt/app/node_modules), and start "command" and "baselineCommand" with "ln -s /opt/app/node_modules node_modules && ".';

export const PREPARATION_STOPS = [
  {
    reason: 'dependency-tree-too-large',
    pattern: /^Dependency archive exceeds \d+ MiB|^\w+ dependency preparation ran out of space/,
    summary: "the installed dependencies do not fit Refit's validation sandbox",
    action: `${CUSTOM_IMAGE} Dependencies inside the image do not count against the sandbox workspace.`,
  },
  {
    reason: 'non-registry-dependency',
    pattern:
      /^Automatic preparation supports public npm registry dependencies only|^Package tarballs must use public registry\.npmjs\.org|^Every pnpm package needs a registry name|^pnpm declarations must use public registry|^pnpm dependencies must resolve to recorded registry packages/,
    summary: 'a dependency comes from Git, a URL, a local path or a private registry',
    action: `Depend on a version published to registry.npmjs.org instead, or: ${CUSTOM_IMAGE}`,
  },
  {
    reason: 'conflicting-dependency-files',
    pattern: /^Tracked node_modules, conflicting lockfiles, shrinkwrap or pnpm hooks/,
    summary: 'the repository commits dependency files Refit cannot install from',
    action: `Make the change the message names in the repository and commit it, or: ${CUSTOM_IMAGE}`,
  },
  {
    reason: 'unsupported-lockfile',
    pattern:
      /^Automatic preparation requires a root npm lockfile version 2 or 3|^npm preparation inputs exceed|^Automatic preparation reads dependencies only from the repository root/,
    summary: 'the lockfile is too old, too large or not at the repository root',
    action: `Commit a root package-lock.json written by npm 7 or later (lockfile version 2 or 3, at most 20,000 packages), or: ${CUSTOM_IMAGE}`,
  },
  {
    reason: 'unsupported-workspace',
    pattern:
      /^Unsupported pnpm settings|^npm workspaces require|^Automatic preparation supports at most 64 committed npm workspace|^Each workspace requires an explicit npm name|^npm links may only target|^Injected, runtime-managed or bundled pnpm|^pnpm configuration dependencies|^Root bundled dependencies/,
    summary: 'the workspace layout or pnpm settings need files the installer does not receive',
    action: CUSTOM_IMAGE,
  },
] as const;

// Baseline checks that fail before the patch for a reason in the repository's setup.
export const BASELINE_STOPS = [
  {
    reason: 'no-tests-found',
    pattern: /^No tests found, exiting with code 1|^No test files found, exiting with code 1/m,
    summary: 'the configured test command finds no tests',
    action:
      'In .refit.json, set "command" and "baselineCommand" to checks this repository has, for example its type check (["npx", "--no-install", "tsc", "--noEmit"]).',
  },
  {
    reason: 'native-build-required',
    pattern: /Could not locate the bindings file|was compiled against a different Node\.js version/,
    summary: 'a dependency needs a native build its install script would run',
    action: `Refit installs with install scripts disabled, so native addons are not built. ${CUSTOM_IMAGE}`,
  },
] as const;

export function preparationStop(message: string) {
  return PREPARATION_STOPS.find((stop) => stop.pattern.test(message));
}

export function baselineStop(output: string) {
  return BASELINE_STOPS.find((stop) => stop.pattern.test(output));
}
