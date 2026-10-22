import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  approveRepositoryEnrollment,
  inspectRepositoryEnrollment,
} from '../repository-enrollment.ts';

const execute = promisify(execFile);
const fixture = resolve('pipeline/fixtures/endpoint-replacement');

export async function commit(repository: string) {
  await execute('git', ['-C', repository, 'add', '.']);
  await execute('git', [
    '-C',
    repository,
    '-c',
    'user.name=Enrollment Tests',
    '-c',
    'user.email=enrollment@refit.local',
    'commit',
    '-m',
    'test: update repository enrollment fixture',
  ]);
}

export async function approvedCheckout(root: string) {
  const repository = join(root, 'repository');
  await cp(join(fixture, 'repository'), repository, { recursive: true });
  for (const name of ['before.json', 'after.json', 'provider.json'])
    await cp(join(fixture, name), join(repository, name));
  const configuration = {
    formatVersion: 1,
    before: './before.json',
    after: './after.json',
    providerConfig: './provider.json',
    apiVersion: '1',
    fullDiff: true,
    image: 'node:22-alpine',
    command: ['node', '-e', "require('fs').writeFileSync('application-executed','private-value')"],
  };
  await writeFile(join(repository, '.refit.json'), JSON.stringify(configuration));
  await execute('git', ['-C', repository, 'init', '-b', 'main']);
  await commit(repository);
  const input = { repository, github: 'Example/Application', base: 'main' };
  const enrollment = await inspectRepositoryEnrollment(input);
  const output = join(root, 'approval.json');
  const { approval } = await approveRepositoryEnrollment({
    enrollment,
    fingerprint: enrollment.fingerprint,
    output,
  });
  return { root, repository, configuration, input, enrollment, approval, output };
}

export type EnrollmentSample = Awaited<ReturnType<typeof approvedCheckout>>;

export async function multipleIntegrationsCheckout(root: string) {
  const sample = await approvedCheckout(root);
  const configuration: Record<string, unknown> = { ...sample.configuration };
  delete configuration.formatVersion;
  for (const [source, destination] of [
    ['before.json', 'stripe-before.json'],
    ['after.json', 'stripe-after.json'],
  ])
    await cp(resolve('pipeline/fixtures', source), join(sample.repository, destination));
  await writeFile(
    join(sample.repository, 'src/stripe.ts'),
    "import Stripe from 'stripe'; export const stripe = new Stripe('test', { apiVersion: '2022-08-01' });",
  );
  await writeFile(
    join(sample.repository, '.refit.json'),
    JSON.stringify({
      formatVersion: 2,
      integrations: [
        { ...configuration, id: 'catalog' },
        {
          id: 'stripe',
          before: './stripe-before.json',
          after: './stripe-after.json',
          apiVersion: '2022-08-01',
          apiVersionPolicy: 'source-verified',
          image: 'node:22-alpine',
          command: ['node', '--version'],
        },
      ],
    }),
  );
  await commit(sample.repository);
  const enrollment = await inspectRepositoryEnrollment(sample.input);
  const output = join(sample.root, 'multi-approval.json');
  const { approval } = await approveRepositoryEnrollment({
    enrollment,
    fingerprint: enrollment.fingerprint,
    output,
  });
  return { ...sample, enrollment, approval, output };
}

// Committing, inspecting and approving the fixture was most of each test's time. The file builds
// it once, and each test gets a private copy: the copy keeps the same Git revision, and neither
// the enrollment nor the receipt holds a local path. Copies are removed after each test.
export function enrollmentFixture(build: (root: string) => Promise<EnrollmentSample>) {
  let template: EnrollmentSample;
  const copies: string[] = [];
  beforeAll(async () => {
    template = await build(await mkdtemp(join(tmpdir(), 'refit-enrollment-template-')));
  });
  afterEach(() =>
    Promise.all(copies.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  );
  afterAll(() => rm(template.root, { recursive: true, force: true }));
  return async () => {
    const root = await mkdtemp(join(tmpdir(), 'refit-enrollment-'));
    copies.push(root);
    await cp(template.root, root, { recursive: true });
    const repository = join(root, 'repository');
    return {
      ...structuredClone(template),
      root,
      repository,
      input: { ...template.input, repository },
      output: join(root, template.output.slice(template.root.length + 1)),
    };
  };
}
