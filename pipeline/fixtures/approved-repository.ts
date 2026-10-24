import { execFile } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stripeContractFile, stripeContractVersion } from '../enrollment-contracts.ts';
import { gitEnvironment } from '../git-environment.ts';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
  readRepositoryApproval,
} from '../repository-enrollment.ts';
import { stripeSpecificationUrl } from '../specifications.ts';

const execute = promisify(execFile);
const fixture = resolve('pipeline/fixtures/endpoint-replacement');
// A repository that commits no .refit.json, so Refit generates its Stripe configuration. Its client
// is Ankit-Sharma1011/Quill's src/lib/stripe.ts, as in the P3 enrollment sample.
export const GENERATED_REPOSITORY = resolve('pipeline/fixtures/generated-stripe');
// Real Stripe contracts are about 9 MB each, so a generated configuration runs only against a saved
// directory: REFIT_STRIPE_CONTRACTS=~/.refit/contracts after refit stripe-snapshot --version
// 2026-04-22.dahlia --version 2026-09-30.endive.
export const SAVED_CONTRACTS = process.env.REFIT_STRIPE_CONTRACTS;
export const GENERATED_VERSIONS = ['2026-04-22.dahlia', '2026-09-30.endive'];

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

// Answers the pinned stripe/openapi downloads of the generated configuration from the saved contracts
// instead of GitHub, and refuses any other request.
export async function savedContractDownloads(saved: string) {
  const served = new Map(
    await Promise.all(
      GENERATED_VERSIONS.map(async (version) => {
        const file = join(saved, stripeContractFile(version));
        const { content } = JSON.parse(await readFile(file, 'utf8')) as { content: string };
        return [stripeSpecificationUrl(stripeContractVersion(version)!.commit), content] as const;
      }),
    ),
  );
  return {
    urls: [...served.keys()],
    respond: async (url: string) => {
      const content = served.get(url);
      if (content === undefined) throw new Error(`Unexpected request to ${url}`);
      return new Response(content);
    },
  };
}
