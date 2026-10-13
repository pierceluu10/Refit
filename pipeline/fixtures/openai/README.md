# OpenAI provider conformance fixture

This fixture tests the shared Refit engine with the real OpenAI Node SDK, ordinary `models.retrieve()` usage, and an offline HTTP server. It never needs credentials or sends requests to OpenAI servers.

The before response follows the documented Model resource. The after response **simulates removal of `owned_by` for testing**. This is not a claimed historical or announced OpenAI API change. It deliberately has no invented replacement field or migration recipe.

`provider.json` configures SDK-to-schema mapping without changing the analyzer. The shared OpenAPI differ detects the contract change and the scanner identifies the affected read. Automatic migration remains unsupported when no replacement semantics are established; that is a review result, not a fabricated fix.

Run the optional real-SDK check with `REFIT_OPENAI_SDK=1 npm test`. The test installs the pinned SDK into a disposable copy; only dependency preparation accesses npm. SDK requests go to the local HTTP simulator.
