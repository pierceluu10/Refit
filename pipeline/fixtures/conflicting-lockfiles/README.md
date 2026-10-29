# Conflicting lockfiles

Lockfiles written by the package managers themselves on 2026-10-28 for `package.json` (`stripe ^15.12.0`), kept byte for byte (listed in `.prettierignore`). The registry was `https://registry.npmjs.org`, with lifecycle scripts off.

- `package-lock.json`: npm 11.9.0, `npm install --package-lock-only --before=2024-07-01` (locks stripe 15.12.0).
- `stale-package-lock.json`: the same for `stripe ^14.25.0` (locks stripe 14.25.0), so it is out of sync with `package.json`.
- `yarn.lock`: Yarn 1.22.22, `yarn install --ignore-scripts` (locks stripe 15.12.0).
- `pnpm-lock.yaml`: pnpm 9.15.9, `pnpm install --lockfile-only --ignore-scripts` (locks stripe 15.12.0).

`pipeline/dependency-inputs.test.ts` commits them in different combinations and orders to test which one `chosenLockfile` picks.
