---
provider: generic
kind: sdk-major
reviewed: false
drafted: 2026-11-02
sources:
  - https://semver.org/
  - https://docs.npmjs.com/cli/commands/npm-deprecate
  - https://peps.python.org/pep-0592/
  - https://peps.python.org/pep-0440/
---

# SDK major version upgrade (any provider)

_General advice for any provider. Where the provider's own docs say otherwise, follow them._

**What usually changes.** Under [semver](https://semver.org/) a new major may break anything public: renamed or removed methods and classes, a new client constructor, changed option names, async where it was sync, new error classes, dropped support for old runtimes, and a different API version pinned by default. Generated SDKs often change type names and nesting.

**How to spot it in code.** Read the lockfile for the exact installed version, not the manifest range (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `uv.lock`, `requirements*.txt`). Find every import of the SDK and every place it is constructed or extended. Code that subclasses, mocks or patches SDK internals breaks most often. Check the runtime pins too: `engines`, `.nvmrc`, `python_requires`, CI images.

**What to check.**

- `package_lookup` with `name`, `version` (the pinned one) and, if you have one, `target`. It lists each major with dates, deprecated or yanked versions ([npm deprecate](https://docs.npmjs.com/cli/commands/npm-deprecate), [PEP 592](https://peps.python.org/pep-0592/)), the runtime the latest needs, and the release notes in between with majors first. Add `query` with a method name to rank the notes.
- Read the migration guide the notes link to with `fetch_changelog` or `search_docs`.
- Change the dependency with the repo's own package manager (`install` or `shell`), let it rewrite the lockfile, then run `run_checks`. The type check usually finds renamed members fastest.

**Pitfalls.** Moving several majors at once mixes many breaking changes; read each major's notes, oldest first. A new major may need a newer runtime than CI has. Peer dependencies and plugins built for the old major may not install. Default timeouts, retries and pagination can change silently.

**When you're unsure.** Upgrade to the lowest version that fixes the problem in the task, change what the notes and the type check point to, and list in the PR the behaviour you could not prove (for example, retry or streaming changes).
