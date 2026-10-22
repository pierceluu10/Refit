// Measures what running a job on a Fly Machine adds per job in the simulated flow: reading the
// carried state, the Machines API create and destroy calls, the machine fetching its inputs and
// returning its evidence over the job channel, and storing that evidence. Machine boot, dockerd
// start and validation image pulls on Fly are not simulated.
// Usage: npx tsx pipeline/hosted-runner-latency.ts [--runs <count>]
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { fakeFlyMachines, type FakeMachine } from './fixtures/fake-fly-machines.ts';
import { flyMachines } from './fly-machines.ts';
import { WebhookInputError } from './github-webhooks.ts';
import { jobChannel, runJobMachine } from './hosted-runner.ts';
import type { HostedTarget } from './hosted-store.ts';
import { respond } from './local-service.ts';

const KIB = 1024;
const MIB = 1024 * KIB;
const PERCENTILE_95 = 0.95;
const SCENARIOS = [
  { label: 'first job, nothing carried', carried: 0, evidence: 256 * KIB },
  { label: 'cached poll', carried: 64 * KIB, evidence: 16 * KIB },
  { label: 'Stripe-sized snapshot carried', carried: 8 * MIB, evidence: 1 * MIB },
  { label: 'new Stripe snapshot returned', carried: 16 * MIB, evidence: 16 * MIB },
];

const { values } = parseArgs({ options: { runs: { type: 'string', default: '20' } } });
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) throw new TypeError('--runs requires a positive integer.');

const root = await mkdtemp(join(tmpdir(), 'refit-job-latency-'));
const channel = jobChannel();
const server = createServer((request, response) => {
  void channel.handle(request, response).catch((error: unknown) => {
    respond(response, error instanceof WebhookInputError ? error.status : 500, {
      error: error instanceof Error ? error.message : 'unknown',
    });
    request.resume();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
let evidence = 0;
// The simulated machine fetches its inputs and reports at once, so all measured time is overhead.
const machine = (created: FakeMachine) => {
  void (async () => {
    const { REFIT_JOB_URL: url, REFIT_JOB_ID: job, REFIT_JOB_SECRET: secret } = created.config.env;
    const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
    await (await fetch(`${url}/jobs/${job}/inputs`, { headers })).json();
    const response = await fetch(`${url}/jobs/${job}/receipt`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        formatVersion: 1,
        job: Number(job),
        status: 'finished',
        receipt: { status: 'validated', output: null, message: null },
        files: [
          { path: `runs/${job}/evidence`, content: randomBytes(evidence).toString('base64') },
        ],
      }),
    });
    if (response.status !== 202) throw new Error(`Report refused with HTTP ${response.status}.`);
  })();
};
const fake = await fakeFlyMachines({
  app: 'refit-jobs-latency',
  token: 'latency',
  onCreate: machine,
});
const machines = flyMachines({ app: 'refit-jobs-latency', token: 'latency', api: fake.api });
const target = { id: '0123456789abcdef' } as HostedTarget;

try {
  console.log('| Scenario | Carried state | Evidence returned | Median | p95 |');
  console.log('|---|---|---|---|---|');
  let job = 0;
  for (const scenario of SCENARIOS) {
    const directory = await realpath(await mkdtemp(join(root, 'state-')));
    const state = join(directory, 'targets', target.id);
    await mkdir(join(state, 'snapshots'), { recursive: true });
    if (scenario.carried) {
      await writeFile(
        join(state, 'state.json'),
        JSON.stringify({ formatVersion: 1, jobs: {}, lastSource: 'source' }),
      );
      await writeFile(join(state, 'snapshots', 'source.json'), randomBytes(scenario.carried));
    }
    evidence = scenario.evidence;
    const timings: number[] = [];
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      const outcome = await runJobMachine({
        machines,
        channel,
        callback: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        job: ++job,
        target,
        retry: false,
        directory,
        github: { appId: '1', installationId: 1, token: 'latency' },
        image: 'registry.example/refit:job',
        region: 'iad',
        images: [],
        timeoutSeconds: 60,
        pollSeconds: 60,
        signal: new AbortController().signal,
      });
      if (outcome.status !== 'finished') throw new Error(outcome.receipt.message ?? 'Job failed.');
      timings.push(performance.now() - started);
    }
    timings.sort((left, right) => left - right);
    const at = (fraction: number) =>
      timings[Math.min(timings.length - 1, Math.floor(timings.length * fraction))];
    const size = (bytes: number) => (bytes >= MIB ? `${bytes / MIB} MiB` : `${bytes / KIB} KiB`);
    console.log(
      `| ${scenario.label} | ${size(scenario.carried)} | ${size(scenario.evidence)} | ${at(0.5).toFixed(0)} ms | ${at(PERCENTILE_95).toFixed(0)} ms |`,
    );
  }
} finally {
  server.close();
  server.closeAllConnections();
  await fake.close();
  await rm(root, { recursive: true, force: true });
}
