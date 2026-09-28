import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { runWorkflow } from './workflow.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const USAGE = `Usage: refit demo --image <existing-local-node-image> --output <new-directory>

Installs the bundled Stripe SDK fixture into a temporary repository (npm registry access).
Demonstrates the old contract passing, the new contract breaking, then generates a patch
and checks old/new contracts in offline Docker containers. Retains evidence locally.
Uses a simulated API and real SDK, no Stripe account, AI key or GitHub publication.
The image must contain Node.js and /bin/sh. No image is downloaded automatically.`;

try {
  const { values } = parseArgs({
    options: {
      image: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    if (!values.image || values.image.startsWith('-') || !values.output)
      throw new PipelineInputError(USAGE);
    const output = resolve(values.output);
    const processOptions = { timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES };
    await execute('docker', ['image', 'inspect', values.image], processOptions);
    await mkdir(output, { mode: 0o700 });
    const root = await mkdtemp(join(tmpdir(), 'refit-demo-'));
    try {
      const repository = join(root, 'repository');
      await cp(join(fixtures, 'stripe-sdk/repository'), repository, { recursive: true });
      await cp(join(fixtures, 'stripe-sdk/contract.mjs'), join(repository, 'contract.mjs'));
      const localOptions = { ...processOptions, cwd: repository };
      await execute(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
        localOptions,
      );
      const contract = (mode: string) =>
        execute(process.execPath, ['contract.mjs', './billing.js', mode], localOptions);
      const before = JSON.parse((await contract('before')).stdout);
      let failure: { exitCode: number; stderr: string };
      try {
        await contract('after');
        throw new PipelineInputError('Expected the original fixture to fail against the new API.');
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 1 ||
          !('stderr' in error) ||
          typeof error.stderr !== 'string' ||
          !error.stderr.includes('TypeError')
        )
          throw error;
        failure = { exitCode: error.code, stderr: error.stderr };
      }
      await writeFile(
        join(output, 'contract-before-migration.json'),
        `${JSON.stringify({ before, after: failure }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      const git = (argumentsList: string[]) =>
        execute('git', ['-c', 'core.hooksPath=/dev/null', ...argumentsList], localOptions);
      await git(['init']);
      await git(['add', '--force', '.']);
      await git([
        '-c',
        'user.name=Refit Demo',
        '-c',
        'user.email=demo@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'test: seed isolated Stripe demo',
      ]);
      const result = await runWorkflow({
        repository,
        before: join(fixtures, 'before.json'),
        after: join(fixtures, 'after.json'),
        output: join(output, 'migration'),
        image: values.image,
        baselineCommand: ['node', 'contract.mjs', './billing.js', 'before'],
        command: ['node', 'contract.mjs', './billing.js', 'after'],
      });
      const installed = JSON.parse(
        await readFile(join(repository, 'node_modules/stripe/package.json'), 'utf8'),
      );
      const summary = {
        kind: 'refit-stripe-demo',
        sdkVersion: installed.version,
        api: 'simulated loopback HTTP server',
        originalBefore: 'passed',
        originalAfter: 'failed as expected',
        workflow: result,
        published: false,
      };
      await writeFile(join(output, 'demo.json'), `${JSON.stringify(summary, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      console.log(JSON.stringify(summary, null, 2));
      if (result.manifest.status !== 'validated') process.exitCode = 2;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
