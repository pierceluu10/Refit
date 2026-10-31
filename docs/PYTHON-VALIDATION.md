# Python validation

Refit validates a patch on a Python repository the way it validates a Node one: the repository's own checks run on the original code and on the patch in the offline Docker sandbox, and the shared per-check gate (`pipeline/check-gate.ts`) decides. The runner is `pipeline/python/validation.ts`; the AI fallback uses it for every Python patch (`pipeline/ai-fallback-run.ts`).

## The sandbox images

`docker/sandbox.Dockerfile` builds two images, each on a base pinned by digest:

- `--target python`: the image Python repositories validate in. Debian (glibc) from the `node:22-bookworm-slim` digest the hosted worker pins, plus Debian's Python 3.11, venv and pip. It is glibc because most Python packages publish manylinux wheels only: on Alpine (musl), five of the eight dev-set rows that stopped had a pinned package with no wheel at all (for example `contourpy==1.1.1`, `sqlite-vec`), on every Python version.
- the default target: `node:22-alpine`, Refit's Node check image, plus Alpine's Python 3.14 and pip. Node checks behave as on `node:22-alpine`, and a Node repository whose tests or native builds call `python3` now finds it.

```sh
docker build --target python -t refit-sandbox:python-glibc -f docker/sandbox.Dockerfile docker
docker build -t refit-sandbox:python -f docker/sandbox.Dockerfile docker
REFIT_DOCKER_IMAGE=refit-sandbox:python REFIT_PYTHON_IMAGE=refit-sandbox:python-glibc ...
```

Python patches validate in `REFIT_PYTHON_IMAGE`, else in the validation image. On an image without `python3`, Python validation stops with "The validation image … has no python3"; it never falls back to an unchecked pass.

## What runs

1. **Plan** (from committed files only). Dependencies come from the first of `uv.lock`, `poetry.lock`, `Pipfile.lock`, root requirements files (`requirements*.txt`, `*-requirements.txt`, else `requirements/*.txt`), and `pyproject.toml`'s `[project]` dependencies, optional dependencies and `[dependency-groups]`. Checks:
   - **tests**: `python -m pytest -q -rfE -p no:cacheprovider`, when pytest is configured (`pytest.ini`, `conftest.py`, `[tool.pytest]`, `setup.cfg` or `tox.ini`) or test files exist (`test_*.py`, `*_test.py`, `tests/*.py`).
   - **typecheck**: `python -m mypy`, when mypy is configured (`mypy.ini`, `.mypy.ini`, `[tool.mypy]`, `setup.cfg [mypy]`), on its configured `files`, else on the repository's top-level packages and modules.
2. **Prepare** (the only networked step, in the preparation sandbox with `bridge` networking). `pipeline/python/prepare.py` turns the source into one requirements file (`uv export` or `poetry export` at pinned versions for lockfiles, keeping their hashes), installs it into a fresh venv with **wheels only** (`--only-binary=:all:`) on the image's Python, or, when the repository's `requires-python` excludes it or its pins have no release for it, on another CPython (3.12, then 3.13, 3.11, 3.10; at most three interpreters tried; an exact `.python-version` is used alone) that uv installs from its managed builds and that is archived with the venv, adds pytest or mypy at Refit's pinned versions when the repository does not install them, and archives the venv. The repository itself is never installed; editable and local-path lines are dropped. A patch that changes a dependency file is prepared again for the patched side.
3. **Check** (offline, `--network none`, the same controls as every check in [Docker sandbox](SANDBOX.md)). Each check unpacks the venv at the path it was built at and imports the repository from `PYTHONPATH` (the root, plus `src/` in a src layout), so the patched side always runs the patched files.
4. **Gate**. As for Node: a check that passed must still pass; a failing pytest run is compared test by test (every test that passed before must pass after, read from the `-rfE` summary); a mypy run that already reported errors fails only on errors the patch introduced (keyed by file, code and message). At least the tests or the type check must count.

## Stops

Each stop names what Refit could not do: no tests and no mypy configuration (`no-checks`), a dependency with no wheel for any interpreter tried, a lockfile the pinned tool cannot export, an environment over the validation archive limit, or a check that times out. `REFIT_PYTHON_SOURCE_BUILDS=1` lets pip build packages without wheels, which runs their build code in the networked preparation sandbox; it is off by default, as npm lifecycle scripts are.

## Not covered

- Nested Python projects (a `pyproject.toml` below the root) and `setup.py`-only dependency lists, which Refit would have to execute to read.
- Pyright, tox or nox sessions, and test suites that need services (databases, network).
- Proof of a Python request shape: the request-proof gate proves call shapes with the Node SDKs only, so a Python AI patch that passes its checks still stops there ([AI fallback](../pipeline/ai-fallback.ts) `requestProofGate`).

## Tests

`pipeline/python/validation.test.ts` covers the plan, the pytest and mypy readers and the gate on synthetic repositories in `pipeline/fixtures/python-validation` (requirements, uv and Poetry). The Docker cases need the image above and the network for preparation:

```sh
REFIT_PYTHON_DOCKER_IMAGE=refit-sandbox:python-glibc REFIT_DOCKER_IMAGE=node:22-alpine npx vitest run pipeline/python/validation.test.ts
```

CI's Docker suites job builds the image and runs them.
