import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { discoverStripeRevision, encodeSnapshot, fetchStripeSnapshot } from './snapshots.ts';
import { PipelineInputError } from './types.ts';
import { cliErrorMessage } from './cli-errors.ts';
import { DEFAULT_CONTRACTS_DIRECTORY, saveStripeContract } from './enrollment-contracts.ts';

const USAGE =
  "Usage: refit stripe-snapshot (--revision <full-commit-sha> | --latest) --output <new-snapshot.json>\n       refit stripe-snapshot --version <api-version> [--version <api-version>...] [--contracts <dir>]\nSaves Stripe's published OpenAPI document from github.com/stripe/openapi as a pinned snapshot. Use --latest for the contract to move to, and --revision with the stripe/openapi commit whose spec has your code's pinned API version for the contract you start from. --version saves the contracts a generated configuration reads (refit doctor names them) under --contracts, by default ~/.refit/contracts, and checks each against the commit and hash in data/stripe-openapi-versions.json.";

try {
  const { values } = parseArgs({
    options: {
      revision: { type: 'string' },
      latest: { type: 'boolean' },
      output: { type: 'string' },
      version: { type: 'string', multiple: true },
      contracts: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else if (values.version) {
    if (values.revision || values.latest || values.output)
      throw new PipelineInputError(
        'Choose --version, or --revision/--latest with --output, not both.',
      );
    const saved = [];
    for (const version of values.version) {
      const contract = await saveStripeContract(
        values.contracts ?? DEFAULT_CONTRACTS_DIRECTORY,
        version,
      );
      saved.push({ version, path: contract.path });
    }
    console.log(JSON.stringify(saved, null, 2));
  } else if (values.contracts)
    throw new PipelineInputError('--contracts is used only with --version.');
  else if ((!values.revision && !values.latest) || !values.output) {
    console.error(
      `refit stripe-snapshot: ${!values.output ? '--output <new-snapshot.json> is required' : 'choose --latest or --revision <full-commit-sha>'}.\n${USAGE}`,
    );
    process.exitCode = 1;
  } else {
    if (values.revision && values.latest)
      throw new PipelineInputError('Choose --revision or --latest, not both.');
    const snapshot = await fetchStripeSnapshot(values.revision ?? (await discoverStripeRevision()));
    await writeFile(values.output, encodeSnapshot(snapshot), { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify(
        {
          output: values.output,
          provider: snapshot.provider,
          revision: snapshot.revision,
          url: snapshot.url,
          hash: snapshot.hash,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(cliErrorMessage(error, 'stripe-snapshot'));
  process.exitCode = 1;
}
