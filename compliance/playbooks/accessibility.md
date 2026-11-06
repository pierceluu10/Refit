# Playbook: accessibility (European Accessibility Act, WCAG 2.2)

Guidance for a smart engineer, not rules. Refit doesn't give legal advice.

## What the rule's text points to

The European Accessibility Act applies from 28 June 2025 to products and services it lists, including e-commerce and consumer banking. Its requirements for web services are usually tested against WCAG 2.2 level AA. Whether a business is in scope is a question for people, not for the code.

## Where it shows up in code

- Forms (sign-up, login, checkout, contact): inputs without a `<label>`, `aria-label` or `aria-labelledby`; placeholder text used as the only label; errors shown only in colour.
- Images and icons: `<img>` without `alt`, icon-only buttons without an accessible name.
- Structure: headings out of order, clickable `<div>`s instead of `<button>`s, missing `lang` on `<html>`.
- Focus: sticky banners (cookie banners especially) covering the focused element (WCAG 2.4.11), focus outlines removed in CSS.
- Authentication: CAPTCHAs or puzzles with no alternative, paste blocked in password fields (WCAG 3.3.8).
- Contrast: text colours below 4.5:1 against their background.

## What to change

Make the smallest change the text points to: add labels and names, use native elements, keep focus visible and unobscured, allow paste and password managers. Don't redesign pages.

## What to check

- An axe-core scan of each touched page before and after, counting only new violations (O6's proof tool).
- Existing tests still pass.
- Note what a scan can't see: screen-reader experience, keyboard order across a flow, plain-language content.

## What a person must confirm

- Whether the product or service is in scope of the Act.
- Manual testing with assistive technology on the changed flows.
- Any accessibility statement the business publishes.

## Pitfalls

- `aria-*` attributes that contradict the visible label.
- Hiding content with `display: none` from everyone when it should only be visually hidden.
- Fixing a scan finding in one component while a copy of it lives elsewhere.
