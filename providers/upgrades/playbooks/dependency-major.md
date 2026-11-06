---
provider: upgrades
kind: dependency-major
reviewed: false
drafted: 2026-11-06
sources:
  - https://semver.org/
  - https://docs.npmjs.com/about-semantic-versioning
  - https://docs.npmjs.com/cli/v11/configuring-npm/package-json
  - https://packaging.python.org/en/latest/specifications/version-specifiers/
---

Under [semantic versioning](https://semver.org/) a major bump means incompatible API changes, and `0.y.z` means anything may change. Not every package follows it, so treat the version number as a signal and the release notes as the evidence.

**What usually breaks.** Renamed or removed exports and methods, changed defaults, new `engines` or `requires_python` minimums, ESM-only packages, tighter types, and changed error classes that existing `catch` or `except` clauses no longer match. Transitive conflicts are common too, when a peer dependency has to move in step.

**How to spot it in code.** Grep imports of the package, including subpath imports, dynamic imports and re-exports, then read each call site against the release notes. Don't forget test helpers, mocks, type augmentations and config files that name the package. Lockfiles show which version is really resolved, which can differ from the manifest's range.

**What to check.**

- `registry_diff` lists what changed between two versions: `engines`, peers, dependencies and listed breaking changes.
- `migration_guide` finds the official guide and changelog passages, with links.
- `codemod` shows any known official codemod.
- Update through the package manager so the lockfile stays right, and run the checks before and after, counting only new failures.
- Read the [`peerDependencies`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json) warnings the install prints. They often name the next thing to move.

**Common pitfalls.**

- Editing the manifest by hand and leaving the lockfile behind.
- Ranges that hide the change. `^2` stays inside major 2, and a Python [compatible release](https://packaging.python.org/en/latest/specifications/version-specifiers/) clause (`~=`) has similar limits; widen the range deliberately, and check that any upper bound in `pyproject.toml` or `requirements*.txt` moved too.
- Mocks that keep tests green. If a test stubs the package, a passing run says little about the new API, so read those call sites and flag them in the PR.
- Type-only passes. A clean `tsc` doesn't cover runtime defaults or changed error handling.
- Forcing the install past a peer conflict. If you do it to make progress, say so in the PR with the conflict named.
- Monorepos: more than one package may declare the dependency. Update each, or say why one stays behind.

**When you're unsure.** Make the change, keep behaviour the same where you can, and name each call site you couldn't prove under what's unproven.
