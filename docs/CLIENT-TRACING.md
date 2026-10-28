# Finding Stripe calls by type

Written 2026-10-28.

## The gap

Refit traces a Stripe call by following code from `new Stripe(...)` to its use. Real apps reach the client in many other ways, and each one has needed its own hand-written tracer:

- `factory-clients.ts`: `getStripe()`, lazy `let`, Proxy forwarders;
- `class-clients.ts`: constructor fields;
- `client-modules.ts`: re-exporting modules.

Each new pattern is another blind spot:

- **progress-30** (the unseen set, totals only): 6 of 30 repos had 10–30 Stripe calls each and **0 traced**, so Refit couldn't say whether anything breaks.
- **The Oct 16 active-teams set** (`docs/benchmarks/2026-10-16-stripe-active-repos.json`, 66 repos): 518 likely Stripe calls in 32 repos, none traced, mostly lazy factories.

The type checker is already in Refit (`pipeline/stripe-type-evidence.ts`), but only to confirm removed-field _reads_ on objects it can resolve. It never finds _calls_.

## The fix

Ask TypeScript's checker for the type of each call's receiver, instead of following the client's path. A call `x.<resource>.<method>(…)` is a Stripe call when `x.<resource>` resolves to a stripe-node resource class (`Stripe.Checkout.SessionsResource`, `Stripe.InvoicesResource` and so on) from the `stripe` package's own declarations.

One rule covers factories, dependency injection (NestJS and others), `ctx.stripe`, `req.app.locals.stripe`, class fields, re-exports and Proxy wrappers. The existing tracers stay, and type tracing adds the calls they miss.

1. **A type-traced call is a traced call.** It has the same resource, method and argument information as an analyzer-traced one, so the same rules, contract diff, patching and checks apply.
2. **Casts can lie.** A receiver whose type comes from `as Stripe`, `as any`, `<Stripe>`, `any` or `unknown` along its path is not traced. Only a type the checker inferred or that was declared from the `stripe` import counts.
3. **It runs offline.** It uses the repository's sources plus the stripe package (the installed one, or `--stripe-package` / Refit's bundled copy, through `stripePackageDirectory`). Respect `MAX_TYPED_FILES`, and say when a repository is too large.
4. **Plain JavaScript gets a fallback.** In `.js` files without types, trace a function or module whose return or export is a `new Stripe(...)`. Record it as `traceSource: "js-return"` with lower confidence, and report it separately.
5. **Every traced call records how it was traced:** `traceSource` is `analyzer`, `type` or `js-return`. Reports, the benchmark results (`tracedCalls` split by source) and the bench monitor show it.

## How to measure

- **Dev set:** the Oct 16 active-teams list, 66 repos, run once before and once after. It's small enough to run whole.
- **Report:**
  - traced calls against detected calls, overall and for the 32 repos with untraced calls;
  - affected repos found;
  - validated;
  - version bumps, if Agent V's work is merged;
  - wrong edits.
- **Hand-check 30 type-traced calls:** is the receiver really a Stripe client? Any false trace blocks the merge.
- **Never open progress-30 repos.** Rerun progress-30 once, after merge, for the headline number.

## Rules

- Founder decision, 2026-10-28: a type-checker result naming a Stripe type counts as evidence of Stripe usage.
- No repo-specific code; tests written from scratch for each pattern: lazy factory, NestJS injection, ctx field, class field, re-export, Proxy, a cast that lies (stays untraced), and a JS factory.
- Agent S owns `pipeline/migration-review.ts` (repair provenance) and Agent V owns the version-bump outcome. Don't edit their files; coordinate through the PR.
- No full l2-push-249 or heldout-30 runs.
