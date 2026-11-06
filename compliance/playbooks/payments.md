# Playbook: payments (PSD2 Strong Customer Authentication, PCI DSS 4.0)

Guidance for a smart engineer, not rules. Refit doesn't give legal advice.

## What the rule's text points to

- PSD2 Article 97 and the RTS (applied from 14 September 2019): strong customer authentication when a payer initiates an electronic payment, using two of knowledge, possession and inherence. For a merchant's code this usually means the payment flow must handle 3D Secure challenges.
- PCI DSS 4.0 requirement 6.4.3 (required from 31 March 2025): every script on the payment page is authorized, its integrity is assured, and an inventory with a justification for each script is kept.
- PCI DSS 4.0 requirement 11.6.1 (required from 31 March 2025): a change- and tamper-detection mechanism for payment pages' scripts and security-impacting HTTP headers.

## Where it shows up in code

- Card payments created and confirmed server-side without handling `requires_action` (Stripe) or the provider's equivalent challenge step.
- Older APIs that can't do 3D Secure (for example Stripe's Charges API with tokens).
- Checkout pages that load analytics, chat widgets or tag managers next to the card form.
- Third-party scripts without Subresource Integrity (`integrity` attributes), and no Content Security Policy on the checkout route.

## What to change

- Move to a flow that handles authentication challenges (for example Stripe PaymentIntents or Checkout) when the code can't.
- Remove scripts the payment page doesn't need; add `integrity` and `crossorigin` to the ones it keeps where the provider serves fixed files; add a Content Security Policy scoped to the checkout route.
- Write the script inventory into the PR body: each script, where it loads, and a placeholder for the business justification a person fills in.

## What to check

- The list of scripts loaded on each checkout page, before and after (O6's proof tool).
- Payment tests still pass, including a test-mode challenge where the provider offers one.

## What a person must confirm

- The business justification for each remaining script.
- The merchant's PCI DSS scope and who runs the tamper-detection mechanism (code alone usually can't).
- Exemptions from SCA the payment provider applies.

## Pitfalls

- Provider scripts (Stripe.js) change often and are served without fixed hashes; don't pin an integrity hash the provider will break.
- A CSP that blocks the provider's iframe or 3D Secure redirect.
- Hosted payment pages move most of 6.4.3 to the provider; say so instead of changing code that isn't in scope.
