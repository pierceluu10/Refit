# Refit website (pre-launch)

The Refit marketing site in waitlist mode, kept apart from the main codebase so the site can change without touching the migration pipeline. The product code lives on `main`.

## Run it

Requires Node.js 22.12+.

```sh
npm ci
cp .env.example .env.local   # then fill in the two Supabase values
npm run dev
```

Without `.env.local` the site still runs; the form shows "The waitlist isn't connected yet".

## What's here

- `src/pages/Waitlist.tsx`: the home page, with the signup form, the interactive walkthrough and how it works.
- `src/components/WaitlistForm.tsx` and `src/waitlist.ts`: the form and the Supabase insert.
- `src/pages/`: the other pages (`/demo`, `/docs`, `/app` workspace preview). The old full landing page is `Landing.tsx`.
- `supabase/migrations/`: the waitlist table and its insert-only policy.
- `docs/WAITLIST.md`: Supabase setup and behavior.
- `DESIGN.md`, `PRODUCT.md`, `.impeccable/`: the design system and product context the design tools read.

## Checks

```sh
npm run typecheck && npm run format:check && npm test && npm run build
```
