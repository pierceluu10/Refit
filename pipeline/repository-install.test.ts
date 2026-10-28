import { expect, it } from 'vitest';
import {
  installCommand,
  installPlan,
  namedHosts,
  needsCustomerEnvironment,
  PUBLIC_REGISTRIES,
} from './repository-install.ts';

const manifest = (extra: object = {}) =>
  JSON.stringify({ name: 'app', private: true, dependencies: { stripe: '^14.0.0' }, ...extra });

it('recognises only install commands that keep development dependencies', () => {
  expect(installCommand('npm ci --legacy-peer-deps')).toEqual({
    manager: 'npm',
    command: ['npm', 'ci', '--legacy-peer-deps'],
  });
  expect(installCommand('pnpm install --frozen-lockfile')?.command).toEqual([
    'pnpm',
    'install',
    '--frozen-lockfile',
  ]);
  expect(installCommand('yarn')?.command).toEqual(['yarn', 'install']);
  expect(installCommand('yarn --frozen-lockfile --network-timeout 600000')?.command).toEqual([
    'yarn',
    'install',
    '--frozen-lockfile',
    '--network-timeout',
    '600000',
  ]);
  for (const other of [
    'npm ci --omit=dev',
    'npm install left-pad',
    'npm run build',
    'pnpm install --filter web',
    'yarn add stripe',
    'NODE_ENV=production npm ci',
    'npm ci $(cat flags)',
    'curl https://example.com/install.sh | sh',
  ])
    expect(installCommand(other)).toBeUndefined();
});

it('derives the install from the Dockerfile, then devcontainer, then CI, then the lockfile', () => {
  const workflow = [
    'jobs:',
    '  test:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: pnpm install --frozen-lockfile && pnpm build',
    '      - run: pnpm test',
  ].join('\n');
  const base = new Map([
    ['package.json', manifest({ packageManager: 'pnpm@9.15.9' })],
    ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
    ['.github/workflows/ci.yml', workflow],
  ]);
  expect(installPlan(base)).toEqual({
    source: 'ci',
    file: '.github/workflows/ci.yml',
    manager: 'pnpm',
    command: ['pnpm', 'install', '--frozen-lockfile'],
    tool: 'pnpm@9.15.9',
    skipped: ['pnpm build'],
  });
  const docker = new Map(base).set(
    'Dockerfile',
    'FROM node:22\nWORKDIR /app\nCOPY . .\nRUN --mount=type=cache,target=/root/.npm \\\n  npm ci --no-audit && npm run build\n',
  );
  expect(installPlan(docker)).toMatchObject({
    source: 'dockerfile',
    command: ['npm', 'ci', '--no-audit'],
    skipped: ['npm run build'],
  });
  const devcontainer = new Map(base).set(
    '.devcontainer/devcontainer.json',
    '// comment\n{ "postCreateCommand": "yarn install --frozen-lockfile" }',
  );
  expect(installPlan(devcontainer)).toMatchObject({ source: 'devcontainer', manager: 'yarn' });
  // A CI step in a subdirectory is not the root install.
  const nested = new Map([
    ['package.json', manifest()],
    ['package-lock.json', '{}'],
    [
      '.github/workflows/ci.yml',
      'jobs:\n  a:\n    steps:\n      - run: npm ci\n        working-directory: web\n',
    ],
  ]);
  expect(installPlan(nested)).toEqual({
    source: 'lockfile',
    file: 'package.json',
    manager: 'npm',
    command: ['npm', 'ci'],
    skipped: [],
  });
  expect(
    installPlan(
      new Map([
        ['package.json', manifest()],
        ['yarn.lock', ''],
        ['.yarnrc.yml', ''],
      ]),
    ),
  ).toMatchObject({ command: ['yarn', 'install', '--immutable'], tool: '@yarnpkg/cli-dist@4' });
  expect(installPlan(new Map([['package.json', manifest()]]))).toBeUndefined();
});

it('allows only public registries and the hosts the install files name', () => {
  const hosts = namedHosts(
    new Map([
      [
        'package.json',
        manifest({
          dependencies: { kit: 'acme/kit#v1', other: 'git+https://gitlab.example.com/a/b.git' },
          scripts: { postinstall: 'curl https://script.example.org/setup.sh | sh' },
        }),
      ],
      ['.npmrc', '@acme:registry=https://npm.pkg.github.com\n'],
      ['.github/workflows/ci.yml', 'run: curl https://evil.example.org'],
      ['Dockerfile', 'RUN curl https://binaries.example.net'],
    ]),
  );
  expect(hosts).toEqual(
    expect.arrayContaining([
      ...PUBLIC_REGISTRIES,
      'npm.pkg.github.com',
      'gitlab.example.com',
      'github.com',
      'codeload.github.com',
    ]),
  );
  expect(hosts).not.toContain('evil.example.org');
  expect(hosts).not.toContain('script.example.org');
  expect(hosts).not.toContain('binaries.example.net');
});

it('names installs that need something only the customer has', () => {
  expect(needsCustomerEnvironment('npm error code E401\nnpm error Unable to authenticate')).toBe(
    true,
  );
  expect(needsCustomerEnvironment('Failed to replace env in config: ${NPM_TOKEN}')).toBe(true);
  expect(needsCustomerEnvironment('fatal: could not read Username for https://github.com')).toBe(
    true,
  );
  expect(needsCustomerEnvironment('npm error code ERESOLVE')).toBe(false);
});
