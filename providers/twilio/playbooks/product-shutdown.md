---
provider: twilio
kind: product-shutdown
reviewed: false
drafted: 2026-11-01
sources:
  - https://www.twilio.com/docs/chat
  - https://twilio.com/en-us/changelog/notify-api-end-of-life-further-extension-notice
  - https://www.twilio.com/docs/proxy
  - https://www.twilio.com/en-us/changelog/-twilio-video-will-remain-a-standalone-product
  - https://www.twilio.com/docs/verify/authy-vs-verify
---

# Twilio product shutdowns

Twilio retires whole products more often than it breaks single endpoints. The usual pattern: a changelog notice, End of Sale (closed to new customers), End of Support, then End of Life. Dates often move, so read the latest notice, not the first one.

**Known cases (check `twilio_endpoint_lookup` for dates and sources):**

- **Programmable Chat** (`chat.twilio.com`, `ip-messaging.twilio.com`, `client.chat`, `client.ipMessaging`, npm `twilio-chat`): deprecated, "receives no support"; move to Conversations ([docs](https://www.twilio.com/docs/chat)). Chat in Flex hit EOL on 2026-06-01 ([changelog](https://www.twilio.com/en-us/changelog/programmable-chat-in-flex-reaching-end-of-life-on-june-1--2026)).
- **Notify** (`notify.twilio.com`, `client.notify`): support stopped Oct 2022, EOL 2025-12-31 ([docs](https://www.twilio.com/docs/notify), [changelog](https://twilio.com/en-us/changelog/notify-api-end-of-life-further-extension-notice)). Bulk SMS goes to the Bulk Messaging API. Push needs a new path.
- **Authy API** (`api.authy.com`, `authy` packages): End of Support, closed to new customers, no EOL date yet. Move to Verify v2 ([docs](https://www.twilio.com/docs/verify/authy-vs-verify)).
- **Proxy**: Public Beta closed to new customers. Twilio suggests Conversations + Voice ([docs](https://www.twilio.com/docs/proxy)). No EOL date found.
- **Fax** (disabled 2021-12-17), **Frontline** (retired 2026-09-30), **Autopilot** (gone; date unverified).
- **Programmable Video is NOT shutting down.** The 2024 EOL was reversed on 2024-10-21 ([changelog](https://www.twilio.com/en-us/changelog/-twilio-video-will-remain-a-standalone-product)). Don't migrate a repo off Video because of an old blog post.

**Spotting it:** grep for hosts (`chat.twilio.com`, `notify.twilio.com`, `api.authy.com`, `proxy.twilio.com`), SDK accessors (`.chat.v2`, `.notify.v1`, `.proxy.v1`, `IpMessagingGrant`, `ChatGrant`), and packages (`twilio-chat`, `authy`, `authy-client`).

**Pitfalls:**

- A product's presence in the twilio-oai spec or the SDK proves nothing. Chat, Notify and Proxy are still generated.
- Replacements are rarely 1:1. Chat → Conversations changes resource names (Channels → Conversations, Members → Participants) and client SDKs. Authy → Verify changes the whole flow (Services, Verifications, VerificationChecks).
- Data may already be migrated (Chat channels show up in Conversations), so don't write copy scripts until you've checked.

Use `twilio_search_docs` for migration guides and say clearly in the PR which parts you couldn't verify.
