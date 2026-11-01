---
provider: twilio
kind: other
reviewed: false
drafted: 2026-11-01
sources:
  - https://www.twilio.com/en-us/changelog
  - https://www.twilio.com/docs/usage/requests-to-twilio
---

# Other Twilio changes

Changes that don't fit a single kind:

- **TwiML verb and attribute changes.** These live in `<Say>`, `<Gather>` and `<Refer>` XML strings and in TwiML builders. The SDK majors renamed builder helpers; see the `sdk-major` playbook.
- **TLS, edge and region changes.** `api.<edge>.<region>.twilio.com` and regional credentials are covered in the [requests](https://www.twilio.com/docs/usage/requests-to-twilio) docs.
- **Compliance-driven behaviour.** A2P 10DLC registration and toll-free verification block sends at the carrier, not in code. Nothing in the repo may need to change, so say that in the verdict rather than editing for the sake of it.

**Where to look:** start from the [changelog](https://www.twilio.com/en-us/changelog). Then run the touched hosts or SDK calls through `twilio_endpoint_lookup`, check SDK impact with `twilio_sdk_versions`, and search the details with `twilio_search_docs`. If the change has no code footprint, a "not affected" verdict with the reasoning is the right outcome.
