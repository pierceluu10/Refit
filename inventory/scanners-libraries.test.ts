import { afterEach, describe, expect, it } from 'vitest';
import { findDirectDependencies } from './scanners-libraries.ts';
import type { PackageRoot } from './scanners-libraries.ts';
import { DEMO_NODE_API, DEMO_PYTHON_APP, MONOREPO } from './sample-repos.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const repos: string[] = [];

async function scan(files: Record<string, string>) {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return findDirectDependencies(repoDir);
}

function packageAt(packages: PackageRoot[], dir: string, ecosystem: string): PackageRoot {
  const found = packages.find((root) => root.dir === dir && root.ecosystem === ecosystem);
  if (!found) throw new Error(`No ${ecosystem} package at ${dir}: ${JSON.stringify(packages)}`);
  return found;
}

function resolvedVersions(root: PackageRoot) {
  return Object.fromEntries(
    root.dependencies.map((entry) => [
      entry.name,
      entry.resolved &&
        `${entry.resolved.version}@${entry.resolved.lockfile}:${entry.resolved.line}`,
    ]),
  );
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
});

describe('findDirectDependencies on sample repos', () => {
  it('resolves DEMO_NODE_API from package-lock.json with exact lines', async () => {
    const { packages, lockfiles } = await scan(DEMO_NODE_API);
    expect(lockfiles).toEqual(['package-lock.json']);
    expect(packages).toEqual([
      {
        dir: '.',
        ecosystem: 'npm',
        lockfile: 'package-lock.json',
        dependencies: [
          {
            name: 'express',
            declared: '4.18.2',
            file: 'package.json',
            line: 15,
            resolved: { version: '4.18.2', lockfile: 'package-lock.json', line: 18 },
          },
          {
            name: 'openai',
            declared: '4.20.1',
            file: 'package.json',
            line: 16,
            hint: 'OpenAI',
            resolved: { version: '4.20.1', lockfile: 'package-lock.json', line: 24 },
          },
        ],
      },
    ]);
  });

  it('reports DEMO_PYTHON_APP as declared only, with build and dev requirements flagged', async () => {
    const { packages, lockfiles } = await scan(DEMO_PYTHON_APP);
    expect(lockfiles).toEqual([]);
    expect(packages).toEqual([
      {
        dir: '.',
        ecosystem: 'python',
        dependencies: [
          { name: 'setuptools', declared: '>=61', dev: true, file: 'pyproject.toml', line: 2 },
          { name: 'flask', declared: '==2.2.5', file: 'pyproject.toml', line: 11 },
          { name: 'werkzeug', declared: '==2.2.3', file: 'pyproject.toml', line: 12 },
          {
            name: 'stripe',
            declared: '==2.76.0',
            file: 'pyproject.toml',
            line: 13,
            hint: 'Stripe',
          },
          { name: 'pytest', declared: '==7.4.4', dev: true, file: 'pyproject.toml', line: 17 },
        ],
      },
    ]);
  });

  it('resolves each MONOREPO workspace against its own node_modules entry', async () => {
    const { packages, lockfiles } = await scan(MONOREPO);
    expect(lockfiles).toEqual(['package-lock.json', 'services/worker/poetry.lock']);
    expect(packages.map((root) => [root.dir, root.ecosystem, root.lockfile])).toEqual([
      ['.', 'npm', 'package-lock.json'],
      ['apps/admin', 'npm', 'package-lock.json'],
      ['apps/web', 'npm', 'package-lock.json'],
      ['services/worker', 'python', 'services/worker/poetry.lock'],
    ]);
    expect(packageAt(packages, '.', 'npm').dependencies).toEqual([]);
    expect(packageAt(packages, 'apps/admin', 'npm').dependencies).toEqual([
      {
        name: 'next',
        declared: '^13.5.0',
        file: 'apps/admin/package.json',
        line: 4,
        resolved: { version: '13.5.6', lockfile: 'package-lock.json', line: 15 },
      },
    ]);
    expect(packageAt(packages, 'apps/web', 'npm').dependencies).toEqual([
      {
        name: 'next',
        declared: '^14.2.0',
        file: 'apps/web/package.json',
        line: 4,
        resolved: { version: '14.2.3', lockfile: 'package-lock.json', line: 27 },
      },
      {
        name: 'openai',
        declared: '^4.52.0',
        file: 'apps/web/package.json',
        line: 5,
        hint: 'OpenAI',
        resolved: { version: '4.52.7', lockfile: 'package-lock.json', line: 30 },
      },
    ]);
    expect(resolvedVersions(packageAt(packages, 'services/worker', 'python'))).toEqual({
      python: undefined,
      django: '4.2.13@services/worker/poetry.lock:7',
      anthropic: '0.25.9@services/worker/poetry.lock:3',
    });
  });
});

describe('findDirectDependencies lockfile formats', () => {
  it('prefers the pnpm importer for the package and strips the peer suffix', async () => {
    const { packages } = await scan({
      'package.json': '{\n  "dependencies": {\n    "next": "^14.2.0"\n  }\n}\n',
      'apps/admin/package.json': '{\n  "dependencies": {\n    "next": "^13.5.0"\n  }\n}\n',
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      next:',
        '        specifier: ^14.2.0',
        '        version: 14.2.3(react-dom@18.2.0(react@18.2.0))(react@18.2.0)',
        '',
        '  apps/admin:',
        '    dependencies:',
        '      next:',
        '        specifier: ^13.5.0',
        '        version: 13.5.6(react@18.2.0)',
        '',
        'packages:',
        '',
        '  next@15.0.0:',
        '    resolution: {integrity: sha512-x}',
        '',
      ].join('\n'),
    });
    expect(resolvedVersions(packageAt(packages, '.', 'npm'))).toEqual({
      next: '14.2.3@pnpm-lock.yaml:9',
    });
    expect(resolvedVersions(packageAt(packages, 'apps/admin', 'npm'))).toEqual({
      next: '13.5.6@pnpm-lock.yaml:15',
    });
  });

  it('matches yarn classic entries by declared range, else the first entry', async () => {
    const { packages } = await scan({
      'package.json':
        '{\n  "dependencies": {\n    "next": "^14.2.0",\n    "react": "~99.0.0"\n  }\n}\n',
      'yarn.lock': [
        '# yarn lockfile v1',
        '',
        'next@^13.0.0:',
        '  version "13.0.1"',
        '',
        '"next@^14.2.0", next@~14.2.1:',
        '  version "14.2.9"',
        '',
        'react@^17.0.0:',
        '  version "17.0.2"',
        '',
        'react@^18.0.0:',
        '  version "18.2.0"',
        '',
      ].join('\n'),
    });
    expect(resolvedVersions(packageAt(packages, '.', 'npm'))).toEqual({
      next: '14.2.9@yarn.lock:7',
      react: '17.0.2@yarn.lock:10',
    });
  });

  it('matches yarn berry npm: specs', async () => {
    const { packages } = await scan({
      'package.json': '{\n  "dependencies": {\n    "next": "^14.2.0"\n  }\n}\n',
      'yarn.lock': [
        '__metadata:',
        '  version: 8',
        '',
        '"next@npm:^13.0.0":',
        '  version: 13.0.1',
        '',
        '"next@npm:^14.2.0":',
        '  version: 14.2.3',
        '',
      ].join('\n'),
    });
    expect(resolvedVersions(packageAt(packages, '.', 'npm'))).toEqual({
      next: '14.2.3@yarn.lock:8',
    });
  });

  it('reads npm v1 lockfiles, taking the hoisted copy over a nested one', async () => {
    const { packages } = await scan({
      'package.json': '{\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n',
      'package-lock.json': [
        '{',
        '  "lockfileVersion": 1,',
        '  "dependencies": {',
        '    "other": {',
        '      "version": "1.0.0",',
        '      "dependencies": {',
        '        "left-pad": {',
        '          "version": "0.0.1"',
        '        }',
        '      }',
        '    },',
        '    "left-pad": {',
        '      "version": "1.3.0"',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    expect(resolvedVersions(packageAt(packages, '.', 'npm'))).toEqual({
      'left-pad': '1.3.0@package-lock.json:13',
    });
  });

  it('uses the nearest lockfile: a package with its own wins over the root one', async () => {
    const lock = (version: string) =>
      `{\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/next": {\n      "version": "${version}"\n    }\n  }\n}\n`;
    const manifest = '{\n  "dependencies": {\n    "next": "^14.0.0"\n  }\n}\n';
    const { packages } = await scan({
      'package-lock.json': lock('14.0.0'),
      'apps/web/package.json': manifest,
      'apps/web/package-lock.json': lock('14.2.3'),
      'apps/other/package.json': manifest,
    });
    expect(packages.map((root) => [root.dir, root.lockfile])).toEqual([
      ['apps/other', 'package-lock.json'],
      ['apps/web', 'apps/web/package-lock.json'],
    ]);
    expect(resolvedVersions(packageAt(packages, 'apps/web', 'npm'))).toEqual({
      next: '14.2.3@apps/web/package-lock.json:5',
    });
    expect(resolvedVersions(packageAt(packages, 'apps/other', 'npm'))).toEqual({
      next: '14.0.0@package-lock.json:5',
    });
  });

  it('never resolves a package against a lockfile of another ecosystem', async () => {
    const { packages } = await scan({
      'package.json': '{\n  "dependencies": {\n    "requests": "1.0.0"\n  }\n}\n',
      'poetry.lock': '[[package]]\nname = "requests"\nversion = "2.31.0"\n',
    });
    expect(packageAt(packages, '.', 'npm').lockfile).toBeUndefined();
    expect(resolvedVersions(packageAt(packages, '.', 'npm'))).toEqual({ requests: undefined });
  });

  it('counts == pins in requirements files as resolved in that file, other specs use the lock', async () => {
    const { packages } = await scan({
      'requirements.txt': '# compiled\nflask==3.0.0\nrequests>=2.0\nnumpy==1.*\n',
      'requirements/dev.txt': 'pytest==8.0.0\n',
      'poetry.lock': '[[package]]\nname = "requests"\nversion = "2.31.0"\n',
    });
    expect(resolvedVersions(packageAt(packages, '.', 'python'))).toEqual({
      flask: '3.0.0@requirements.txt:2',
      requests: '2.31.0@poetry.lock:3',
      numpy: undefined,
    });
    const dev = packageAt(packages, 'requirements', 'python');
    expect(dev.dependencies).toEqual([
      {
        name: 'pytest',
        declared: '==8.0.0',
        dev: true,
        file: 'requirements/dev.txt',
        line: 1,
        resolved: { version: '8.0.0', lockfile: 'requirements/dev.txt', line: 1 },
      },
    ]);
  });

  it('lists setup.cfg install_requires', async () => {
    const { packages } = await scan({
      'setup.cfg': [
        '[metadata]',
        'name = demo',
        '',
        '[options]',
        'install_requires =',
        '    requests>=2.0',
        '    # not a requirement',
        '    click==8.1.0',
        '',
        '    flask',
        'python_requires = >=3.9',
        '',
      ].join('\n'),
    });
    expect(packageAt(packages, '.', 'python').dependencies).toEqual([
      { name: 'requests', declared: '>=2.0', file: 'setup.cfg', line: 6 },
      { name: 'click', declared: '==8.1.0', file: 'setup.cfg', line: 8 },
      { name: 'flask', declared: '', file: 'setup.cfg', line: 10 },
    ]);
  });

  it('keeps one package root per directory and ecosystem when manifests share a directory', async () => {
    const { packages } = await scan({
      'service/go.mod': 'module x\n\nrequire github.com/google/uuid v1.6.0\n',
      'service/go.sum':
        'github.com/google/uuid v1.5.0 h1:a=\ngithub.com/google/uuid v1.6.0 h1:b=\n',
      'service/package.json': '{\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n',
    });
    expect(packages.map((root) => [root.dir, root.ecosystem, root.lockfile])).toEqual([
      ['service', 'go', 'service/go.sum'],
      ['service', 'npm', undefined],
    ]);
    expect(resolvedVersions(packageAt(packages, 'service', 'go'))).toEqual({
      'github.com/google/uuid': 'v1.6.0@service/go.sum:2',
    });
  });
});
