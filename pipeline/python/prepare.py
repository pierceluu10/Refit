"""Prepares a Python repository's dependencies for Refit's offline checks (python-validation.ts).

Runs inside the preparation sandbox, the only step with network: it reads the dependency source the
plan names (uv.lock, poetry.lock, Pipfile.lock, requirements files or pyproject.toml), writes one
requirements file, installs it into a fresh venv at /workspace/.refit-python with wheels only (no
package's build code runs unless the plan allows source builds), on the image's Python or, when the
repository's requires-python or pins rule that out, another uv-managed CPython (archived with the
venv), adds the check runners the
repository does not declare (pytest, mypy, at Refit's pinned versions), and archives the venv to
/installer-cache/python.tar. The checks later unpack it at the same path and run with no network.
The repository itself is never installed: the checks import its source from PYTHONPATH, so the
patched side always runs the patched files.

Prints one JSON line on stdout: {"python": ..., "installed": [...], "runners": [...]}. A failure
exits 2 with a one-line reason on stderr that the caller names as a preparation stop.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tomllib

VENV = "/workspace/.refit-python"
TOOLS = "/workspace/.refit-tools"
REQUIREMENTS = "/workspace/.refit-requirements.txt"
ARCHIVE = "/installer-cache/python.tar"


PYTHONS = "/workspace/.refit-pythons"
# Interpreters tried after the image's own Python when the dependencies do not install on it, filtered
# by what the repository declares. At most MAX_INTERPRETERS are tried.
OTHER_PYTHONS = ["3.12", "3.13", "3.11", "3.10"]
MAX_INTERPRETERS = 3
# pip's answers that another Python could change: no release or wheel for this one, or a resolution
# that fails because of the releases this Python may install.
VERSION_BOUND = re.compile(
    r"Requires-Python|requires a different [Pp]ython|No matching distribution|"
    r"Could not find a version|ResolutionImpossible"
)


class Failure(Exception):
    pass


def stop(reason):
    sys.stderr.write(f"refit-python-stop: {reason}\n")
    sys.exit(2)


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        lines = (result.stderr or result.stdout).strip().splitlines()
        # pip's decisive lines, without its long lists of ignored releases.
        errors = [line for line in lines if line.startswith("ERROR") and "Ignored the following" not in line]
        tail = [line[:300] for line in (errors or lines)[-3:]]
        raise Failure(f"`{' '.join(args[:4])}` exited {result.returncode}: " + " | ".join(tail))
    return result.stdout


def declared_pythons():
    """The interpreters to try: an exact .python-version alone, else the image's Python and the
    others that requires-python (pyproject.toml or uv.lock) allows."""
    if os.path.exists(".python-version"):
        with open(".python-version") as handle:
            match = re.match(r"\s*(?:cpython-|python)?(3\.\d+)", handle.read())
        if match:
            return [match.group(1)]
    spec = None
    for path in ("pyproject.toml", "uv.lock"):
        try:
            with open(path, "rb") as handle:
                data = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError):
            continue
        spec = (data.get("project") or {}).get("requires-python") or data.get("requires-python")
        if spec:
            break
    own = f"{sys.version_info.major}.{sys.version_info.minor}"
    candidates = ["system"] + [version for version in OTHER_PYTHONS if version != own]
    if spec:
        try:
            from pip._vendor.packaging.specifiers import SpecifierSet

            allowed = SpecifierSet(spec)
            candidates = [c for c in candidates if f"{own if c == 'system' else c}.0" in allowed]
        except Exception:
            pass
    return candidates[:MAX_INTERPRETERS]


def interpreter(version):
    # Other interpreters are uv's managed CPython builds, kept under /workspace and archived with the
    # venv so the offline checks find them at the same path.
    if version == "system":
        return sys.executable
    tool([f"uv=={PLAN['versions']['uv']}"])
    environment = {**os.environ, "UV_PYTHON_INSTALL_DIR": PYTHONS, "UV_PYTHON_PREFERENCE": "only-managed"}
    run([f"{TOOLS}/bin/uv", "python", "install", "--quiet", version], env=environment)
    return run([f"{TOOLS}/bin/uv", "python", "find", version], env=environment).strip()


def tool(packages):
    # uv and Poetry only export their lockfile; they run in a venv that is never archived.
    if not os.path.exists(TOOLS):
        run([sys.executable, "-m", "venv", TOOLS])
    run([f"{TOOLS}/bin/python", "-m", "pip", "install", "--quiet", "--only-binary=:all:", *packages])


def name_of(requirement):
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", requirement)
    return re.sub(r"[-_.]+", "-", match.group(1)).lower() if match else None


def pipfile_lock(path):
    with open(path) as handle:
        lock = json.load(handle)
    lines = []
    for section in ("default", "develop"):
        for name, entry in (lock.get(section) or {}).items():
            if not isinstance(entry, dict):
                continue
            if "version" not in entry:
                stop(f"Pipfile.lock pins {name} without a version (a path, Git or editable source).")
            line = f"{name}{entry['version']}"
            if entry.get("markers"):
                line += f" ; {entry['markers']}"
            lines.append(line + "".join(f" --hash={value}" for value in entry.get("hashes", [])))
    return lines


def requirements_file(path, seen):
    # Nested -r files are read inline, so an editable line in any of them is dropped below. A -c
    # constraints file only narrows versions and is not read.
    real = os.path.realpath(path)
    if real in seen or not real.startswith("/workspace/"):
        return []
    seen.add(real)
    lines = []
    with open(path) as handle:
        for line in handle.read().splitlines():
            nested = re.match(r"\s*(-r|--requirement)[\s=]+(\S+)", line)
            if re.match(r"\s*(-c|--constraint)[\s=]", line):
                continue
            if nested:
                lines += requirements_file(os.path.join(os.path.dirname(path), nested.group(2)), seen)
            else:
                lines.append(line)
    return lines


def pyproject(path):
    with open(path, "rb") as handle:
        data = tomllib.load(handle)
    project = data.get("project") or {}
    lines = list(project.get("dependencies") or [])
    for extra in (project.get("optional-dependencies") or {}).values():
        lines += extra
    own = name_of(project.get("name") or "")
    for group in (data.get("dependency-groups") or {}).values():
        for item in group:
            if isinstance(item, str):
                lines.append(item)
    # A self-reference (`pkg[test]` in pkg's own extras) is the project, which is never installed.
    return [line for line in lines if name_of(line) != own]


PLAN = {}


def main():
    plan = json.loads(sys.argv[1])
    PLAN.update(plan)
    source = plan["source"]
    os.makedirs(os.environ["TMPDIR"], exist_ok=True)
    if source == "uv":
        tool([f"uv=={plan['versions']['uv']}"])
        run([f"{TOOLS}/bin/uv", "export", "--frozen", "--format", "requirements-txt", "--all-extras",
             "--all-groups", "--no-emit-workspace", "--no-header", "--output-file", REQUIREMENTS],
            env={**os.environ, "UV_NO_CONFIG": "1", "UV_OFFLINE": "1"})
    elif source == "poetry":
        tool([f"poetry=={plan['versions']['poetry']}",
              f"poetry-plugin-export=={plan['versions']['poetryExport']}"])
        run([f"{TOOLS}/bin/poetry", "export", "--format", "requirements.txt", "--all-groups",
             "--all-extras", "--output", REQUIREMENTS],
            env={**os.environ, "POETRY_VIRTUALENVS_CREATE": "false", "POETRY_NO_INTERACTION": "1"})
    else:
        lines = []
        if source == "pipenv":
            lines = pipfile_lock("Pipfile.lock")
        elif source == "pyproject":
            lines = pyproject("pyproject.toml")
        else:
            seen = set()
            for path in plan["requirements"]:
                lines += requirements_file(path, seen)
        with open(REQUIREMENTS, "w") as handle:
            handle.write("\n".join(lines) + "\n")
    # Only a lockfile's own entries; an editable or local path is the repository, never installed.
    with open(REQUIREMENTS) as handle:
        kept = [line for line in handle.read().splitlines()
                if not re.match(r"\s*(-e\s|--editable\s|\.\.?/|file:)", line)]
    with open(REQUIREMENTS, "w") as handle:
        handle.write("\n".join(kept) + "\n")

    tried = []
    for version in declared_pythons():
        try:
            # uv links a minor version to its patch release; the venv and archive use the release.
            python = os.path.realpath(interpreter(version))
            shutil.rmtree(VENV, ignore_errors=True)
            run([python, "-m", "venv", VENV])
            install(plan, kept)
            break
        except Failure as failure:
            tried.append(f"Python {version}: {failure}")
            if not VERSION_BOUND.search(str(failure)):
                break
    else:
        tried.append("no interpreter left to try")
    if not os.path.exists(f"{VENV}/.refit-ready"):
        raise Failure(" || ".join(tried) if tried else "No interpreter matches requires-python.")
    installed = {
        name_of(entry["name"]): entry["version"]
        for entry in json.loads(run([f"{VENV}/bin/python", "-m", "pip", "list", "--format", "json"]))
    }
    version = run([f"{VENV}/bin/python", "-c", "import sys; print(sys.version.split()[0])"]).strip()
    home = os.path.realpath(python)
    with tarfile.open(ARCHIVE, "w") as archive:
        archive.add(VENV, arcname=".refit-python")
        if home.startswith(PYTHONS + "/"):
            root = home[len(PYTHONS) + 1:].split("/")[0]
            archive.add(f"{PYTHONS}/{root}", arcname=f".refit-pythons/{root}")
    print(json.dumps({"python": version, "installed": sorted(installed), "runners": RUNNERS,
                      "tried": len(tried) + 1}))


RUNNERS = []


def install(plan, kept):
    pip = [f"{VENV}/bin/python", "-m", "pip", "install", "--quiet", "--no-input"]
    if not plan.get("sourceBuilds"):
        pip.append("--only-binary=:all:")
    if any(line.strip() and not line.lstrip().startswith("#") for line in kept):
        run(pip + ["-r", REQUIREMENTS])
    installed = {
        name_of(entry["name"])
        for entry in json.loads(run([f"{VENV}/bin/python", "-m", "pip", "list", "--format", "json"]))
    }
    RUNNERS.clear()
    for runner in plan["runners"]:
        if runner not in installed:
            run(pip + [f"{runner}=={plan['versions'][runner]}"])
            RUNNERS.append(runner)
    open(f"{VENV}/.refit-ready", "w").close()


if __name__ == "__main__":
    try:
        main()
    except Failure as failure:
        stop(str(failure))
