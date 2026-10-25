# Stripe currency codes in endive

`2026-09-30.endive` gives request `currency` fields the `currency` format, for example `line_items[].price_data.currency` on `POST /v1/checkout/sessions` and `default_price_data.currency` on `POST /v1/products`. oasdiff reports it as "the `…/currency` request property `format` changed from `none` to `currency`". Stripe's [supported currencies page](https://docs.stripe.com/currencies), read on 2026-10-24, says: "Make sure to use all lowercase letters when entering the three-letter ISO code in any payment request."

## What Refit does

With `--full-diff`, the reach gate (`pipeline/operation-reach.ts`) reads the currency every traced call sends:

| The call sends                                                                                                                           | Reach                  | Patch                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| A lowercase literal, such as `'usd'`                                                                                                     | `compatible`           | None                                                       |
| An uppercase literal written in the call's own request, such as `currency: 'USD'` or `line_items: [{ price_data: { currency: "INR" } }]` | `handled`              | The literal becomes `'usd'` or `"inr"`, keeping its quotes |
| A constant, even one Refit can read (`const CURRENCY = 'USD'`)                                                                           | `reached`              | None; the run stops                                        |
| A literal outside the call's argument, such as a local `line_items` array                                                                | `reached`              | None; the run stops                                        |
| A computed value, template with substitutions or spread                                                                                  | `reached` or `unknown` | None; the run stops                                        |

The rule (`stripe-lowercase-currency-code`) edits only a quoted literal of exactly three ASCII letters with at least one uppercase letter, and nothing else in the file. A constant is left alone because the code may also display it. Test files send no production request, so they are neither checked nor edited.

A lowercase code is valid under every API version, so the edit does not depend on moving the pin. It rides in the same deterministic patch as the pin move and the other Stripe rules, and the draft says "Sends the currency `usd` in lowercase" for each file it changes, linking the page above.

## Evidence

In the push-279 benchmark (refit-bench run 40146076045), 17 repositories stopped in production mode only on this change, each with an uppercase literal: 16 send `line_items/items/price_data/currency` as `USD` or `INR` on `checkout.sessions.create`, and `sudeepmahato16/airbnb-clone` sends `default_price_data/currency` as `USD` on `products.create`. Scanned again with this rule at their benchmark commits, against the Stripe contracts of their pinned versions and endive, all 17 became `handled` with no operation impact left, and each proposed patch changes one currency line: the literal, lowercased. Their checks were not run for this change.

The tests in `pipeline/operation-reach.test.ts` use shortened calls from `Hombre2014/Genius` (`375bbe7`), `psykat1116/Planit` (`0cbae47`) and `sudeepmahato16/airbnb-clone` (`fe8a793`, CRLF line endings); the end-to-end case runs real oasdiff when `REFIT_OASDIFF=1`.
