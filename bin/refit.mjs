#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const commands = new Map([
  ['scan', 'cli.ts'],
  ['run', 'workflow-cli.ts'],
  ['adapter-suggest', 'adapter-suggest-cli.ts'],
  ['validate', 'validation-cli.ts'],
  ['stripe-snapshot', 'snapshot-cli.ts'],
  ['source-snapshot', 'source-snapshot-cli.ts'],
  ['shopify-snapshot', 'shopify-snapshot-cli.ts'],
  ['stripe-check', 'check-cli.ts'],
  ['replay', 'cli.ts'],
  ['demo', 'demo-cli.ts'],
  ['verify', 'verification-cli.ts'],
  ['watch', 'watch-cli.ts'],
  ['serve', 'service-cli.ts'],
  ['prepare', 'preparation-cli.ts'],
  ['doctor', 'readiness-cli.ts'],
  ['enroll', 'enrollment-cli.ts'],
  ['hosted', 'hosted-cli.ts'],
  ['agents', 'agents-cli.ts'],
  ['deadlines', 'deadlines-cli.ts'],
  ['meta-graph', 'meta-graph-cli.ts'],
  ['paypal', 'paypal-cli.ts'],
  ['slack', 'slack-cli.ts'],
  ['cloudflare', 'cloudflare-cli.ts'],
  ['github-api', 'github-api-cli.ts'],
  ['cloud-sdk', 'cloud-sdk-cli.ts'],
  ['messaging', 'messaging-cli.ts'],
  ['shopify-rest', 'shopify-rest-cli.ts'],
  ['report', 'report-cli.ts'],
  ['api-hosts', 'api-hosts-cli.ts'],
  ['classify-release', 'release-classification-cli.ts'],
  ['ai-migrations', 'ai-migrations-cli.ts'],
  ['rules', 'rules-cli.ts'],
]);
const usage = `Refit: reviewable API migrations

Start in your repository:
  refit agents              See which provider agents apply
  refit agents --add <id>   Write .refit.json for one and list the contracts to save
  refit doctor              Check the setup without running any code
  refit run                 Scan, propose and validate a migration

Usage: refit <command> [options]

  scan             Analyze a local repository against two specifications
  run              Scan, propose, validate and optionally publish a draft PR
  adapter-suggest  Suggest a provider adapter from observed SDK calls and OpenAPI
  validate         Validate a proposal in restricted Docker containers
  stripe-snapshot  Download a pinned or latest Stripe specification
  source-snapshot  Save a pinned OpenAPI snapshot for any provider
  shopify-snapshot Download a supported Shopify Admin API GraphQL schema
  stripe-check     Discover the latest Stripe spec and compare a saved baseline
  replay           Scan the bundled historical Stripe example
  demo             Run a real-SDK migration demo against a simulated Stripe API
  verify           Verify hashes and sizes in a saved evidence directory
  watch            Monitor an OpenAPI source and process each detected change once
  serve            Run installed repository workers with signed GitHub webhooks
  prepare          Prepare locked npm dependencies for offline validation
  doctor           Inspect repository setup without running code or spending on AI
  enroll           Review and approve a checked-in repository workflow
  hosted           Run the PostgreSQL-backed hosted service or store an approval
  agents           Detect provider SDKs and add matching agents to .refit.json
  deadlines        List pinned API versions and models with provider sunset dates
  meta-graph       List Meta Graph API requests with version, edge and fields (review only)
  paypal           List PayPal REST requests with method, path and published operation (review only)
  slack            List Slack Web API methods called, with Slack's deprecations (review only)
  cloudflare       List Cloudflare API requests and Workers compatibility dates (review only)
  github-api       List GitHub REST, GraphQL and version-header use with deprecations (review only)
  cloud-sdk        List AWS SDK v2 and v3 clients and legacy Azure SDK packages (review only)
  messaging        List deprecated Twilio and Mailgun calls and retired messaging SDKs (review only)
  shopify-rest     List Shopify REST Admin calls to endpoints a later API version removes (review only)
  report           Report a repository's provider integrations, deadlines and AI model calls
  api-hosts        List the external HTTP API hosts a repository calls (review only)
  classify-release Classify a Stripe release's breaking changes with AI and score the catalog
  ai-migrations    Upgrade AI SDK majors with the providers' documented mappings, and check those rules
  rules            Check (and generate) the vendor rule tables in data/rules

Use refit <command> --help for command options.
Use --env <path> to load credentials explicitly. Existing environment values take precedence.
--version prints the installed version. --help prints this guide.
AI, repair and publication are explicit opt-ins. Run never auto-merges.
`;
try {
  const environmentOptions = process.argv
    .slice(2)
    .map((argument, index) => ({ argument, index: index + 2 }))
    .filter(({ argument }) => argument === '--env' || argument.startsWith('--env='));
  if (environmentOptions.length > 1) throw new TypeError('Supply --env only once.');
  if (environmentOptions.length) {
    const { argument, index } = environmentOptions[0];
    const separateValue = argument === '--env';
    const path = separateValue ? process.argv[index + 1] : argument.slice('--env='.length);
    if (!path || path.startsWith('--')) throw new TypeError('--env requires a file path.');
    process.argv.splice(index, separateValue ? 2 : 1);
    const environment = parseEnv(await readFile(path, 'utf8'));
    for (const [name, value] of Object.entries(environment)) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
  }
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') console.log(usage);
  else if (command === '--version') {
    const metadata = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    console.log(metadata.version);
  } else if (!commands.has(command)) {
    console.error(`Unknown command: ${command}\n${usage}`);
    process.exitCode = 1;
  } else {
    process.argv.splice(2, 1);
    if (command === 'replay') {
      const fixture = (name) =>
        fileURLToPath(new URL(`../pipeline/fixtures/${name}`, import.meta.url));
      process.argv.push(
        '--repository',
        fixture('repository'),
        '--before',
        fixture('before.json'),
        '--after',
        fixture('after.json'),
      );
    }
    const { tsImport } = await import('tsx/esm/api');
    await tsImport(`../pipeline/${commands.get(command)}`, {
      parentURL: import.meta.url,
      tsconfig: false,
    });
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
