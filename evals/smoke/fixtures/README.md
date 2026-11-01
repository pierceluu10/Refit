# Smoke fixtures

Three tiny synthetic repos, one per dev set, written by hand for the smoke test. They stand in
for real dev-set repos (named in `smoke/smoke.ts`) so the smoke run needs no network, no clone
and no install. Nothing here is ever executed: the fake pipeline only reads and edits the files.

They are illustrative examples, not copies of the real repos.
