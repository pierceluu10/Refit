import { parseArgs } from 'node:util';
import { checkStripe } from './check.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE =
  'Usage: refit stripe-check --repository <directory> --baseline <pinned-snapshot.json> --output <new-directory-outside-repository> [--propose-patch]';
try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      baseline: { type: 'string' },
      output: { type: 'string' },
      'propose-patch': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (!values.repository || !values.baseline || !values.output) {
    console.error(USAGE);
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify(
        await checkStripe({
          repository: values.repository,
          baseline: values.baseline,
          output: values.output,
          proposePatch: values['propose-patch'],
        }),
        null,
        2,
      ),
    );
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'stripe-check'));
  process.exitCode = 1;
}
