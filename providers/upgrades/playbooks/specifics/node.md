---
provider: upgrades
kind: specific
reviewed: false
drafted: 2026-11-06
sources:
  - https://nodejs.org/en/about/previous-releases
  - https://nodejs.org/en/about/eol
  - https://nodejs.org/en/blog/migrations/v20-to-v22
  - https://nodejs.org/en/blog/migrations/v22-to-v24
  - https://nodejs.org/api/deprecations.html
---

# Node.js upgrades

**Choosing a target.** On 2026-11-06 the [releases page](https://nodejs.org/en/about/previous-releases) lists v26, v24 and v22 as LTS, and v25 and earlier odd lines as EOL; the [EOL page](https://nodejs.org/en/about/eol) includes v20. Node 24 is [supported through the end of April 2028](https://nodejs.org/en/blog/migrations/v22-to-v24). From Node 27 the cycle becomes annual, and every major moves to LTS. Check today's state with `end_of_life`, and remember a host or base image may limit what's available.

**What usually breaks.**

- Removed APIs, tracked as `DEP` numbers in the [deprecations list](https://nodejs.org/api/deprecations.html). Node 22 removed `crypto.createCipher()` and `createDecipher()`, and the `import ... assert` syntax in favour of `with` ([v20 to v22](https://nodejs.org/en/blog/migrations/v20-to-v22)). Node 23 removed `process.assert`.
- Crypto strictness. Node 24 ships OpenSSL 3.5 at security level 2, which [prohibits RSA, DSA and DH keys under 2048 bits, ECC keys under 224 bits, and RC4 suites](https://nodejs.org/en/blog/migrations/v22-to-v24). This hits old internal certificates, and tests usually won't see it.
- Stricter `fetch()`, `AbortSignal` validation, stream and pipe errors, and `Buffer` changes, all [listed for v24](https://nodejs.org/en/blog/migrations/v22-to-v24).
- Native add-ons. Those linking against V8 APIs may need updates and C++20. `node-gyp` failures during install are the usual sign. Prefer newer releases of the add-on.
- Platforms. There are no pre-built v24 binaries for 32-bit Linux on armv7 or 32-bit Windows, and macOS binaries need 13.5 or later.

**How to spot it.** Set `NODE_OPTIONS=--trace-deprecation` during tests, and grep for the `DEP` APIs above. Check `engines`, `.nvmrc`, `.node-version`, `volta` and `packageManager` keys, Dockerfiles, CI matrices and serverless runtimes. Dependencies' own `engines` show up through `registry_diff`.

**Codemods.** The Node.js project publishes [userland migration codemods](https://nodejs.org/en/blog/migrations/v22-to-v24) such as `npx codemod run @nodejs/process-assert-to-node-assert`; the `codemod` tool lists them. The project says the set is incomplete, so a clean run isn't proof. Run them only in the sandbox.

**Pitfalls.**

- Crossing several majors at once: read the migration page for each step, because each lists only its own changes.
- A lockfile written on the old version can carry native binaries for it. Regenerate in the sandbox on the target.
- Test runners, bundlers and TypeScript targets often need their own bumps; `tsconfig` `target` and `lib` may move with the runtime.
- If a major's migration page is missing (v18 to v20 wasn't checked for this note), rely on the `DEP` list and the release changelog, and say so in the PR.
