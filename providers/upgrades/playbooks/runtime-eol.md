---
provider: upgrades
kind: runtime-eol
reviewed: false
drafted: 2026-11-06
sources:
  - https://nodejs.org/en/about/eol
  - https://nodejs.org/en/about/previous-releases
  - https://devguide.python.org/versions/
---

A runtime reaching end of life rarely breaks on the day. The risk builds: once a line is past its date it gets no more patches ([Node.js EOL](https://nodejs.org/en/about/eol), [Python versions](https://devguide.python.org/versions/)), and packages gradually drop it. The upgrade itself is mostly a matter of finding every place the version is declared, then fixing what the new runtime removed.

**What usually breaks.** Removed standard-library APIs and modules, stricter validation, native add-ons that need a rebuild, stricter crypto defaults, and dependencies whose newest versions need a different runtime, or whose old versions don't install on the new one.

**How to spot it in code.** The version is rarely in one place. Look at `engines`, `.nvmrc`, `.node-version`, `.python-version`, `pyproject.toml`, `setup.cfg`, `runtime.txt`, Dockerfile `FROM` lines, CI matrices and `setup-node` / `setup-python` inputs, serverless config, and docs that tell people what to install. A task usually carries `declaredIn`, but it can miss some, so grep as well. Then grep for what the release notes say was removed.

**What to check.**

- `end_of_life` gives the date, the supported lines and a suggested target for a product and version. Treat the target as a hint; a repo pinned by a host or a base image may have reasons to land elsewhere.
- Run the checks on the old version first, so you can count only new failures, then on the target.
- Read the runtime's own migration notes for every major you cross. `registry_diff` shows when a dependency's `engines` or `requires_python` moved; `migration_guide` finds its notes.
- Turn deprecation warnings on while the tests run; they often name the next break.

**Common pitfalls.**

- Bumping the manifest but not the Dockerfile or CI, so tests still run on the old runtime and "pass" proves nothing. Confirm which version actually ran.
- Skipping the lockfile. Regenerate it on the target runtime with the repo's package manager.
- Picking a line that is about to expire. Prefer a release with a long support window; Node.js says production apps should use only Active or Maintenance LTS lines ([releases](https://nodejs.org/en/about/previous-releases)).
- Tests that pass with low coverage. Say in the PR what the checks don't exercise, such as native modules or deployed-only paths.

**When you're unsure.** Make the bump everywhere you can find, run what can run, and put what's unproven in the PR. See the Node and Python notes for specifics.
