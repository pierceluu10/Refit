# Website agent guide

This branch holds only the Refit website. Do not add pipeline code here; it lives on `main`.

- Keep the design system in `DESIGN.md`: Geist, the blue accent, thin rules and light surfaces. Polish, don't redesign, unless asked.
- Never commit environment files. `.env.local` holds the Supabase values and is git-ignored; only the empty `.env.example` is tracked. Never put a Supabase secret key in a `VITE_` variable. The repository is intended to become public.
- Label illustrative examples. Don't invent customers, metrics or passing checks.
- Run typecheck, format check, tests and build before committing. Use conventional commit messages with no co-author trailers.
