---
provider: twilio
kind: endpoint-removed
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/twilio/twilio-oai
  - https://github.com/twilio/twilio-node/blob/main/UPGRADE.md
  - https://github.com/twilio/twilio-python/blob/main/UPGRADE.md
---

# Twilio endpoint removed

Single-endpoint removals at Twilio usually come from one of three things:

1. a whole product or version going away (see the product-shutdown and api-version playbooks);
2. a resource moving off `preview.twilio.com` to a GA host, e.g. HostedNumbers now lives under `numbers.twilio.com` ([twilio-oai](https://github.com/twilio/twilio-oai));
3. an SDK major dropping or reshaping an operation.

An example of the third: TaskRouter worker statistics no longer take a WorkerSid in twilio-node 4 and twilio-python 8 ([node](https://github.com/twilio/twilio-node/blob/main/UPGRADE.md), [python](https://github.com/twilio/twilio-python/blob/main/UPGRADE.md)).

**Spotting it:** collect every Twilio URL and SDK chain in the repo. Search for `twilio.com/`, `client.`, `->`, `Twilio::REST`, `com.twilio.rest.` and `Twilio.Rest.` Run each one through `twilio_endpoint_lookup`. It matches a URL against the path templates in the twilio-oai snapshot, lists methods, and suggests the closest surviving path. When online it also checks the live spec.

**What to check:**

- **The method as well as the path.** A path can stay while `DELETE` or `POST` goes. Pass `method` to the tool.
- **Path parameters.** A path can stay while its parameters change: the SID prefix, or `{Sid}` becoming `{ServiceSid}`.
- **Hardcoded URLs.** Raw `fetch`/`requests` calls with hardcoded URLs (status callbacks, media URLs, `next_page_uri` handling) as well as SDK calls.
- **Old base URLs.** A webhook or TwiML `<Redirect>` may point at an old Twilio-hosted URL.

**Pitfalls:**

- Paths in the snapshot are templates, and placeholder names don't matter for matching.
- 2010 API paths end in `.json`. Without it you get XML ([docs](https://www.twilio.com/docs/usage/twilios-response)), which can look like a removal when it isn't.
- If a path is missing from both the snapshot and the live spec, it may never have been public (an internal or console-only endpoint). Say so instead of inventing a replacement.

Confirm the replacement with `twilio_search_docs` before editing.
