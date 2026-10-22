import { execFile } from 'node:child_process';
import { cp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitEnvironment } from '../git-environment.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  readRepositoryApproval,
} from '../repository-enrollment.ts';

const execute = promisify(execFile);
const fixture = resolve('pipeline/fixtures/endpoint-replacement');

async function git(source: string, args: string[]) {
  return (await execute('git', args, { cwd: source, env: gitEnvironment() })).stdout.trim();
}

// Commits every change in the source repository and returns the new head.
export async function commitRepository(source: string) {
  await git(source, ['add', '.']);
  await git(source, [
    '-c',
    'user.name=Refit Tests',
    '-c',
    'user.email=tests@refit.local',
    'commit',
    '--quiet',
    '-m',
    'test: update hosted application',
  ]);
  return git(source, ['rev-parse', 'HEAD']);
}

// A committed copy of the endpoint-replacement application as example/application, whose contract
// already changed, with a reviewed approval receipt.
export async function approvedRepository(root: string) {
  const source = join(root, 'source');
  await cp(join(fixture, 'repository'), source, { recursive: true });
  for (const name of ['before.json', 'provider.json', 'after.json'])
    await cp(join(fixture, name), join(source, name));
  await writeFile(
    join(source, '.refit.json'),
    JSON.stringify({
      formatVersion: 1,
      before: './before.json',
      after: './after.json',
      providerConfig: './provider.json',
      apiVersion: '1',
      fullDiff: Boolean(process.env.REFIT_OASDIFF),
      image: process.env.REFIT_DOCKER_IMAGE ?? 'unused-test-image',
      baselineCommand: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'before'],
      command: ['node', '--experimental-strip-types', 'simulator/check.mjs', 'after'],
    }),
  );
  await git(source, ['init', '--quiet', '--initial-branch=main']);
  const head = await commitRepository(source);
  const enrollment = await inspectRepositoryEnrollment({
    repository: source,
    github: 'example/application',
    base: 'main',
  });
  const output = join(root, 'approval.json');
  await approveRepositoryEnrollment({ enrollment, fingerprint: enrollment.fingerprint, output });
  return { source, head, approval: await readRepositoryApproval(output) };
}
