import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const PACK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const { values } = parseArgs({
  options: { output: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help) console.log('Usage: npm run package:cli -- --output <new-directory>');
else {
  const output = resolve(values.output ?? join(root, 'dist-cli'));
  const stage = await mkdtemp(join(tmpdir(), 'refit-package-'));
  try {
    await mkdir(output, { mode: 0o700 });
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const dependencies = {};
    for (const name of [
      'diff',
      'fast-xml-parser',
      'parse5',
      'tsx',
      'typescript-compiler',
      'yaml',
    ]) {
      const installed = JSON.parse(
        await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
      );
      dependencies[name] =
        installed.name === name ? installed.version : `npm:${installed.name}@${installed.version}`;
    }
    await writeFile(
      join(stage, 'package.json'),
      `${JSON.stringify({ name: metadata.name, version: metadata.version, description: 'Local API migration agent with reviewable patches and isolated validation', private: true, type: 'module', engines: metadata.engines, bin: { refit: 'bin/refit.mjs' }, files: ['bin/', 'pipeline/', 'README.md', 'docs/', 'examples/', 'public/', '.env.example'], dependencies }, null, 2)}\n`,
    );
    await mkdir(join(stage, 'bin'));
    await copyFile(join(root, 'bin/refit.mjs'), join(stage, 'bin/refit.mjs'));
    await chmod(join(stage, 'bin/refit.mjs'), 0o755);
    await mkdir(join(stage, 'pipeline'));
    await copyFile(
      join(root, 'pipeline/stripe-sdk-metadata.json'),
      join(stage, 'pipeline/stripe-sdk-metadata.json'),
    );
    for (const name of await readdir(join(root, 'pipeline'))) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts'))
        await copyFile(join(root, 'pipeline', name), join(stage, 'pipeline', name));
    }
    await cp(join(root, 'pipeline/fixtures'), join(stage, 'pipeline/fixtures'), {
      recursive: true,
    });
    await cp(join(root, 'examples'), join(stage, 'examples'), { recursive: true });
    const cliGuide = await readFile(join(root, 'docs/CLI.md'), 'utf8');
    await writeFile(
      join(stage, 'README.md'),
      cliGuide
        .replaceAll('](GITHUB-APP.md)', '](docs/GITHUB-APP.md)')
        .replaceAll('](TEST-REPOSITORIES.md)', '](docs/TEST-REPOSITORIES.md)')
        .replaceAll('](AUTOMATION.md)', '](docs/AUTOMATION.md)')
        .replaceAll('](LOCAL-SERVICE.md)', '](docs/LOCAL-SERVICE.md)')
        .replaceAll('](DEPENDENCIES.md)', '](docs/DEPENDENCIES.md)')
        .replaceAll('](ENDPOINT-MIGRATIONS.md)', '](docs/ENDPOINT-MIGRATIONS.md)')
        .replaceAll('](REPOSITORY-SETUP.md)', '](docs/REPOSITORY-SETUP.md)')
        .replaceAll('](APP-ONBOARDING.md)', '](docs/APP-ONBOARDING.md)')
        .replaceAll('](VENDOR_NOTES.md)', '](docs/VENDOR_NOTES.md)')
        .replaceAll('](API-VERSIONS.md)', '](docs/API-VERSIONS.md)')
        .replaceAll('](MULTIPLE-INTEGRATIONS.md)', '](docs/MULTIPLE-INTEGRATIONS.md)')
        .replaceAll('](REQUEST-MIGRATIONS.md)', '](docs/REQUEST-MIGRATIONS.md)')
        .replaceAll('](CLIENT-MODULES.md)', '](docs/CLIENT-MODULES.md)')
        .replaceAll('](NPM-WORKSPACES.md)', '](docs/NPM-WORKSPACES.md)')
        .replaceAll('](SOURCE-ALIASES.md)', '](docs/SOURCE-ALIASES.md)')
        .replaceAll('](STRIPE-WEBHOOKS.md)', '](docs/STRIPE-WEBHOOKS.md)')
        .replaceAll('](STRIPE-SUBSCRIPTION-PERIODS.md)', '](docs/STRIPE-SUBSCRIPTION-PERIODS.md)')
        .replaceAll('](../examples/', '](examples/'),
    );
    await copyFile(join(root, '.env.example'), join(stage, '.env.example'));
    await mkdir(join(stage, 'docs'));
    for (const name of [
      'ARCHITECTURE.md',
      'UPSTREAM-REPLAY.md',
      'GITHUB-APP.md',
      'TEST-REPOSITORIES.md',
      'BILLING-EVALUATION.md',
      'CLI.md',
      'AUTOMATION.md',
      'LOCAL-SERVICE.md',
      'DEPENDENCIES.md',
      'ENDPOINT-MIGRATIONS.md',
      'REPOSITORY-SETUP.md',
      'APP-ONBOARDING.md',
      'VENDOR_NOTES.md',
      'API-VERSIONS.md',
      'MULTIPLE-INTEGRATIONS.md',
      'REQUEST-MIGRATIONS.md',
      'CLIENT-MODULES.md',
      'NPM-WORKSPACES.md',
      'SOURCE-ALIASES.md',
      'STRIPE-WEBHOOKS.md',
      'STRIPE-SUBSCRIPTION-PERIODS.md',
      'READINESS.md',
      'AI-EVALUATION.md',
      'PR-EVALUATION.md',
    ])
      await copyFile(join(root, 'docs', name), join(stage, 'docs', name));
    await mkdir(join(stage, 'public'));
    await copyFile(
      join(root, 'public/refit-agent-avatar.png'),
      join(stage, 'public/refit-agent-avatar.png'),
    );
    const result = await execute(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', output],
      { cwd: stage, timeout: PACK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
    const [packed] = JSON.parse(result.stdout);
    console.log(
      JSON.stringify(
        {
          archive: join(output, packed.filename),
          version: metadata.version,
          integrity: packed.integrity,
          dependencies,
          files: packed.files.map((file) => file.path),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
