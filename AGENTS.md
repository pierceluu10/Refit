# Agent guide

This repository holds only the Refit website (`src/`, `public/`, `index.html`). The migration engine was removed on 2026-10-31; don't restore it here without the founders' say-so.

- Keep the design system in `DESIGN.md`. Polish, don't redesign, unless asked.
- Never commit environment files. Only the empty `.env.example` is tracked. The repository is intended to become public.
- Label illustrative examples. Don't invent customers, metrics or passing checks.
- Run typecheck, format check, tests and build before committing. Use conventional commit messages with no co-author trailers.
