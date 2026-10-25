## Overview

This app pins Shopify Admin API 2025-10. A deterministic Refit rule moves it to 2026-04 after checking every traced GraphQL document against the 2026-04 schema.

## API Impact & Spec Changes

- Breaking Changes: Moves the Admin API version from 2025-10 to 2026-04. Refit found no Admin GraphQL documents in the app's own code; requests the Shopify SDK makes itself (authentication, billing) were not checked.
- Database Migrations: None.
- Environment Variables: None.

## Key Changes

- `.graphqlrc.ts`: Moves the pinned Admin API version to 2026-04.
- `app/shopify.server.ts`: Moves the pinned Admin API version to 2026-04.

## Code Changes

`.graphqlrc.ts:11` in `getConfig()`

```diff
       default: shopifyApiProject({
         apiType: ApiType.Admin,
-        apiVersion: ApiVersion.October25,
+        apiVersion: ApiVersion.April26,
         documents: [
           "./app/**/*.{js,ts,jsx,tsx}",
```

`app/shopify.server.ts:22`

```diff
   apiKey,
   apiSecretKey,
-  apiVersion: ApiVersion.October25,
+  apiVersion: ApiVersion.April26,
   scopes: process.env.SCOPES?.split(","),
   appUrl,
```

`app/shopify.server.ts:72`

```diff
 
 export default shopify;
-export const apiVersion = ApiVersion.October25;
+export const apiVersion = ApiVersion.April26;
 export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
 export const authenticate = shopify.authenticate;
```

## Automated Verification Gates

- Evidence Strength: **The repository's test command.** Refit does not measure whether it reaches the changed lines.
- Test Suite Output: `npm test` passed on the original and migrated code in offline Docker.
- Linter & Static Analysis: Not run; Refit rescanned the migrated code and every runtime Admin API pin is on 2026-04.
- Security Scans: Not run.

## Not Verified

- Refit made no request to Shopify. The checks ran on this repository's code in offline Docker, so they cover only the code paths they exercise.
- Requests the Shopify SDK makes on its own (authentication, billing) were not checked.

## Rollback

- Revert this pull request. It changes 2 files and adds no database migration or environment variable.
- Refit changed nothing outside this repository.

## Reviewer Checklist

- [ ] Read each change under Code Changes.
- [ ] Confirm `npm test` exercises the code this patch changes, or add a test that does.

## Related Telemetry

- Closes Issue: None.
- Linked Sentry/Linear ID: N/A. Refit run `a6212c5cfe66`.

<!-- refit-migration:3266b6f195137419294a495bafdb7b5c1eebeddbe4e6bd2719b06af85fd9516d -->

<!-- refit-evidence "runId": "a6212c5cfe6688957be9e54023331415293845ac621c076e06124bb41c65338f", "patchHash": "3bf3707df12a1ff6832ec45c79c28c1b098940a69a940b92d21e6597c5241752", "refit": "<release>" -->
