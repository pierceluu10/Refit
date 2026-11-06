# Playbook: privacy (GDPR, ePrivacy cookie consent, CCPA)

Guidance for a smart engineer, not rules. Refit doesn't give legal advice.

## What the rule's text points to

- ePrivacy Article 5(3): storing or reading information on a user's device (non-essential cookies, local storage, tracking pixels) needs consent first.
- GDPR Article 7(3): withdrawing consent must be as easy as giving it.
- GDPR Articles 15 and 17: people can ask for access to and erasure of their personal data.
- CCPA: deletion and access requests, and the right to opt out of sale or sharing, including opt-out preference signals such as Global Privacy Control.

## Where it shows up in code

- Analytics and ad scripts (Google Analytics, Segment, Meta Pixel and others) loaded unconditionally in the page head or a root layout, before any consent check.
- Cookie banners whose "Reject" is missing, harder to reach than "Accept", or not wired to anything.
- No route, job or admin action that exports or deletes a user's data.
- Sign-up forms with pre-ticked marketing boxes.
- No handling of the `Sec-GPC` header or `navigator.globalPrivacyControl`.

## What to change

- Gate non-essential scripts and cookies on recorded consent; load them only after it.
- Make reject and withdraw as easy as accept.
- Where a data export or deletion path is missing, add the smallest working one and say in the PR what it covers and what it doesn't (backups, third-party processors).

## What to check

- The list of scripts and cookies set on first load, before and after, with no consent given.
- Tests for the consent gate and for any export or deletion path added.

## What a person must confirm

- Which scripts are strictly necessary, and the lawful basis for each kind of processing.
- The banner's wording and the privacy notice.
- Whether CCPA applies to the business, and whether it sells or shares personal information.
- Retention periods and what deletion must reach beyond this codebase.

## Pitfalls

- Server-side tracking that sets cookies regardless of the banner.
- Tag managers that load other tags the code never names.
- Consent stored in a way the analytics script reads before it's set.
