#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const commands = new Map([
  ['scan', 'cli.ts'],
  ['run', 'workflow-cli.ts'],
  ['validate', 'validation-cli.ts'],
  ['stripe-snapshot', 'snapshot-cli.ts'],
  ['stripe-check', 'check-cli.ts'],
  ['replay', 'cli.ts'],
  ['demo', 'demo-cli.ts'],
  ['verify', 'verification-cli.ts'],
  ['watch', 'watch-cli.ts'],
]);
const usage = `Refit: reviewable API migrations

Usage: refit <command> [options]

  scan             Analyze a local repository against two specifications
  run              Scan, propose, validate and optionally publish a draft PR
  validate         Validate a proposal in restricted Docker containers
  stripe-snapshot  Download a pinned or latest Stripe specification
  stripe-check     Discover the latest Stripe spec and compare a saved baseline
  replay           Scan the bundled historical Stripe example
  demo             Run a real-SDK migration demo against a simulated Stripe API
  verify           Verify hashes and sizes in a saved evidence directory
  watch            Monitor an OpenAPI source and process each detected change once

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
