// A job process for tests: the real child side of runJobProcess with a simulated job instead of
// runHostedTarget. REFIT_TEST_JOB_PROCESS picks how the job behaves.
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';

const { failedOutcome, runForkedProcess } = await tsImport('../hosted-runner.ts', {
  parentURL: import.meta.url,
  tsconfig: false,
});
const WORKER_SECRETS = ['REFIT_WEBHOOK_SECRET', 'REFIT_SERVICE_TOKEN', 'FLY_API_TOKEN'];
const SIGNAL_SETTLE_MS = 50;
const mode = process.env.REFIT_TEST_JOB_PROCESS;

await runForkedProcess(async (inputs, signal, onProgress) => {
  onProgress(`Running ${inputs.target.repository}.`);
  if (mode === 'crash') process.exit(3);
  if (mode === 'busy') {
    // Holds the CPU the way a large scan does, so this process's event loop answers nothing.
    const end = Date.now() + Number(process.env.REFIT_TEST_JOB_BUSY_MS);
    while (Date.now() < end);
  }
  if (mode === 'stop') {
    await once(signal, 'abort');
    onProgress('Stopping on SIGTERM.');
  }
  if (mode === 'hang') {
    setInterval(() => undefined, SIGNAL_SETTLE_MS);
    await new Promise(() => undefined);
  }
  // A SIGINT to the whole process group must not end the job.
  process.kill(process.pid, 'SIGINT');
  await delay(SIGNAL_SETTLE_MS);
  return {
    status: 'finished',
    receipt: {
      status: 'validated',
      output: null,
      message: JSON.stringify({
        inputs,
        secrets: WORKER_SECRETS.filter((name) => name in process.env),
        app: process.env.GITHUB_APP_ID ?? null,
        execArgv: process.execArgv,
      }),
    },
  };
}, failedOutcome);
