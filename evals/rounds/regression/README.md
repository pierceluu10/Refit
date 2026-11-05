# Regression check on the 3 test repos

These repos have been seen, so this is a check and never the score (`docs/rebuild/OTABEK.md`, O2). It
asks one thing: does the full product, on the real scanner, fix the breaks the 2026-11-04 test found?

The required changes come from the "must flag" table in P4 of `docs/rebuild/PIERCE.md`, plus the
Groq and picker lines the real scanner found in Clario and Code-Review-Agent. Locked before the run.
Each Stripe lock asks that the sole read of the removed field is gone, and allows the fallback the
list's `requires` line asks for, as in round 2.
