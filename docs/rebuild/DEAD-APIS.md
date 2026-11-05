# Dead-API list

Hand-written 2026-11-04 from official provider pages only, before any candidate repo's code was opened. All sources checked 2026-11-04. Copies of what was read are in `list/sources/`.

"Dead" means gone on or before 2026-11-04. Things with a future date are under "Not dead yet" for each provider: do not treat those as breaks.

Each entry gives: what died and when, source, what to look for, which versions it applies to, the replacement as listed on the provider's page, and what else the replacement requires.

## Anthropic

Source for AN-*: https://platform.claude.com/docs/en/about-claude/model-deprecations (checked 2026-11-04). Dates apply to Anthropic-operated platforms. Bedrock and Google-managed Vertex set their own schedules, so a Bedrock or Vertex model ID is not covered by these entries.

**AN-1. Retired models**

| Look for this model string (or the alias form) | Retired | Replacement on the page |
|---|---|---|
| `claude-sonnet-4-20250514` (`claude-sonnet-4-0`, `claude-sonnet-4`) | 2026-06-15 | `claude-sonnet-5-5` |
| `claude-opus-4-20250514` (`claude-opus-4-0`, `claude-opus-4`) | 2026-06-15 | `claude-opus-4-8` |
| `claude-opus-4-1-20250805` (`claude-opus-4-1`) | 2026-08-05 | `claude-opus-4-8` |
| `claude-3-7-sonnet-20250219` (`claude-3-7-sonnet-latest`) | 2026-02-19 | `claude-sonnet-5-5` |
| `claude-3-5-sonnet-20241022`, `claude-3-5-sonnet-20240620` (`claude-3-5-sonnet-latest`) | 2025-10-28 | `claude-sonnet-5-5` |
| `claude-3-5-haiku-20241022` (`claude-3-5-haiku-latest`) | 2026-02-19 | `claude-haiku-4-5-20251001` |
| `claude-3-haiku-20240307` | 2026-04-20 | `claude-haiku-4-5-20251001` |
| `claude-3-opus-20240229` (`claude-3-opus-latest`) | 2026-01-05 | `claude-opus-4-8` |
| `claude-3-sonnet-20240229` | 2025-07-21 | `claude-sonnet-5-5` |
| `claude-2.1`, `claude-2.0` | 2025-07-21 | `claude-opus-4-8` |
| `claude-1.*`, `claude-instant-1.*` | 2024-11-06 | `claude-haiku-4-5-20251001` |

- **Applies to:** every SDK and version. Requests to a retired model fail. Only the alias forms in brackets are my reading; the page lists the dated IDs.
- **Requires:** AN-2 when the replacement is Claude 4.7 or later, which includes `claude-sonnet-5-5` and `claude-opus-4-8`. `claude-haiku-4-5-20251001` is listed "not sooner than October 15, 2026", so its retirement could already be scheduled. Prefer it only because the page names it.

**AN-2. Sampling parameters on newer models**

- **What died:** `temperature`, `top_p`, `top_k`. On Claude 4.7 and later, a non-default value returns a 400. Under API version `2026-10-21`, sending them returns a 400 on any model, even at the default value.
- **Source:** same page, "API parameter deprecations"; https://platform.claude.com/docs/en/api/migration-2026-10-21
- **Look for:** those parameters in a Messages call whose model is Claude 4.7 or later, or after moving a model under AN-1.
- **Applies to:** Claude 4.7 and later, or `anthropic-version: 2026-10-21`.
- **Replacement:** omit them, and use prompting to guide behaviour.
- **Requires:** do not send them on the Anthropic path, even if a shared config still holds a temperature for other providers.

**Not dead yet:** `claude-sonnet-4-5-20250929` retires 2026-11-30 (replacement `claude-sonnet-5-5`). Not a break today, but don't move anything onto it.

## OpenAI

Source for OA-*: https://platform.openai.com/docs/deprecations (checked 2026-11-04).

**OA-1. Shut-down models**

| Look for | Shut down | Replacement on the page |
|---|---|---|
| `gpt-3.5-turbo`, `gpt-3.5-turbo-0125` | 2026-10-23 | `gpt-5.6-terra` |
| `gpt-4`, `gpt-4-0613` | 2026-10-23 | `gpt-5.6-sol` |
| `gpt-4-1106-preview`, `gpt-4-turbo`, `gpt-4-turbo-2024-04-09` | 2026-10-23 | `gpt-5.6-sol` |
| `gpt-4.1-nano`, `gpt-4.1-nano-2025-04-14` | 2026-10-23 | `gpt-5.6-luna` |
| `gpt-4o-2024-05-13` (only this dated snapshot) | 2026-10-23 | `gpt-5.6-sol` |
| `o1`, `o1-2024-12-17`, `o3-mini`, `o3-mini-2025-01-31` | 2026-10-23 | `gpt-5.6-sol` |
| `o1-pro`, `o1-pro-2025-03-19` | 2026-10-23 | `gpt-5.6-sol` with `reasoning.mode: pro` |
| `o4-mini`, `o4-mini-2025-04-16` | 2026-10-23 | `gpt-5.6-terra` |
| `gpt-image-1` | 2026-10-23 | `gpt-image-2.5-sunburst` or `gpt-image-2.5-flare` |
| `gpt-3.5-turbo-instruct`, `babbage-002`, `davinci-002`, `gpt-3.5-turbo-1106` | 2026-09-28 | `gpt-5.6-terra` |
| `gpt-5-chat-latest`, `gpt-5-codex`, `gpt-5.1-chat-latest`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex` | 2026-07-23 | `gpt-5.6-sol` |
| `gpt-4o-search-preview-2025-03-11`, `gpt-4o-mini-search-preview-2025-03-11`, `computer-use-preview` | 2026-07-23 | `gpt-5.6-terra` |
| `gpt-5.2-chat-latest`, `gpt-5.3-chat-latest` | 2026-08-10 | `gpt-5.6-sol` |
| `dall-e-2`, `dall-e-3` | 2026-05-12 | `gpt-image-2` (the page also lists `gpt-image-1` and `gpt-image-1-mini`; `gpt-image-1` is itself dead above) |
| `gpt-4o-realtime-preview` and dated forms, `gpt-4o-mini-realtime-preview` | 2026-05-07 | `gpt-realtime-1.5`, `gpt-realtime-mini` |
| `gpt-4o-audio-preview`, `gpt-4o-mini-audio-preview` | 2026-05-07 | `gpt-audio-1.5`, `gpt-audio-mini` |
| `gpt-4-0314`, `gpt-4-0125-preview`, `gpt-4-turbo-preview` | 2026-03-26 | Page lists `gpt-5` or `gpt-4.1`, both retiring soon (see below). Use `gpt-5.6-sol`, the page's substitute for `gpt-4` |
| `chatgpt-4o-latest` | 2026-02-17 | Page lists `gpt-5.1-chat-latest`, itself dead. Use `gpt-5.6-sol`, its substitute |
| `gpt-4.5-preview` | 2025-07-14 | Page lists `gpt-4.1` (retires 2027-01-14) |
| `o1-preview`, `o1-mini` | 2025-07-28, 2025-10-27 | Page lists `o3`, `o4-mini`; `o4-mini` is dead and `o3` retires 2026-12-11. Use `gpt-5.6-sol` |
| `text-moderation-latest`, `text-moderation-stable`, `text-moderation-007` | 2025-10-27 | `omni-moderation` |
| `gpt-4-32k` and dated, `gpt-4-vision-preview`, `gpt-4-1106-vision-preview` | 2025-06-06, 2024-12-06 | Page lists `gpt-4o`; see "Not dead yet" |
| `gpt-3.5-turbo-0613`, `gpt-3.5-turbo-16k-0613`, `gpt-3.5-turbo-0301` | 2024-09-13 | Page lists `gpt-3.5-turbo`, itself dead. Use `gpt-5.6-terra` |
| `text-davinci-003`, `text-davinci-002`, `text-curie-001`, `text-babbage-001`, `text-ada-001`, `code-davinci-002` | 2024-01-04 | Page lists `gpt-3.5-turbo-instruct`, itself dead. Use `gpt-5.6-terra` |
| `text-davinci-edit-001`, `code-davinci-edit-001` | 2024-01-04 | `gpt-4o` |
| First-generation embeddings (`text-search-*-001`, `text-similarity-*-001`, `code-search-*-001`) | 2024-01-04 | `text-embedding-3-small` |

- **Applies to:** every SDK and version.
- **Fine-tuned models** follow their base model's schedule.
- **Requires:** on the newer reasoning models, remove `temperature`, `top_p` and `top_logprobs` when reasoning effort is not `none`. On Chat Completions, also remove `logprobs`. Source: https://developers.openai.com/api/docs/guides/latest-model
- **Requires:** moving off a completions-only model such as `gpt-3.5-turbo-instruct` means the call shape may need to change as well as the name.

**OA-2. Assistants API**

- **What died:** Assistants API, removed 2026-08-26.
- **Look for:** `/v1/assistants`, `/v1/threads`, `client.beta.assistants`, `client.beta.threads`, `OpenAI-Beta: assistants=v2` or `assistants=v1`.
- **Applies to:** every SDK and version.
- **Replacement:** Responses API and Conversations API.
- **Requires:** real rework, because threads and runs do not map one to one. See the page's Assistants migration guide.

**OA-3. Older endpoints**

| Look for | Shut down | Replacement |
|---|---|---|
| `/v1/edits` | 2024-01-04 | `/v1/chat/completions` |
| `/v1/fine-tunes` | 2024-01-04 | `/v1/fine_tuning/jobs` |
| `/v1/engines` | 2022-12-03 | `/v1/models` |
| `OpenAI-Beta: realtime=v1` | 2026-05-12 | Realtime API (GA interface) |
| Videos API, `sora-2`, `sora-2-pro` and dated forms | 2026-09-24 | None listed |

**Not dead yet:** `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` (2027-01-14, replacement `gpt-6-luna`); `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`, `o3`, `o3-pro` (2026-12-11); `tts-1`, `tts-1-hd` (2027-01-06); `whisper-1` (2027-02-26); `/v1/prompts` (2026-11-30). Not breaks today, but don't move anything onto them. Note `gpt-4o-mini` and `gpt-4o` without a date are live.

## Gemini

Source for GE-*: https://ai.google.dev/gemini-api/docs/deprecations (the page's canonical address is now https://aistudio.google.com/docs/deprecations; checked 2026-11-04). This is the Gemini API. Vertex AI model IDs are not covered.

**GE-1. Shut-down models**

| Look for | Shut down | Replacement on the page |
|---|---|---|
| `gemini-2.0-flash`, `gemini-2.0-flash-001` | 2026-06-01 | `gemini-3.6-flash` |
| `gemini-2.0-flash-lite`, `gemini-2.0-flash-lite-001` | 2026-06-01 | `gemini-3.1-flash-lite` |
| `gemini-2.0-flash-lite-preview`, `gemini-2.0-flash-lite-preview-02-05` | 2025-12-09 | `gemini-3.1-flash-lite` |
| `gemini-2.0-flash-live-001`, `gemini-live-2.5-flash-preview` | 2025-12-09 | `gemini-3.8-live` |
| `gemini-2.0-flash-preview-image-generation` | 2025-11-14 | `gemini-nano-banana-2.1` |
| `gemini-2.5-flash-preview-05-20`, `gemini-2.5-flash-preview-09-2025` | 2025-11-18, 2026-02-17 | `gemini-3.6-flash` |
| `gemini-2.5-flash-lite-preview-09-2025` | 2026-03-31 | `gemini-3.1-flash-lite` |
| `gemini-2.5-pro-preview-03-25`, `-05-06`, `-06-05` | 2025-12-02 | `gemini-3.8-flash` |
| `gemini-3-pro-preview` | 2026-03-09 | `gemini-3.1-pro-preview` |
| `gemini-3.1-flash-lite-preview` | 2026-05-25 | `gemini-3.1-flash-lite` |
| `text-embedding-004` | 2026-01-14 | `gemini-embedding-2` |
| `embedding-001` | 2025-10-30 | `gemini-embedding-2` |
| `imagen-3.0-generate-002`, `imagen-4.0-*` | 2025-11-10 to 2026-08-17 | `gemini-nano-banana-2.1` |
| `veo-2.0-generate-001`, `veo-3.0-*`, `veo-3.1-*` | 2025-11-12 to 2026-10-22 | `gemini-omni-1.1-flash` |

- **Older names:** `gemini-1.5-*`, `gemini-1.0-*` and `gemini-pro` no longer appear on the page at all. The page only lists current and recent models, so I read them as long gone, not as a dated entry. Use `gemini-3.6-flash`.
- **Applies to:** every SDK and version of the Gemini API.
- **Requires:** when moving to Gemini 3.x, per https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6:
  - Remove `temperature`, `top_p`, `top_k`. They're deprecated and ignored today, and will return a 400 on future generations.
  - Remove `candidate_count`. It's unsupported on Gemini 3 and later.
  - Replace `thinking_budget` with `thinking_level` (`"medium"` or `"high"`).
  - A request whose last non-empty turn has role `model` (a prefill) returns a 400.

**Not dead yet:** `gemini-2.5-pro`, `gemini-2.5-flash` (2026-12-01, auto-routed to a newer model). `gemini-2.5-flash-lite` has no date. Not breaks today, but don't move anything onto the first two.

## Groq

Source for GR-*: https://console.groq.com/docs/deprecations (checked 2026-11-04). Requests to a shut-down ID return errors.

| Look for | Shut down | Replacement on the page |
|---|---|---|
| `llama-3.3-70b-versatile` | 2026-08-16 | `openai/gpt-oss-120b` or `qwen/qwen3.6-27b`; the second shut down 2026-09-14, so use `openai/gpt-oss-120b` |
| `llama-3.1-8b-instant` | 2026-08-16 | `openai/gpt-oss-20b` |
| `llama-3.1-70b-versatile`, `llama-3.1-70b-specdec` | 2025-01-24 | Page lists Llama 3.3 IDs, now dead. Use `openai/gpt-oss-120b` |
| `llama3-70b-8192` | 2025-08-30 | Same, `openai/gpt-oss-120b` |
| `llama3-8b-8192` | 2025-08-30 | Page lists `llama-3.1-8b-instant`, now dead. Use `openai/gpt-oss-20b` |
| `llama3-groq-70b-8192-tool-use-preview`, `llama3-groq-8b-8192-tool-use-preview` | 2025-01-06 | Same, `openai/gpt-oss-120b` |
| `mixtral-8x7b-32768` | 2025-03-20 | Same, `openai/gpt-oss-120b` |
| `gemma2-9b-it` | 2025-10-08 | Page lists `llama-3.1-8b-instant`, now dead. Use `openai/gpt-oss-20b` |
| `gemma-7b-it` | 2024-12-18 | Same, `openai/gpt-oss-20b` |
| `deepseek-r1-distill-llama-70b`, `deepseek-r1-distill-qwen-32b`, `qwen-qwq-32b`, `qwen-2.5-32b`, `qwen-2.5-coder-32b`, `mistral-saba-24b`, `qwen/qwen3-32b` | 2025-04-14 to 2026-07-17 | `openai/gpt-oss-120b` |
| `moonshotai/kimi-k2-instruct`, `moonshotai/kimi-k2-instruct-0905` | 2025-10-10, 2026-04-15 | `openai/gpt-oss-120b` |
| `meta-llama/llama-4-scout-17b-16e-instruct`, `meta-llama/llama-4-maverick-17b-128e-instruct` | 2026-07-17, 2026-03-09 | `openai/gpt-oss-120b` |
| `llama-3.2-*-preview` | 2024-10-28 to 2025-04-14 | `openai/gpt-oss-120b` (vision: no replacement with vision survives on this page, so say so) |
| `llama-guard-3-8b`, `meta-llama/llama-guard-4-12b` | 2025-06-06, 2026-03-05 | `openai/gpt-oss-safeguard-20b` |
| `distil-whisper-large-v3-en` | 2025-08-23 | `whisper-large-v3-turbo` |
| `playai-tts`, `playai-tts-arabic` | 2025-12-31 | `canopylabs/orpheus-v1-english`, `canopylabs/orpheus-arabic-saudi` |
| `qwen/qwen3.6-27b` | 2026-09-14 | `qwen/qwen3.8-27b` |
| `groq/compound`, `groq/compound-mini` | 2026-09-21 | None listed |

- **Applies to:** Groq's API, including the OpenAI-compatible base URL `https://api.groq.com/openai/v1`. The same names on another host (Together, a local Ollama) are not covered.
- **Tier note:** the earlier report recorded the 2026-08-16 shutdown as applying to free and developer tiers. Treat it as dead.
- **Requires:** chains of replacements end on what's live, as worked out above. Do not stop on an intermediate name that is itself dead.

## Google Analytics

**GA-1. Universal Analytics**

- **What died:** Universal Analytics, "no longer available as of July 1, 2024".
- **Source:** https://developers.google.com/analytics/legacy/universal-analytics (checked 2026-11-04)
- **Look for:**
  - Posts to `https://www.google-analytics.com/collect` or `/batch` with `v=1`, `tid=UA-...` (not `/g/collect` or `/mp/collect`, which are GA4)
  - Property IDs starting `UA-`
  - `analytics.js`, `ga('create', ...)`, `ga('send', ...)`
  - Libraries built on it, such as `react-ga` (not `react-ga4`) and `universal-analytics`
- **Applies to:** all of them.
- **Replacement:** GA4. For server or extension hits, Measurement Protocol: `POST https://www.google-analytics.com/mp/collect?measurement_id=G-XXXX&api_secret=SECRET` with a JSON body holding `client_id` and `events: [{name, params}]`. Source: https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events. For web pages, the Google tag (`gtag.js`) with a `G-` ID.
- **Requires:**
  - A GA4 measurement ID and API secret that nobody has yet. Read them from config and say what a person must set.
  - The API secret is private, and Google warns not to expose it in client code.
  - Move custom dimensions such as `cd1` into event params.
  - Event names must follow GA4's naming rules.

## Stripe

Stripe keeps old API versions working. So a Stripe entry is a break **only if the code runs at or after the version that removed the thing**, which means:

- The version is set by `apiVersion` / `stripe.api_version` / `Stripe-Version`. If unset, the SDK's own pinned version applies for current SDKs. See https://docs.stripe.com/upgrades.
- SDK release to API version: `stripe` Node 18.0.0 and later send `2025-03-31.basil` or newer. I took this from the changelog's own statement that you upgrade to the corresponding SDK version, not from a table, so read the SDK's `apiVersion` in `node_modules` when unsure.
- Reading `any`-typed or untyped objects hides these from typecheck. Read the code.
- **Webhook caveat:** webhook payloads follow the webhook endpoint's own API version, not the SDK pin. An object from `event.data.object` may have either shape, and the repo alone can't say which. Objects from API calls follow the pin.

All at or after `2025-03-31.basil`, source https://docs.stripe.com/changelog/basil (checked 2026-11-04), with these per-entry pages:

**ST-1. Subscription periods**

- **What died:** `subscription.current_period_start`, `subscription.current_period_end`.
- **Source:** https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
- **Look for:** those fields read off a Stripe subscription. Exclude the app's own database columns and objects with the same name.
- **Replacement:** `subscription.items.data[].current_period_start` and `current_period_end`.
- **Requires:** items can have different periods. Choose one deliberately, with a comment, and handle the case where the list is empty.

**ST-2. Invoice subscription pointer**

- **What died:** `invoice.subscription`, `invoice.subscription_details`, `invoice.subscription_proration_date`, `invoice.quote`, and `line_item.subscription_item`.
- **Source:** https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
- **Look for:** those fields on a Stripe invoice or line item, including inside webhook handlers.
- **Replacement:** `invoice.parent.subscription_details.subscription` (check `invoice.parent.type` is `subscription_details`); `line_item.parent.subscription_item_details.subscription_item`.
- **Requires:** the same field can be a string or an expanded object, as before.

**ST-3. Invoice payment pointers**

- **What died:** the pointers between invoices and payments, including `invoice.payment_intent` and `invoice.charge`.
- **Source:** https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices
- **Look for:** `invoice.payment_intent`, `invoice.charge`, `latest_invoice.payment_intent`, and `expand` paths using them.
- **Replacement:** expand `payments` and read `invoice.payments`; the `invoice_payments` list endpoint; for Payment Element, `invoice.confirmation_secret.client_secret`.
- **Requires:** one invoice can have several payments.

**ST-4. Checkout shipping details**

- **What died:** `session.shipping_details` on a Checkout Session.
- **Source:** https://docs.stripe.com/changelog/basil/2025-03-31/checkout-session-remove-shipping-details
- **Replacement:** `session.collected_information.shipping_details`.

**ST-5. Upcoming invoice**

- **What died:** `GET /v1/invoices/upcoming`, `/upcoming/lines`; SDK `invoices.retrieveUpcoming`, `listUpcomingLines`, `upcoming`.
- **Source:** https://docs.stripe.com/changelog/basil/2025-03-31/invoice-preview-api-deprecations
- **Replacement:** `invoices.createPreview`.

**ST-6. Legacy usage billing**

- **What died:** `aggregate_usage`, `billing_thresholds` on subscription endpoints, metered prices with no meter, usage records (`usage_record_summaries`, `createUsageRecord`).
- **Source:** https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing
- **Replacement:** Billing Meters.
- **Requires:** a real migration, and a meter that a person must create. Read its ID from config and say so.

**ST-7. Total count on lists**

- **What died:** expanding `total_count` on lists.
- **Source:** https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-total-count-expansion
- **Replacement:** don't rely on it; paginate.

At or after `2025-09-30.clover`, source https://docs.stripe.com/changelog/clover (checked 2026-11-04):

**ST-8. redirectToCheckout**

- **What died:** `stripe.redirectToCheckout()` in Stripe.js.
- **Source:** https://docs.stripe.com/changelog/clover/2025-09-30/remove-redirect-to-checkout
- **Look for:** `redirectToCheckout`, where the `@stripe/stripe-js` version or `js.stripe.com/clover` loads the Clover release.
- **Applies to:** Stripe.js at Clover or later. Older Stripe.js still has it.
- **Replacement:** `window.location.href = session.url`, using the URL from a server-created Checkout Session. Client-only Checkout moves to Payment Links or Buy Buttons.
- **Requires:** the server must return `session.url`, not only the ID.

**ST-9. Discount coupon**

- **What died:** the `coupon` property on a Discount no longer auto-expands; Discount gains a `source` property.
- **Look for:** `discount.coupon.*` reads on a Stripe Discount object.
- **Source:** https://docs.stripe.com/changelog/clover/2025-09-30/add-discount-source-property
- **Replacement:** retrieve the coupon or expand it, per the changelog page, using the Discount's `source`.

**ST-10. Schedule iterations**

- **What died:** the `iterations` parameter on subscription schedule phases.
- **Source:** https://docs.stripe.com/changelog/basil/2025-08-27/remove_schedule_phase_iterations
- **Replacement:** the `duration` parameter on schedule phases.
- **Applies to:** at or after `2025-08-27.basil`.

**What is not a break:** a pinned or SDK-default version older than the removal, reading fields that exist at that version. Stripe keeps those working. Do not upgrade to "fix" it.
