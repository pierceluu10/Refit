import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scanCloudSdkClients, type CloudSdkScan } from './cloud-sdk-clients.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit cloud-sdk [--repository <root>] [--json]
Lists the cloud SDK clients a repository constructs: AWS SDK for JavaScript v2 clients (new AWS.S3(), new S3() from aws-sdk/clients/s3), whose support ended on 2025-09-08, each with the v3 package that replaces it; v3 clients (new S3Client() from @aws-sdk/client-s3), so a half-finished migration is visible; and where each retired legacy Azure SDK package is loaded, with Microsoft's replacements. Each shows file:line and the registry deadline.
Review only: nothing is changed, installed, run or sent to AWS or Azure.`;

const LABELS: Record<string, string> = {
  'aws-sdk-v2': 'AWS SDK v2',
  'aws-sdk-v3': 'AWS SDK v3',
  'azure-legacy': 'Azure legacy',
};

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const root = resolve(values.repository ?? '.');
    const scan = await scanCloudSdkClients(root);
    if (values.json)
      console.log(
        JSON.stringify({ repository: root, checkedAt: new Date().toISOString(), ...scan }),
      );
    else print(root, scan);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}

function print(root: string, scan: CloudSdkScan) {
  console.log(`Refit cloud SDK clients  ${terminalText(root)}`);
  console.log('Review only: nothing was changed or sent to AWS or Azure.');
  if (!scan.clients.length) {
    console.log('\nNo AWS SDK client or legacy Azure SDK package was found.');
    return;
  }
  console.log('\nServices');
  for (const row of scan.services) {
    const replacement = row.replacement?.length ? `  -> ${row.replacement.join(', ')}` : '';
    console.log(
      `  ${LABELS[row.sdk].padEnd(13)} ${terminalText(row.service)}: ${row.live} live, ${row.test} in tests${terminalText(replacement)}`,
    );
  }
  for (const client of scan.clients.filter((item) => item.use === 'live')) {
    const deadline = client.deadline ? `  (support ended ${client.deadline.date})` : '';
    console.log(
      `\n${terminalText(`${client.file}:${client.line}`)}  ${LABELS[client.sdk]} ${terminalText(client.name)}${deadline}`,
    );
    console.log(`  ${terminalText(client.text)}`);
  }
}
