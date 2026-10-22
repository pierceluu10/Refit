# Auth and backend SDKs: Auth0, Clerk, Firebase, Supabase and NextAuth.js

Refit detects Auth0, Clerk, Firebase, Supabase and NextAuth.js (Auth.js) in JS/TS repositories. It reports which installed SDK major has reached the end of its support, any declared package the provider deprecated, and code that uses a product being shut down. All five providers are `adapter: null`: Refit lists the exposure with file and line, and never edits code for them.

Checked 2026-10-22 (FP5). Nothing here was installed, run or sent to a provider.

## What is detected

| Provider | Catalog packages (checked on the npm registry) | Hostnames (from published SDK code) |
| --- | --- | --- |
| Auth0 | `auth0`, `@auth0/nextjs-auth0`, `@auth0/auth0-react`, `@auth0/auth0-spa-js`, `@auth0/auth0-angular`, `@auth0/auth0-vue`, `@auth0/auth0-auth-js`, `@auth0/auth0-server-js`, `auth0-js`, `auth0-lock`, `express-openid-connect`, `express-oauth2-jwt-bearer` | `.auth0.com` (tenant domains, `your-tenant.auth0.com` in auth0 7.6.0) |
| Clerk | 20 `@clerk/*` SDKs, including the renamed and deprecated ones (`@clerk/clerk-react`, `@clerk/clerk-expo`, `@clerk/clerk-sdk-node`, `@clerk/types`, `@clerk/elements`, `@clerk/edge`) | `api.clerk.com` (`API_URL` in @clerk/backend 3.26.1) |
| Firebase | `firebase`, `firebase-admin` | `firestore`, `identitytoolkit`, `securetoken` and `firebasestorage.googleapis.com`, `firebaseio.com` (firebase-admin 14.5.0 and the @firebase packages) |
| Supabase | `@supabase/supabase-js`, `@supabase/ssr`, the five `@supabase/auth-helpers-*` packages | `.supabase.co` (project URLs in @supabase/supabase-js 2.118.0) |
| NextAuth.js | `next-auth`, `@auth/core`, `@auth/sveltekit`, `@auth/express`, `@auth/qwik`, `@auth/solid-start` | none: it runs inside the application |

Every package's npm repository is in the provider's own GitHub organization. Detection runs through `detectProviders` (`refit agents`), so the hosted inventory picks it up.

## Registry entries

Two new forms in `data/deadlines.json`, matched by `pipeline/sdk-deadlines.ts`:

- **A package range** (`kind: "sdk"`). A version such as `@clerk/nextjs@>=5 <7` names a package and the releases the entry covers. A comparator list is space-separated (`<`, `<=`, `>`, `>=`, `=`). The installed release is the locked version when a lockfile records one. Otherwise it is the lowest release a bounded declared specifier allows: exact, `^`, `~` or an x-range. Open specifiers (`>=4`, `*`, `latest`, tags, URLs, `workspace:`) could install any major, so they match nothing. A package without a range works as before: every declaration matches.
- **A shut-down product** (`kind: "feature"`). Versions are source markers: an API hostname, an SDK option name or a module name. A marker in code is live, one in a comment is a comment, and one in a test or example file is a test. A marker that names a variable (such as `SUPABASE_ANON_KEY`) inside a longer string, such as an error message or a generated `.env` template, is listed as a comment, because it names the variable without reading it.

`npm run deadlines:check` validates both forms and rejects a range it cannot read.

| Entry | Date | Matches | Source read |
| --- | --- | --- | --- |
| `auth0-2026-09-09-node-auth0-v6` | 2026-09-09 | `auth0@>=6 <7` | npm deprecation notice on every 6.x release of `auth0`: "v6 is deprecated and no longer receives updates". It gives no date; the date is when 7.0.0 was published. |
| `clerk-2025-01-10-clerk-sdk-node` | 2025-01-10 | `@clerk/clerk-sdk-node` | npm deprecation notice: "January 10 2025 marks the end of support". |
| `clerk-2025-04-19-core-1-unsupported` | 2025-04-19 | Core 1 and Legacy majors of 9 packages, plus `@clerk/edge` | Clerk's long term support schedule (clerk-docs `versioning.mdx`): Core 1 and Legacy are Unsupported, with no date. The date is derived: one year of LTS after the Core 2 majors appeared on npm (2024-04-19). The Core 1 majors are the ones Clerk's Core 2 upgrade guides name (`@clerk/nextjs@4`, `@clerk/backend@0`, `@clerk/remix@3`, …). |
| `clerk-2026-03-03-elements` | 2026-03-03 | `@clerk/elements` | npm deprecation notice ("no longer supported"), which points to the Core 3 changelog of 2026-03-03. |
| `clerk-2027-01-01-core-2-lts-ends` | 2027-01-01 | Core 2 majors of 17 packages | The same schedule: Core 2 is in long term support until "January 2027". It gives the month only, so the date is its first day. The Core 2 majors are those published between the Core 2 and Core 3 releases on npm; the Core 3 guide names `@clerk/nextjs@6` as the latest Core 2. |
| `firebase-2025-08-01-dynamic-links` | 2025-08-01 | `dynamicLinkDomain`, `firebasedynamiclinks.googleapis.com`, `@react-native-firebase/dynamic-links` | Firebase JS SDK reference (`docs-devsite/auth.actioncodesettings.md`): Dynamic Links "will be shut down as early as August 2025". The page gives no day, so the date is the first of the month. |
| `supabase-2024-11-27-auth-helpers` | 2024-11-27 | the five `@supabase/auth-helpers-*` packages | `supabase/auth-helpers` README: deprecated in favour of `@supabase/ssr`. The deprecation notice was committed on 2024-11-27 (commit `cb7c267`). |
| `nextauth-2022-08-01-next-auth-v3` | 2022-08-01 | `next-auth@<4` | Auth.js security policy (`docs/pages/security.mdx` in nextauthjs/next-auth): "Security updates are only released for the current `latest` version. Old releases are not maintained". `latest` on npm is 4.24.15 (v5 is a beta), so v3 and older are unmaintained. The date is when the last v3 release (3.29.10) was published. |
| `supabase-2026-12-31-legacy-api-keys` | 2026-12-31 | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (also with `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_` prefixes) | Supabase docs partial `api_keys_deprecation.mdx`: "deprecating the anon and service_role keys by the end of 2026". A variable with the legacy name may already hold a new key, so the alert says to check its value. |

### Checked, nothing announced

- **Firebase SDK majors.** The `firebase` and `firebase-admin` npm notices and the firebase-js-sdk and firebase-admin-node changelogs announce no end of support for a major. firebase.google.com was unreachable (below), so its support pages were not read.
- **Supabase JS v1, Auth0 SPA, React, Next.js, Angular and Vue SDKs.** No deprecation notice on npm and none in the repositories read. Older Auth0 majors (`auth0` v2 to v5) carry no deprecation notice, apart from one notice on the single 5.7.0 release.
- **NextAuth.js v4.** The Auth.js integrations page lists v4 as "maintenance mode", and the README says Auth.js is now part of Better Auth, whose team "continues to handle security patches and critical issues". No end date is given, so v4 has no entry. The `@next-auth/*-adapter` packages are replaced by `@auth/*-adapter` from v5 on, but no end of support is announced for them.
- **Auth0 SDK support policy.** auth0.com was unreachable, so Auth0's own lifecycle pages were not read. The only Auth0 entry comes from the npm notice.

## Sources and access

Vendor documentation sites (supabase.com, clerk.com, auth0.com, firebase.google.com) did not resolve from the cloud environment on 2026-10-22 (`getaddrinfo ENOTFOUND`). Their content was read from each provider's own public GitHub repository instead: `clerk/clerk-docs` at `256cbf2`, `supabase/supabase` at `bbf0e73`, `supabase/auth-helpers` at `31cc178`, `auth0/node-auth0` at `185ac06`, plus `firebase/firebase-js-sdk` and `firebase/firebase-admin-node` at HEAD on 2026-10-22, and `nextauthjs/next-auth` at `a1a16a5`. npm deprecation notices and release dates come from `registry.npmjs.org`. Every entry cites the page it came from. A reviewer with web access should still check the vendor pages: Clerk's LTS page and Firebase's Dynamic Links FAQ may give exact days.

## Benchmark

**Sample.** `docs/benchmarks/2026-10-22-auth-backend-repos.json` holds 100 repositories, 20 per provider, made by `node scripts/auth-backend-select.mjs --output …`. GitHub code search was unavailable, so applications come from repositories already frozen in `docs/benchmarks/*-repos.json`, at their pinned commits. Each one's root `package.json` declares the provider's package. Each provider's 20 are taken in SHA-256 order of the repository name. The frozen sets had 162 Supabase, 129 Clerk, 122 NextAuth.js and 43 Firebase candidates, but only 5 for Auth0. Auth0's other 15 come from npm search and are libraries and plugins (for example `ctx-core/*`, `webiny/webiny-js`), not applications.

**Labels.** `docs/benchmarks/2026-10-22-auth-backend-labels.json` holds 38 repositories (8 Clerk, 8 Supabase, 7 Firebase, 7 Auth0, 8 NextAuth.js). The first 30 were labelled blind and committed (`9d3ad0c`) before Refit scanned the sample. The NextAuth.js step added 8 more, and rechecked the first 30 for NextAuth.js packages (5 use it). Those labels were committed (`094634d`) before the 20 NextAuth.js repositories were scanned. The labeller read every manifest, the lockfile and the source that names each package or key variable. Each label lists the providers the repository uses and the registry entries it is exposed to.

**Run.** `node scripts/auth-backend-benchmark.mjs --root <clones>` on clean commit `094634d` wrote `docs/benchmarks/2026-10-22-auth-backend-results.json`. Repository code was never installed or run.

| Measure (37 labelled repositories scanned) | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Provider detection | 45 | 0 | 0 | 100% | 100% |
| Exposure (repository × entry) | 22 | 0 | 0 | 100% | 100% |

- One labelled repository (`getcord/cord`) and four unlabelled ones (`samepage-network/samepage.network`, `webiny/webiny-js`, `MemberJunction/MJ`, `sesamyab/authhero`) exceed Refit's existing scan limits (10,000 files or 50 MiB). They are counted as failed scans, not as hits or misses.
- The labels use the same definitions as the entries (range, lockfile first, live code only). So the score shows that Refit applies each entry as written. It does not check whether the entries' dates are right; that rests on the sources above.
- **Legacy-key lines.** Every live evidence line for `supabase-2026-12-31-legacy-api-keys` across the first 75 scanned repositories was reviewed by hand after the scan, so this check is not blind.
  - Before the prose rule, 202 of 215 lines read the key. The other 13 named it in an error message (9) or in a generated `.env` template (4).
  - With the rule, all 202 remaining lines read the key, and the 13 are listed as comments.
  - No repository's exposure changed, because each of those repositories also reads the key.

**Exposure across the 95 scanned repositories**

| Provider | Detected | Repositories exposed | Entries hit (repositories) |
| --- | ---: | ---: | --- |
| Supabase | 25 | 22 | legacy API keys (21), auth helpers (6) |
| Clerk | 22 | 20 | Core 2 LTS ends 2027-01 (14), Core 1 unsupported (6), clerk-sdk-node (2) |
| Firebase | 20 | 0 | none: no Dynamic Links use in the sample |
| Auth0 | 15 | 1 | node-auth0 v6 (`ctx-core/auth0-management`, `auth0 ^6.0.0`) |
| NextAuth.js | 28 | 0 | none: every repository is on v4 or the v5 beta (no v3 among the 122 candidates either) |

**Scan cost.** The catalog grew from 10 to 15 providers. `detectProviders` now reads source files once for every hostname check, and reads a package's declarations only when some manifest declares it. `scanDeadlines` reads each SDK package at most once.

- On the first 80 repositories, `refit agents` plus `refit deadlines` took 227 s in total on this branch (before NextAuth.js was added), against 301 s on `main` at `7b2c86a`. All 100 took 279 s with NextAuth.js.
- Output for the providers `main` already had was identical on all 80.
- On `vual/lobe-chat-pro`, `agents` takes 8.6 s, against 19.9 s on `main` and 59 s before the change. `deadlines` takes 5.1 s, against 3.9 s on `main`.

## Limits

- Only JS/TS manifests are read. A repository that uses these SDKs from Python, Go or mobile code (FG5's manifests) is not covered yet.
- The legacy-key entry relies on the variable name. A repository that already stores a publishable key under `SUPABASE_ANON_KEY` is still listed, and a key read under another name is missed.
- The Firebase Dynamic Links entry matches the Auth option and the REST host. Links built only from `*.page.link` URLs are not matched, because that host is too broad.
