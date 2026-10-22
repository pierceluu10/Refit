# Hosted job isolation: one machine per job

`refit hosted serve --job-machines` runs each hosted job on its own short-lived Fly Machine instead of on the worker VM's own Docker daemon. It is **off by default**. Without the flag the hosted worker behaves exactly as before.

Status (2026-10-22): implemented and tested against a simulated Machines API and a local PostgreSQL. It has **not** run on Fly: no job app, token or machine has been created. See [What is not verified](#what-is-not-verified).

## Why

Today one VM holds everything: the webhook listener, the database credentials, the GitHub App private key, and the Docker daemon that runs customers' checks. A container escape during validation would reach all of them, and that is why `REFIT_HOSTED_OWNER` limits hosted enrollment to the owner's own installations.

With `--job-machines`, the code a customer's checks run sits on a separate VM that holds only that one job's inputs.

## The model

| | Control process (`refit-hosted`) | Job machine (`REFIT_JOB_APP`) |
|---|---|---|
| Runs | webhooks, `/status`, leases, the job queue, the reaper | one job: `refit doctor`, scan, offline Docker validation (the existing `pollServiceTarget` path) |
| Holds | `REFIT_DATABASE_URL`, the App private key, webhook and service secrets, the Fly API token for the job app | that job's inputs only (below) |
| Lives | always on | from job start until it reports, fails, is cancelled or times out |

The job app is a **separate Fly app with no secrets**. This is required, not a convention: Fly injects an app's secrets into every Machine of that app, including Machines created through the Machines API ([Fly secrets](https://docs.fly.io/apps/secrets)). `refit hosted serve` refuses a `REFIT_JOB_APP` equal to `FLY_APP_NAME`.

### What a job machine receives

| Input | How |
|---|---|
| Job ID, job-channel URL, a per-job 256-bit secret | Machine environment |
| Validation images to pull (`REFIT_HOSTED_IMAGES`) | Machine environment; the entrypoint pulls them before the job, and validation runs with `--pull never` |
| The target (repository, base, integration) and its stored approval | Fetched from the job channel |
| A GitHub installation token with `contents: read` on that one repository, valid for at most an hour | Fetched from the job channel; minted by the control process when it confirms repository access |
| The target's carried watch state: `state.json`, the last captured specification, baselines and current documentation snapshots | Fetched from the job channel (`watchCarryOver` in `pipeline/watch.ts`), so a result for an unchanged revision is reused instead of revalidated |
| A deadline | Fetched from the job channel; the machine aborts the job itself when it passes |

It never receives database credentials, the App private key, the webhook or service secrets, the Fly API token, another target's state, or a token that can write. The job command deletes the channel secret from its environment before it runs anything.

## A job, step by step

1. The control process claims a job and keeps renewing its lease, as before.
2. It confirms repository access with the App key and keeps the read token that check minted.
3. It reads the target's carried state (at most 64 MiB) and opens a job-channel session with a fresh secret.
4. It creates the machine in the job app: `auto_destroy: true`, `restart: { policy: "no" }`, metadata `refit=job` and `refit_job=<id>`.
5. The machine's entrypoint starts `dockerd`, pulls the validation images, and runs `refit hosted job`. That command fetches its inputs, mirrors the control's state paths, checks out the repository with the read token, and runs the same `runHostedTarget` the in-VM worker runs.
6. The machine sends its receipt and every file the run created or changed (at most 64 MiB), then exits; Fly destroys it.
7. The control process validates the report, stores the evidence under the target's state directory, records the receipt, and destroys the machine (a machine already gone counts as destroyed).

### Every way a job ends

| Ending | What happens | Test |
|---|---|---|
| Report accepted | Receipt stored; machine destroyed | `runs a job on its own machine with only a read token…`, `runs an installed repository on a job machine…` |
| Job cancelled (repository or installation removed) or worker stopping | `interrupted` receipt; machine destroyed | `destroys the machine when the job is cancelled`, `destroys a running job machine when its repository is removed` |
| Timeout (60 minutes) | `error` receipt; machine destroyed; the machine also stops itself at its deadline | `destroys the machine when the job times out` |
| Machine exits without a report (crash, out of memory) | Detected by polling the machine every 15 seconds; `error` receipt at once instead of waiting for the timeout | `fails the job at once when its machine exits without a report` |
| Control process crashes | On every pass, the reaper lists `refit=job` machines and destroys each whose job is neither running in this process nor leased by another live worker. The job's lease expires, it is reclaimed and runs on a new machine | `reaps job machines that no live job owns`, `after a control crash, reaps the orphaned machine and reruns its job on a new one` |
| Evidence over 64 MiB | HTTP 413; the job fails; nothing is written | `caps the evidence a machine can return and the state it receives` |
| Carried state over 64 MiB | The job fails before any machine is created | same |

### The job channel

- It listens on `fly-local-6pn:8081`, the control VM's private network address, and is not exposed through the Fly proxy. Job machines in the same organization reach it over 6PN ([private networking](https://docs.fly.io/networking/private-networking)).
- Every request carries the job's secret, compared in constant time. An unknown job and a wrong secret get the same 401, so the channel never reveals which jobs run. A session closes when its job ends, after which its secret opens nothing.
- A job accepts one report (a second gets 409).
- A job machine runs customer code, so its report is untrusted. The receipt status must be a short lowercase word, a revision must be a commit ID, the evidence directory it names must be inside that target's state and must exist after the files are written, and every file path must be relative, inside the target, and outside `github/` and `approved-inputs/`. A report that fails any check fails the job with "Job machine evidence was refused" and HTTP 422. Messages are cut at 16 KiB.
- Forged reports (wrong secret, another job's URL) do not disturb the job; the genuine report is still accepted (`rejects forged receipts without disturbing the job…`).

What isolation does not cover: a compromised job machine can still write a wrong receipt and wrong evidence **for its own target**, which the next job for that target reads back as carried state. It cannot reach another target's state, the database, or the App key.

### The Machines API client

`pipeline/fly-machines.ts` sets a 30-second timeout on every request. It retries 429, 5xx and network failures up to four attempts (250 ms, 500 ms and 1 s apart, or the `Retry-After` value up to 10 s), and never retries other 4xx responses. A retried create can leave a duplicate machine behind; the reaper destroys it once its job ends.

## Configuration

`--job-machines` reads:

| Variable | Meaning |
|---|---|
| `REFIT_JOB_APP` | The job app. Must differ from `FLY_APP_NAME`. |
| `FLY_API_TOKEN` | A token scoped to the job app (`fly tokens create deploy -a <job app>`), so the control process cannot change its own app with it. |
| `REFIT_JOB_IMAGE` | Image for job machines. Defaults to `FLY_IMAGE_REF`, the image the control process runs. |
| `REFIT_JOB_REGION` | Defaults to `FLY_REGION`, so the job channel stays in one region. |
| `REFIT_HOSTED_IMAGES` | Validation images each job machine pulls. |

`--job-machines` refuses `--ai-patch` and `--publish-draft`:

- **AI patches** spend a per-installation budget whose ledger lives on the control VM. A job machine would need an allowance granted and settled by the control process; PG10 is moving the ledger into PostgreSQL per installation, which is the place to add that.
- **Draft publication** needs a token that can push and open pull requests. Giving one to the VM that runs customer code would undo most of the isolation, so it stays an owner decision ([below](#needs-owner-decision)).

## Machine size and region

| Setting | Value | Why |
|---|---|---|
| Guest | `shared`, 2 CPUs, 4096 MB (`JOB_GUEST`) | The same as the control VM today. The default validation profile gives the container 3 GiB of memory with its 2 GiB workspace on tmpfs, beside `dockerd` and the Node worker. |
| Larger profile | 8192 MB | Needed only with `REFIT_VALIDATION_WORKSPACE=4g` (a 5 GiB container); not configurable yet. |
| Region | The control's region (`iad` today) | Inputs and evidence cross the private network once per job; one region keeps that fast. |
| Root filesystem | Fly default | Docker data and the checkout live on the machine's root filesystem and disappear with it. |

## Added latency per job

Measured in the simulated flow on an Apple M5 laptop shared with other benchmark sessions, 20 runs per row, commit `c677bcc` plus the measurement script, with `npx tsx pipeline/hosted-runner-latency.ts --runs 20`. The simulated machine reports at once, so the time is all overhead: reading carried state, the create and destroy calls to a local Machines API, the input download, the evidence upload and storing it.

| Scenario | Carried state | Evidence returned | Median | p95 |
|---|---|---|---|---|
| first job, nothing carried | 0 KiB | 256 KiB | 9 ms | 51 ms |
| cached poll | 64 KiB | 16 KiB | 7 ms | 209 ms |
| Stripe-sized snapshot carried | 8 MiB | 1 MiB | 56 ms | 91 ms |
| new Stripe snapshot returned | 16 MiB | 16 MiB | 230 ms | 490 ms |

The p95 column is noisy because other sessions shared the laptop.

Not measured, and larger: creating a Fly Machine fetches the image and builds its root filesystem, which Fly describes as "maybe low double digit seconds", while booting an assembled machine usually takes well under a second ([Machines overview](https://docs.fly.io/machines/overview)). Each new machine then starts `dockerd` and pulls the validation images, which the control VM has cached today. Expect each job to add tens of seconds, mostly before the job starts. Today every scheduled poll (every 300 seconds by default) is a job, so every poll would pay it, including polls that reuse a saved result. Fly documents that starting a stopped machine is faster than creating one and that starting clears filesystem changes, so a pool of stopped job machines is the likely next step if this cost matters.

## What is not verified

- Nothing ran on Fly. The Machines API calls follow Fly's API reference ([list](https://docs.fly.io/api/machines/machines/list-machines), [destroy](https://docs.fly.io/api/machines/openapi.json)) and run against a local simulation.
- Whether a Machine in the job app may use the control app's image (`registry.fly.io/refit-hosted:…`) has not been checked; set `REFIT_JOB_IMAGE` if it may not.
- Reachability of `fly-local-6pn:8081` from another app in the organization is from Fly's documentation, not observed.
- The Docker-backed end-to-end test (`validates on a job machine in offline Docker…`) needs `REFIT_POSTGRES_URL`, `REFIT_DOCKER_IMAGE=node:22-alpine` and `REFIT_OASDIFF=1`. In it the control process and the simulated machine share one filesystem, so the unit tests, not this one, show that evidence crosses the channel.

## Needs owner decision

1. **Lifting the `REFIT_HOSTED_OWNER` restriction.** Job machines remove the database credentials and App key from the VM that runs customer code, which is the reason for the restriction. Before other accounts enroll, the remaining gaps are: per-installation job and inventory caps and a per-installation AI ledger (PG10), a decision on draft publication (next item), and a first run on Fly.
2. **Draft publication from job machines.** Either give the machine a short-lived write token for its one repository (simple; a container escape could then push to that repository), or have the control process publish from the machine's report after checking it (keeps write access off the machine; more code). Until then `--job-machines` refuses `--publish-draft`.
3. **Creating Fly resources.** A job app with no secrets and a deploy token scoped to it, set as `FLY_API_TOKEN` on the control app, and `REFIT_HOSTED_FLAGS` gains `--job-machines` and loses `--ai-patch` and `--publish-draft`. Nobody has created these.
4. **Cost per poll.** Every scheduled poll creates a machine (see above). A pool of stopped machines, or a cheaper control-side check before creating one, would cut it.
