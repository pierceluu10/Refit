# Yarn lockfile inputs

`classic.lock` and `berry.lock` were generated from `package.json` in restricted Docker (`node:22-alpine`) with Yarn 1.22.22 (`--ignore-scripts`) and Yarn 4.9.2 (`--mode=update-lockfile`), using public registry access. They are generated files, not hand-written. Tests copy each one to a temporary repository as `yarn.lock`.
