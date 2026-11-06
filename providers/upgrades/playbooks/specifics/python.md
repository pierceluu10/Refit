---
provider: upgrades
kind: specific
reviewed: false
drafted: 2026-11-06
sources:
  - https://devguide.python.org/versions/
  - https://docs.python.org/3/whatsnew/3.12.html
  - https://docs.python.org/3/whatsnew/3.13.html
  - https://docs.python.org/3/whatsnew/3.14.html
---

# Python upgrades

**Choosing a target.** The [status page](https://devguide.python.org/versions/) shows 3.9 reached end of life on 2025-10-31 and 3.10 on 2026-10-01. 3.11 to 3.13 are security-only, with end-of-life dates from 2027-10 to 2029-10, and 3.14 and 3.15 are in bugfix. Security-only versions get no new binaries, so check that your host and base image provide them. `end_of_life` gives the current view. The newest version isn't always the best target: compiled dependencies may lag, so see what wheels exist before committing.

**What usually breaks.** Python removes modules, so imports fail outright rather than warn.

- 3.12: [`distutils` is gone](https://docs.python.org/3/whatsnew/3.12.html), as are `asynchat`, `asyncore` and `imp`, along with several `unittest.TestCase` method aliases. `venv` no longer pre-installs `setuptools`, so `pkg_resources` can vanish from a fresh environment.
- 3.13: the [PEP 594 "dead batteries"](https://docs.python.org/3/whatsnew/3.13.html) are removed, including `cgi`, `cgitb`, `telnetlib`, `aifc`, `audioop`, `chunk`, `spwd`, `sunau`, `uu` and `xdrlib`. `2to3` and `lib2to3` are removed too. The page gives replacements.
- 3.14: [annotations are evaluated lazily](https://docs.python.org/3/whatsnew/3.14.html) (PEP 649 and 749), which matters to anything reading annotations at runtime: ORMs, dependency injection, serializers. It has a [porting section](https://docs.python.org/3/whatsnew/3.14.html) of its own.
- Deprecations to clear on the way: [`datetime.utcnow()` and `utcfromtimestamp()`](https://docs.python.org/3/whatsnew/3.12.html).

**How to spot it.** Run tests with `python -W error::DeprecationWarning` or `-Wa` to see what's coming. Grep for the removed module names, including in vendored code and `conftest.py`. The version lives in `.python-version`, `pyproject.toml` (`requires-python`, tool targets such as ruff and mypy), `setup.cfg`, `runtime.txt`, `tox.ini`, Dockerfiles and CI matrices.

**What to check.**

- Reinstall from scratch in the sandbox on the target version. The resolver's failures name what can't move; `registry_diff` shows each package's `requires_python`.
- `migration_guide` for packages that must jump a major to reach the new Python.
- Read the "What's New" page for every version you cross, because each one covers only its own changes.

**Pitfalls.**

- `requires-python` upper bounds, in the repo or in a dependency, that block the install.
- Compiled packages with no wheel for the target. A source build may need system libraries the image lacks.
- Lockfiles (`poetry.lock`, `uv.lock`, pinned `requirements*.txt`) that carry environment markers for the old version. Regenerate with the tool the repo uses.
- Linter and formatter targets that keep enforcing the old syntax.
- Pickled data or cached bytecode shipped with the app. Regenerate or flag it.
