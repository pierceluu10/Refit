"""Prepares a Python repository's dependencies for Refit's offline checks (python-validation.ts).

Runs inside the preparation sandbox, the only step with network: it reads the dependency source the
plan names (uv.lock, poetry.lock, Pipfile.lock, requirements files or pyproject.toml), writes one
requirements file, installs it into a fresh venv at /workspace/.refit-python with wheels only (no
package's build code runs unless the plan allows source builds), adds the check runners the
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
import subprocess
import sys
import tarfile
import tomllib

VENV = "/workspace/.refit-python"
TOOLS = "/workspace/.refit-tools"
REQUIREMENTS = "/workspace/.refit-requirements.txt"
ARCHIVE = "/installer-cache/python.tar"


def stop(reason):
    sys.stderr.write(f"refit-python-stop: {reason}\n")
    sys.exit(2)


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout).strip().splitlines()[-12:]
        stop(f"`{' '.join(args[:4])}` exited {result.returncode}: " + " | ".join(tail)[-1500:])
    return result.stdout


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


def main():
    plan = json.loads(sys.argv[1])
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

    run([sys.executable, "-m", "venv", VENV])
    pip = [f"{VENV}/bin/python", "-m", "pip", "install", "--quiet", "--no-input"]
    if not plan.get("sourceBuilds"):
        pip.append("--only-binary=:all:")
    if any(line.strip() and not line.lstrip().startswith("#") for line in kept):
        run(pip + ["-r", REQUIREMENTS])
    installed = {
        name_of(entry["name"]): entry["version"]
        for entry in json.loads(run([f"{VENV}/bin/python", "-m", "pip", "list", "--format", "json"]))
    }
    runners = []
    for runner in plan["runners"]:
        if runner not in installed:
            run(pip + [f"{runner}=={plan['versions'][runner]}"])
            runners.append(runner)
    version = run([f"{VENV}/bin/python", "-c", "import sys; print(sys.version.split()[0])"]).strip()
    with tarfile.open(ARCHIVE, "w") as archive:
        archive.add(VENV, arcname=".refit-python")
    print(json.dumps({"python": version, "installed": sorted(installed), "runners": runners}))


if __name__ == "__main__":
    main()
