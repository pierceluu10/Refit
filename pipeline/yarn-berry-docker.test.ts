import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { prepareDependencies } from './dependency-preparation.ts';
import { dockerSandboxArguments, removeDockerContainer } from './docker-sandbox.ts';

// Yarn 2+ preparation against real Yarn releases from the npm registry, in local Docker.
const gated = it.skipIf(!process.env.REFIT_NPM_PREPARE || !process.env.REFIT_DOCKER_IMAGE);
const execute = promisify(execFile);
const YARN = '4.9.2';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-yarn-berry-docker-'));
  roots.push(root);
  const directory = join(root, 'repository');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await execute('git', ['init', '-q', directory]);
  await execute('git', ['-C', directory, 'add', '.']);
  await execute('git', [
    '-C',
    directory,
    '-c',
    'user.name=Refit Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'test: yarn berry fixture',
  ]);
  return { root, directory };
}

// The published Yarn bundle, exactly as `yarn set version` commits it under .yarn/releases.
async function publishedRelease() {
  const root = await mkdtemp(join(tmpdir(), 'refit-yarn-release-'));
  roots.push(root);
  const response = await fetch(
    `https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-${YARN}.tgz`,
  );
  if (!response.ok) throw new Error(`Registry returned ${response.status}`);
  await writeFile(join(root, 'cli.tgz'), Buffer.from(await response.arrayBuffer()));
  await execute('tar', ['-xzf', join(root, 'cli.tgz'), '-C', root]);
  return readFile(join(root, 'package', 'bin', 'yarn.js'));
}

// The single-package fixture, with dependencies sorted the way Yarn writes them.
async function singlePackage(packageManager?: string) {
  const fixtures = 'pipeline/fixtures/yarn-locks';
  const manifest = JSON.parse(await readFile(join(fixtures, 'package.json'), 'utf8'));
  manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).sort());
  if (packageManager) manifest.packageManager = packageManager;
  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'yarn.lock': await readFile(join(fixtures, 'berry.lock'), 'utf8'),
  };
}

async function offline(
  prepared: Awaited<ReturnType<typeof prepareDependencies>>,
  directory: string,
  script: string,
) {
  const name = `refit-yarn-berry-${randomUUID()}`;
  try {
    return (
      await execute(
        'docker',
        dockerSandboxArguments({
          name,
          directory,
          image: String(prepared.environment.image),
          dependencies: prepared.archive,
          network: 'none',
          command: ['sh', '-c', script],
        }),
        { timeout: 60_000 },
      )
    ).stdout;
  } finally {
    await removeDockerContainer(name);
  }
}

gated(
  'prepares Yarn 4 workspaces and links them for offline checks',
  async () => {
    const source = 'pipeline/fixtures/yarn-workspaces';
    const { root, directory } = await repository({});
    await cp(source, directory, { recursive: true });
    await execute('git', ['-C', directory, 'add', '.']);
    await execute('git', [
      '-C',
      directory,
      '-c',
      'user.name=Refit Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'test: yarn workspaces fixture',
    ]);
    const prepared = await prepareDependencies({
      repository: directory,
      image: process.env.REFIT_DOCKER_IMAGE!,
      cacheDirectory: join(root, 'cache'),
    });
    expect(prepared.environment).toMatchObject({ manager: 'yarn', yarnVersion: YARN });
    const stdout = await offline(
      prepared,
      directory,
      `test "$(yarn --version)" = ${YARN} && node -e "require('is-number');console.log('shared', require('shared/package.json').version)" && cd packages/shared && node -e "console.log('nested', typeof require('is-number'))"`,
    );
    expect(stdout).toContain('shared 1.0.0');
    expect(stdout).toContain('nested function');
  },
  300_000,
);

gated(
  'installs the published Yarn a committed yarnPath release matches, never the file itself',
  async () => {
    const release = await publishedRelease();
    const files = {
      ...(await singlePackage()),
      '.yarnrc.yml': `nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-${YARN}.cjs\n`,
      [`.yarn/releases/yarn-${YARN}.cjs`]: release,
    };
    const genuine = await repository(files);
    const prepared = await prepareDependencies({
      repository: genuine.directory,
      image: process.env.REFIT_DOCKER_IMAGE!,
      cacheDirectory: join(genuine.root, 'cache'),
    });
    expect(prepared.environment).toMatchObject({ manager: 'yarn', yarnVersion: YARN });
    expect(await offline(prepared, genuine.directory, 'yarn --version')).toContain(YARN);
    // One appended byte makes the committed release differ from every published bundle.
    const tampered = await repository({
      ...files,
      [`.yarn/releases/yarn-${YARN}.cjs`]: Buffer.concat([release, Buffer.from('\n')]),
    });
    await expect(
      prepareDependencies({
        repository: tampered.directory,
        image: process.env.REFIT_DOCKER_IMAGE!,
        cacheDirectory: join(tampered.root, 'cache'),
      }),
    ).rejects.toThrow(/manager differs from the declared version or checksum/);
  },
  300_000,
);

gated(
  'checks a Corepack sha512 pin against the published Yarn bundle',
  async () => {
    const digest = createHash('sha512')
      .update(await publishedRelease())
      .digest('hex');
    const pinned = await repository(await singlePackage(`yarn@${YARN}+sha512.${digest}`));
    expect(
      (
        await prepareDependencies({
          repository: pinned.directory,
          image: process.env.REFIT_DOCKER_IMAGE!,
          cacheDirectory: join(pinned.root, 'cache'),
        })
      ).environment,
    ).toMatchObject({ yarnVersion: YARN });
    const wrong = await repository(await singlePackage(`yarn@${YARN}+sha512.${'0'.repeat(128)}`));
    await expect(
      prepareDependencies({
        repository: wrong.directory,
        image: process.env.REFIT_DOCKER_IMAGE!,
        cacheDirectory: join(wrong.root, 'cache'),
      }),
    ).rejects.toThrow(/manager differs from the declared version or checksum/);
  },
  300_000,
);

gated(
  "stops a Plug'n'Play project before it reaches Docker",
  async () => {
    const pnp = await repository({
      ...(await singlePackage(`yarn@${YARN}`)),
      '.yarnrc.yml': 'nodeLinker: pnp\n',
    });
    await expect(
      prepareDependencies({
        repository: pnp.directory,
        image: process.env.REFIT_DOCKER_IMAGE!,
        cacheDirectory: join(pnp.root, 'cache'),
      }),
    ).rejects.toThrow("Yarn Plug'n'Play requires a custom validation image");
  },
  60_000,
);
