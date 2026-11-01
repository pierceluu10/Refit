---
provider: openai
kind: auth-change
reviewed: false
drafted: 2026-11-01
sources:
  - https://developers.openai.com/api/reference/overview
  - https://developers.openai.com/api/docs/guides/production-best-practices
  - https://developers.openai.com/api/docs/guides/workload-identity-federation
---

All OpenAI API calls use HTTP Bearer auth: `Authorization: Bearer <key or token>` ([API overview](https://developers.openai.com/api/reference/overview)). What changes over time is _which_ credential and which scoping headers.

- **Organization and project scoping.** Users in several orgs, or using a legacy user API key to reach projects, send `OpenAI-Organization` and `OpenAI-Project` headers. Usage is billed to that org/project ([same page](https://developers.openai.com/api/reference/overview)). The SDKs map these to `organization` / `project` client options, which default to the `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID` env vars ([python client](https://github.com/openai/openai-python/blob/main/src/openai/_client.py)).
- **Project keys and key governance.** Admins can force key expiry, set a maximum key lifetime, and restrict which key types can be created: service-account only, user-owned project keys, or none ([production best practices](https://developers.openai.com/api/docs/guides/production-best-practices)). A long-lived key in CI may stop working when that policy changes.
- **Admin keys.** Administration endpoints (users, projects, audit logs) need an Admin API key, not a normal key ([overview](https://developers.openai.com/api/reference/overview)).
- **Workload identity federation.** A workload can exchange an OIDC or X.509 identity for a short-lived access token mapped to a service account, instead of storing a key ([guide](https://developers.openai.com/api/docs/guides/workload-identity-federation)).

**Spot it.** Grep for `OPENAI_API_KEY`, `OPENAI_ORG`, `OpenAI-Organization`, `OpenAI-Project`, `organization=`, `api_key=`, hard-coded `sk-` prefixes (never print values), and admin calls under `/v1/organization/`.

**Check.** `openai_search_docs` with "authentication", "workload identity" or "admin key". Error responses separate invalid keys from org membership problems (401 variants in [error codes](https://developers.openai.com/api/docs/guides/error-codes)).

**Pitfalls.** Never move a key into client-side code. Key revocation takes effect within seconds, but other auth updates can take up to about 15 minutes to propagate ([overview](https://developers.openai.com/api/reference/overview)). A wrong `OpenAI-Project` header silently bills a different project.
