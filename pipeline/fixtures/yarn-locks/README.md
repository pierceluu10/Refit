# Yarn lockfile inputs

`classic.lock` and `berry.lock` were generated from `package.json` in restricted Docker (`node:22-alpine`) with Yarn 1.22.22 (`--ignore-scripts`) and Yarn 4.9.2 (`--mode=update-lockfile`), using public registry access. They are generated files, not hand-written. Tests copy each one to a temporary repository as `yarn.lock`.

`workspaces.lock` was generated the same way with Yarn 1.22.22 from the manifests of [`../npm-workspaces/repository`](../npm-workspaces/repository): Stripe 19.1.0 at the root, Stripe 10.17.0 nested in `packages/billing`, and a `*` link to the sibling `@refit-fixture/ids` workspace.
