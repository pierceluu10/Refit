import { parseArgs } from 'node:util';
import { inspectRepositoryReadiness } from './readiness.ts';
import { renderReadiness } from './readiness-presentation.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE =
  "Usage: refit doctor [--repository <git-root>] [--config <workflow.json>] [--integration <id>] [--json]\nChecks a repository's Refit setup: .refit.json, Git, contracts, SDK mappings, API-version evidence, dependency inputs and the Docker image. It runs no application code, installs, AI, downloads or GitHub requests.\nUses the repository root .refit.json unless --config names another workflow file; --repository selects the checkout. With no .refit.json committed, it checks the Stripe configuration Refit generates from the code (--json prints it as generated.configuration), with contracts saved by refit stripe-snapshot --version. Exit 2 means setup needs attention, and the first line says what to do next.";

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      config: { type: 'string' },
      integration: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const result = await inspectRepositoryReadiness(values);
    console.log(values.json ? JSON.stringify(result, null, 2) : renderReadiness(result));
    process.exitCode = result.status === 'needs-attention' ? 2 : 0;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'doctor'));
  process.exitCode = 1;
}
