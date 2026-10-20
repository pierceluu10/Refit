# Configured shared-client aliases

Refit reads `paths` and `baseUrl` from the nearest scanned `tsconfig.json` or `jsconfig.json`. TypeScript configuration wins when both exist in the same directory. The same resolver serves SDK clients and supported wrappers, mutation evidence, declared API versions and imported read-only AI context.

```json
{
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"] }
  }
}
```

```ts
// src/client.ts
import Stripe from 'stripe';
export default new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2022-08-01',
});

// src/history.ts
import stripe from '@/client';
```

Exact mappings take priority over wildcards. Single-wildcard patterns use the longest matching prefix; ordered targets allow a missing first source to fall back to the next. A target must resolve to one scanned source file. Source/output ambiguity, skipped symlinks, declaration files and excluded directories stop confirmation instead of silently selecting a fallback. Two exceptions follow runtime loading: a scanned runtime module wins over its sibling declaration (a generated `api.js` beside `api.d.ts`), and a declaration-only target with no later runtime fallback (a generated `dataModel.d.ts`) only provides types. Rooted asset imports such as `/images/logo.png` are bundler public files, never modules. Standard relative imports keep their existing conservative resolution.

Local relative `extends`, including ordered arrays, are loaded only from regular JSON files inside the scanned repository. TypeScript's installed configuration parser handles inherited `baseUrl`, the origin of inherited `paths`, comments, trailing commas and `${configDir}`. Configuration capture is bounded to 128 files, 128 KiB each and 16 inheritance levels; repository-wide scan limits also apply. No configuration package is installed or executed.

## Evidence and checks

The scan records configuration paths, SHA-256 hashes and byte counts under `repository.configurations`. Configuration contents enter the repository/run identity, so changing a mapping cannot reuse the same scan evidence. `sourceResolution` distinguishes configured resolution, ordinary relative resolution and unresolved cases. `refit doctor` reports an unresolved configuration as an activation blocker.

A local mapping or `baseUrl` source that shadows `stripe`, `openai` or another configured SDK package is not treated as that vendor's constructor. Unverified configuration downgrades shared clients and prevents imported AI context from being used. This is conservative: an unrelated unresolved project can also leave an otherwise traceable shared client under review.

## Runtime boundary

[TypeScript paths do not rewrite emitted imports](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths). Refit records their static meaning; it does not establish that a bundler or runtime uses the same mapping. [Native Node type stripping does not implement tsconfig paths](https://nodejs.org/docs/latest-v22.x/api/typescript.html#paths-aliases). Its private `package.json` imports can provide a matching runtime mapping, but Refit does not infer package import/export maps by themselves. Application checks must exercise the resolved imports and the migration.

An offline Docker test uses explicit matching `#billing/*` mappings in both the billing package's `imports` field and its TypeScript configuration. It validates actual Stripe SDKs 10.17.0 and 19.1.0, paginated and empty history, API-version headers, linked workspace source and TypeScript. Stripe responses are simulated; no live Stripe or model call is needed. Generic tests also trace a nested OpenAI resource through an alias using an invented contract rename.

## Current boundaries

A solution configuration (`"files": []` plus `references`, as in Vite's template) is supported: each source file uses the referenced project whose `files`/`include`/`exclude` contain it, a file in no referenced project uses default options, and a file claimed by several stays under review. A configuration with its own sources and `references` works the same way: a file uses that configuration or the one referenced project that includes it, falls back to the nearest configuration when none does, and stays under review when several claim it or a referenced project is missing or not a local path. Package-based or outside-repository `extends`, `rootDirs`, `moduleSuffixes`, `noResolve`, malformed mappings and unresolved configurations remain review cases. Refit selects the nearest standard configuration by source directory; outside solution configurations it does not reconstruct a compiler invocation's `include`/`exclude` membership or a bundler plugin's configuration. Package aliases without a recorded TypeScript/JavaScript mapping, SDK subpath imports, namespace/re-export bindings, class fields, dynamic factories and injected clients still need broader tracing.

The [pinned repository benchmark](SDK-COVERAGE.md) measures call tracing separately from migration correctness.
