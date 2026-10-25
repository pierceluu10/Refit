// An inventory process for tests: the real child side of runInventoryProcess with a simulated
// inventory instead of refreshInventory. REFIT_TEST_INVENTORY_PROCESS picks how it behaves.
import { tsImport } from 'tsx/esm/api';

const { runForkedProcess } = await tsImport('../hosted-runner.ts', {
  parentURL: import.meta.url,
  tsconfig: false,
});
const { PipelineInputError } = await tsImport('../types.ts', {
  parentURL: import.meta.url,
  tsconfig: false,
});
const WORKER_SECRETS = ['REFIT_WEBHOOK_SECRET', 'REFIT_SERVICE_TOKEN', 'FLY_API_TOKEN'];
const mode = process.env.REFIT_TEST_INVENTORY_PROCESS;

await runForkedProcess(
  async (inputs, _signal, onProgress) => {
    onProgress(`Inventorying ${inputs.repository}.`);
    // Holds the CPU forever, the way the TypeScript analysis of a large repository does, so neither
    // its own time cap nor SIGTERM can run.
    if (mode === 'busy') for (;;);
    if (mode === 'fail') throw new PipelineInputError('GitHub did not report the default branch.');
    return {
      result: {
        outcome: 'complete',
        base: 'main',
        revision: 'b'.repeat(40),
        inventory: {
          inputs,
          secrets: WORKER_SECRETS.filter((name) => name in process.env),
          app: process.env.GITHUB_APP_ID ?? null,
        },
      },
    };
  },
  (error) => ({ error: `${error.name}: ${error.message}` }),
);
