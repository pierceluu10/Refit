# OpenAI provider conformance fixture

This fixture tests the shared Refit engine with the real OpenAI Node SDK, ordinary `models.retrieve()` usage, and an offline HTTP server. It never needs credentials or sends requests to OpenAI servers.

The before response follows the documented Model resource. The after response **simulates removal of `owned_by` and addition of `owner_name` for testing**. This is not a claimed historical or announced OpenAI API change; `owner_name` is only a synthetic replacement used to exercise the migration mechanism.

`provider.json` configures SDK-to-schema mapping without changing the analyzer. The shared OpenAPI differ detects the contract change and the scanner identifies the affected read. Without an explicit rename mapping, automatic migration remains unsupported and the finding requires review.

`provider-renames.json` adds an operator-authored mapping from `Model.owned_by` to the synthetic `Model.owner_name`. The optional real-SDK test applies the generated patch, then sends the OpenAI SDK's `models.retrieve()` request to the local HTTP simulator in both API modes. This verifies the shared analyzer and patch path with the real SDK; it does not verify OpenAI's live API or the semantic validity of the synthetic rename.

From the Refit source checkout, run the optional real-SDK check with `REFIT_OPENAI_SDK=1 npm test`. The test installs OpenAI SDK **7.32.0** into a disposable copy; only dependency preparation accesses npm. SDK requests go to the local HTTP simulator. The Model field contract is documented in [OpenAI's retrieve-model reference](https://developers.openai.com/api/reference/resources/models/methods/retrieve).
