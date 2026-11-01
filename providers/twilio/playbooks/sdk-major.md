---
provider: twilio
kind: sdk-major
reviewed: false
drafted: 2026-11-01
sources:
  - https://github.com/twilio/twilio-node/blob/main/UPGRADE.md
  - https://github.com/twilio/twilio-python/blob/main/UPGRADE.md
  - https://github.com/twilio/twilio-java/blob/main/UPGRADE.md
  - https://github.com/twilio/twilio-csharp/blob/main/UPGRADE.md
  - https://www.twilio.com/docs/libraries
---

# Twilio helper library majors

All seven server SDKs are now generated from twilio-oai. Most recent majors say there are "no breaking changes of existing apis". The real breaks are runtime minimums and a few renames. Run `twilio_sdk_versions` with the package and the locked version to get the exact list since that version.

**The big ones:**

- **twilio-node 3 → 4 (2023).** TypeScript rewrite and Node ≥ 14. `AccessToken` needs `identity`. `IpMessagingGrant` was removed. `Say.ssmlEmphasis()` became `Say.emphasis()` (and the same for the other `ssml*` helpers). TaskRouter worker statistics moved off the worker context. Node 4 → 5 has no API change. 5 → 6 needs Node ≥ 20 ([UPGRADE.md](https://github.com/twilio/twilio-node/blob/main/UPGRADE.md)).
- **twilio-python 7 → 8 (2023).** Python 3.7+, `Say.ssml_*` removed, `IpMessagingGrant` removed. `available_phone_number` was renamed `available_phone_number_country`, and `_properties` is gone. 8 → 9 has no API change ([UPGRADE.md](https://github.com/twilio/twilio-python/blob/main/UPGRADE.md)).
- **twilio-java 10 → 11 → 12 → 13 (2025-26).** HttpClient 5. Request validation now uses `Jwts.SIG.*` instead of `SignatureAlgorithm`. Generated nested enum names keep their digits ([UPGRADE.md](https://github.com/twilio/twilio-java/blob/main/UPGRADE.md)).
- **twilio-csharp 8.** Requires .NET 8 ([UPGRADE.md](https://github.com/twilio/twilio-csharp/blob/main/UPGRADE.md)).

**Spotting it:**

- Read the lockfile, not the manifest range: `package-lock.json`/`pnpm-lock.yaml` for `twilio`, `poetry.lock`/`requirements*.txt` for `twilio`, `Gemfile.lock` for `twilio-ruby`, `composer.lock` for `twilio/sdk`, `pom.xml`/`build.gradle` for `com.twilio.sdk:twilio`, `*.csproj` for `Twilio`, `go.mod` for `github.com/twilio/twilio-go`.
- Check the runtime pins in `engines`, `.nvmrc`, `python_requires`, CI images and `TargetFramework`. A Node 18 CI can't take twilio-node 6.

**What to check:**

- grep for each renamed symbol the tool lists.
- Code that subclasses or mocks SDK internals (custom HTTP clients, `_properties`, `RequestClient`) breaks more often than ordinary calls.
- Removed products drop out of the SDK too, so a bump can surface a product-shutdown problem.

**Pitfalls:**

- Twilio publishes no support window for server SDKs ([libraries](https://www.twilio.com/docs/libraries)), so "unsupported" is a judgement call. Say so in the PR.
- TypeScript users of twilio-node 4+ may hit new compile errors from stricter types even when runtime behaviour is unchanged. Run the type check.
