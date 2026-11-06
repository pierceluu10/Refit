---
provider: upgrades
kind: specific
reviewed: false
drafted: 2026-11-06
sources:
  - https://nextjs.org/docs/app/guides/upgrading/version-15
  - https://nextjs.org/docs/app/guides/upgrading/version-16
  - https://nextjs.org/docs/app/guides/upgrading/codemods
---

# Next.js upgrades

**Start with the codemods.** The [upgrade codemod](https://nextjs.org/docs/app/guides/upgrading/codemods) moves Next.js, React and React DOM and applies the relevant transforms: `npx @next/codemod upgrade latest`. Single transforms run as `npx @next/codemod <transform> <path>`, and `--dry` previews them. The `codemod` tool lists these. Run them in the sandbox only. The [16 guide](https://nextjs.org/docs/app/guides/upgrading/version-16) warns that the upgrade codemod doesn't run every migration codemod, so apps with leftover sync access also need `next-async-request-api`.

**What breaks going to 15** ([guide](https://nextjs.org/docs/app/guides/upgrading/version-15)).

- `react` and `react-dom` must be at least 19; TypeScript users also move `@types/react` and `@types/react-dom`.
- `cookies`, `headers`, `draftMode`, `params` and `searchParams` become async.
- Caching flips: `fetch` requests and `GET` Route Handlers are no longer cached by default. Nothing errors, so this is a behaviour change to put in the PR, and you may need `cache: 'force-cache'` where the old behaviour mattered.

**What breaks going to 16** ([guide](https://nextjs.org/docs/app/guides/upgrading/version-16)).

- The minimums are Node.js 20.9 and TypeScript 5.1.
- Synchronous request APIs are fully removed.
- Turbopack is the default for `dev` and `build`. A custom webpack config makes `next build` fail, on purpose. Your choices are to migrate the config, or pass `--webpack`. `experimental.turbopack` moves to top-level `turbopack`.
- `middleware` becomes `proxy`, in both file and function name, and config flags follow (`skipMiddlewareUrlNormalize` becomes `skipProxyUrlNormalize`).
- `next lint` is gone and `next build` no longer lints, so add a lint step to CI if the build was your only one. `eslint-config-next@16` needs ESLint 9 or later.
- Parallel route slots need explicit `default.js` files or builds fail.
- `next/image`: `images.minimumCacheTTL` defaults to 4 hours rather than 60 seconds, `images.qualities` now limits `quality`, `next/legacy/image` is deprecated. AMP is removed.

**How to spot it.** Read `next.config.*` closely; most of the 16 changes live there. Search for `useAmp`, `next/legacy/image`, `middleware.ts`, and sync uses of the request APIs. Look at `package.json` scripts for `--turbopack`, and at `.nvmrc`, Dockerfile and CI for the Node minimum. Peer dependency warnings often point to libraries that haven't caught up.

**Pitfalls.**

- Upgrading from 14 straight to 16. Read both guides, since the 15 changes still apply.
- A clean build that hides the caching change. Tests rarely cover staleness, so name affected data fetches for a human.
- Codemod output that keeps sync access through `UnsafeUnwrappedCookies`-style casts: these are the 15 compatibility shim, and 16 removes the behaviour.
- Hosting: check that the deploy target's Node version moves too.
