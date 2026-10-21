---
name: Refit
description: An engineering workbench for reviewed API migrations.
colors:
  primary: '#235bdf'
  primary-hover: '#194ac2'
  primary-tint: '#eef3ff'
  canvas: '#f9fafb'
  surface: '#ffffff'
  ink: '#171b24'
  secondary-text: '#606775'
  border: '#e1e5eb'
  code: '#161c28'
  positive: '#287252'
  negative: '#ad3e49'
  warning: '#8b570f'
  marketing-blue: '#0048d8'
  marketing-deep: '#003db8'
  marketing-secondary-text: '#c4d9ff'
typography:
  display:
    fontFamily: 'Geist Variable, sans-serif'
    fontSize: 'clamp(52px, 6.2vw, 88px)'
    fontWeight: 500
    lineHeight: 1.06
    letterSpacing: '-0.04em'
  headline:
    fontFamily: 'Geist Variable, sans-serif'
    fontSize: '48px'
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: '-0.04em'
  body:
    fontFamily: 'Geist Variable, sans-serif'
    fontSize: '14px'
    lineHeight: 1.7
  code:
    fontFamily: 'Geist Mono Variable, monospace'
    fontSize: '12px'
    lineHeight: 1.95
rounded:
  control: '6px'
  small-panel: '7px'
  workflow: '10px'
  marketing-control: '999px'
spacing:
  control-gap: '10px'
  mobile-gutter: '22px'
  desktop-gutter: '40px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.surface}'
    rounded: '{rounded.control}'
    padding: '14px 22px'
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '14px 22px'
---

# Design System: Refit

## Overview

An engineering workbench with the breathing room of a startup landing page. A migration travels from a provider specification through the blue Refit junction to readable evidence and a review boundary. Product-specific artifacts carry the visual identity.

Screenpipe, Nango, and Prized (for the waitlist page's blue palette) are UI/UX references only. Their source code, brand marks, and assets are not part of the implementation. Product truth lives in PRODUCT.md; every sample migration remains visibly illustrative.

## Colors

The waitlist page is royal blue (`marketing-blue`) with white type, `marketing-secondary-text` for supporting copy, a faded white dot grid behind the hero, and a deeper blue closing band. It's scoped by the `.blue-theme` wrapper, which swaps the tokens; the workflow preview inside it switches back to the light tokens so it reads as a real product surface.

Docs, the demo, and the workspace keep light neutral surfaces, near-black typography, and one blue brand accent. Dark code panels establish readable contrast. Green, amber, and red have semantic status roles and always accompany text or icons. Color is never the only status signal.

The normative values are above and implemented as custom properties in `src/styles.css`. Neutral foregrounds retain their contrast on both white and canvas surfaces.

## Typography

Geist Variable carries UI and display text. Geist Mono is reserved for paths, code, versions, and sequence data. Both are bundled locally through Fontsource.

Desktop hero text peaks at 88px, mobile at `clamp(40px, 10vw, 62px)`. Marketing headlines use 35–48px; workspace headings use 29–31px. Long-form docs use 14px body copy and a 720px content cap. Compact technical metadata is smaller than prose and does not carry essential instructions alone.

## Layout

Marketing content caps at 1160px; the hero object caps at 1050px. The API logo belt under the waitlist form shares that 1050px edge and fades out at both sides. Desktop layout uses generous separation between the narrative, process, control, review, FAQ, and closing sections. Fine rules describe groups and transitions rather than wrapping every paragraph in a card.

The workspace has a 224px persistent sidebar and a main content area. At 760px and below, navigation becomes a keyboard-contained drawer. Marketing navigation collapses at 640px. The workflow changes from a vertical step rail to a horizontal stage selector on phones. Code panels scroll independently so long lines do not widen the page.

## Elevation & Depth

Most hierarchy comes from borders and surface tones. The blue engine node has a small offset shadow; the primary CTA has a restrained shadow. The review illustration uses a slight rotation. There are no blurred background washes or decorative glass surfaces.

## Shapes

Controls use 5–6px radii, content panels 7–10px, and the hero engine 16px. Circular marks identify statuses. The Refit mark is an original pair of interlocking right-angle forms, reused in the favicon and product junction.

## Components

Primary actions use blue, secondary actions a bordered white surface, and workspace entry uses near-black. On the blue waitlist page, actions are white pills with blue text and the email field is a translucent pill.

The logo belt drifts left to right at a slow, constant speed (48s per loop) so people can click a moving logo. Each logo is a toggle button (`aria-pressed`): selected ones become white pills with a blue mark, and the belt keeps moving either way. It pauses only while a keyboard user is focused inside it; reduced motion stops it and wraps the logos into static rows. Brand marks come from Simple Icons (CC0) and only label the API choices. Fine-pointer hover changes surface color. Presses scale to 0.97; reduced-motion preferences remove the scale. Focus outlines are visible and use the brand color.

The workflow supports manual stages, autoplay once, pause, and replay. Manual selection pauses playback. Step dwell is 2200ms; offscreen and backgrounded walkthroughs stop advancing. Reduced motion disables autoplay and spatial motion. Hero text has a single 600ms entrance with a 60ms line stagger. Interactive durations are 160ms or 220ms with `cubic-bezier(0.23, 1, 0.32, 1)` for entrances.

The workspace separates impact states from run outcomes. Lists preserve filters in the URL, and detail tabs support deep links. The configuration builder previews and exports a local file; it does not pretend to save a server setting.

## Do's and Don'ts

- Do show the provider evidence, code context, and human-review boundary.
- Do label synthetic data and illustrative outcomes.
- Do preserve semantic heading order, keyboard access, visible focus, and reduced motion.
- Do use monospace for actual technical content.
- Don't copy reference branding or imply reference product features exist in Refit.
- Don't invent customers, performance metrics, live execution, or published PRs.
- Don't add automatic merging or a fake GitHub connection flow.
