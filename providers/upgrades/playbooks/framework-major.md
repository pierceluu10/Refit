---
provider: upgrades
kind: framework-major
reviewed: false
drafted: 2026-11-06
sources:
  - https://semver.org/
  - https://nextjs.org/docs/app/guides/upgrading/version-16
  - https://nextjs.org/docs/app/guides/upgrading/version-15
  - https://docs.djangoproject.com/en/stable/releases/6.0/
  - https://docs.djangoproject.com/en/stable/howto/upgrade-version/
---

A framework major touches more than a library major: it owns your routing, build, config and often your runtime minimum. Most of the breakage comes from conventions rather than function signatures, so a type check catches only part of it.

**What usually breaks.** Runtime and language minimums; peer dependencies that must move together (Next.js 15 needed React 19, for example); default behaviour that flips without any code error; removed config keys and renamed files; and plugins or middleware that haven't caught up. Next.js 15 stopped caching `fetch` by default ([guide](https://nextjs.org/docs/app/guides/upgrading/version-15)); Django 6.0 changed the `DEFAULT_AUTO_FIELD` default ([notes](https://docs.djangoproject.com/en/stable/releases/6.0/)). Neither shows up as a failed compile.

**How to spot it in code.** Start from the guide's list and grep for each removed name. Then read config files, custom middleware, framework subclasses and anything importing from framework internals. Check the build scripts too, since flags get renamed or removed.

**What to check.**

- `migration_guide` returns the official guide and changelog passages between two versions; read them all, not just the summary.
- `codemod` lists official codemods and how to run them in the sandbox. Run them first, in a separate commit if you can, so the mechanical diff stays apart from your judgement calls. Read the output: a codemod can leave placeholders for you to resolve.
- `registry_diff` shows peer, engine and dependency changes between the versions.
- `end_of_life` shows which of the framework's lines are still supported.
- Run the build as well as the tests. For web apps, start the server if you can and load a page.

**Common pitfalls.**

- Jumping several majors at once. Django's guide recommends going [one feature release at a time](https://docs.djangoproject.com/en/stable/howto/upgrade-version/), and that usually makes failures easier to attribute. The final diff can still be one PR.
- Silent behaviour changes: caching, defaults and security headers. Tests won't catch them, so list each one that applies under behaviour changes in the PR.
- Trusting a codemod's "done". The Next.js 16 guide says its upgrade codemod [does not run every migration codemod](https://nextjs.org/docs/app/guides/upgrading/version-16).
- A third-party plugin with no release for the new major. Try it anyway, note what you found, and raise it in the PR.
- Assuming semver. Read the release notes rather than the version number.

**When you're unsure.** Pick the smallest target that clears the deadline or the newest supported major, say why, and name what you couldn't exercise.
