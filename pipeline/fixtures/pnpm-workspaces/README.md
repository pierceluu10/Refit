# pnpm workspace conformance inputs

Tests reuse the existing npm-workspace application and Stripe simulator, changing only package-manager declarations, explicit workspace links and catalog references. Application source and contracts are shared.

Locks were generated in restricted Docker using pnpm 9.15.4, 10.17.1, 11.28.5 and 12.4.2, public registry access and `--ignore-scripts`. pnpm 9 and 10 emitted identical bytes and share `pnpm-v9.yaml`. The pnpm 11 graph records a different transitive qs version. pnpm 12 retains its separate manager-environment document. These are generated files, not hand-written resolver fixtures.

The root requires Stripe 19.1.0; billing requires 10.17.0 through a named catalog, TypeScript through the default catalog, and a local workspace through `workspace:*`. Lifecycle scripts are deliberate tripwires. Tests prepare frozen dependencies, preserve both SDK resolutions and links, retain the pinned manager for offline commands, and pass original/changed Stripe contracts and TypeScript while leaving source unmigrated. API responses are simulated.
