# Smoke fixtures

Three tiny synthetic repos, one per dev set, written by hand for the smoke test. They stand in
for real dev-set repos (named in `smoke/smoke.ts`) so the smoke run needs no network, no clone
and no install. Nothing here is ever executed: the fake pipeline only reads and edits the files.

They are illustrative examples, not copies of the real repos.

The MVP smoke test (`smoke/mvp.ts`) adds three more, one per sample repo in MVP-PLAN.md section 5:
`demo-node-api`, `demo-python-app` and `demo-next-web`. They stand in for the private repos in the
`refit-dev` test org and carry the dependencies the demo needs: end-of-life Node and Python, an old
model id, an old Next.js major, old GitHub Actions versions, a removed Kubernetes API version and a
retired Lambda runtime. Each says so in its own README.
