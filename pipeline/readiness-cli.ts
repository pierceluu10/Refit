import { parseArgs } from 'node:util';
import { inspectRepositoryReadiness } from './readiness.ts';
import { renderReadiness } from './readiness-presentation.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE =
  'Usage: refit doctor [--repository <git-root>] [--config <workflow.json>] [--integration <id>] [--json]\nDefaults to the repository root .refit.json. External workflow files can use --repository to select a local checkout. Checks Git, contracts, adapter coverage, API-version evidence, npm preparation inputs and the existing Docker image. No application code, installs, AI, source downloads or GitHub requests are run. Exit 2 means setup needs attention; passing checks permit an attempt at validation, not approval or activation.';

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
