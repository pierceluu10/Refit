#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const commands = new Map([
  ['scan', 'cli.ts'],
  ['run', 'workflow-cli.ts'],
  ['validate', 'validation-cli.ts'],
  ['stripe-snapshot', 'snapshot-cli.ts'],
  ['stripe-check', 'check-cli.ts'],
  ['replay', 'cli.ts'],
  ['demo', 'demo-cli.ts'],
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

Use refit <command> --help for command options.
--version prints the installed version. --help prints this guide.
AI, repair and publication are explicit opt-ins. Run never auto-merges.
`;
const command = process.argv[2];
try {
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
