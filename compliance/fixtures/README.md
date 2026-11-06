# compliance fixtures

Example data for tests. Nothing here is a real customer, a real scan result or a saved copy of an official page.

- `official/`: excerpts of the official texts the rules agent reads, transcribed from memory on 2026-11-06 because the session that wrote them could not reach the official sites. Each file says so at the top. Replace them with saved snapshots (`compliance/scripts/save-fixtures.ts`) on a machine that can reach the sources, and check the wording against the live pages before trusting any quote.
- `demo-next-web-surfaces.json`: an illustrative surfaces inventory shaped like what P5 should report for the `demo-next-web` sample repo (checkout page, cookie banner, sign-up form). Written by hand, not produced by P5.
- `demo-next-web/`: a few illustrative files for the matcher's read-only repo tools.
