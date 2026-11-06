import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_NEXT_WEB, DEMO_NODE_API, DEMO_PYTHON_APP, MONOREPO } from './sample-repos.ts';
import type { RepoFiles } from './sample-repos.ts';
import {
  findCiVersions,
  findContainerImages,
  findRuntimeVersions,
  findSetupFiles,
} from './scanners-platform.ts';
import type { VersionSignal } from './scanners.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const repos: string[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
});

async function repoWith(files: RepoFiles): Promise<string> {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return repoDir;
}

// "file:line name=version [source]" keeps assertions readable and failure diffs exact.
function brief(signals: VersionSignal[]): string[] {
  return signals.map(
    (signal) =>
      `${signal.file}:${signal.line} ${signal.name}=${signal.version ?? ''} [${signal.source}]`,
  );
}

describe('findRuntimeVersions', () => {
  it('reads every runtime pin in the Node demo API', async () => {
    const { signals } = await findRuntimeVersions(await repoWith(DEMO_NODE_API));
    expect(brief(signals)).toEqual([
      '.nvmrc:1 node=18 [.nvmrc]',
      'package.json:8 node=18.x [package.json engines]',
      'serverless.yml:5 node=16.x [serverless.yml runtime]',
    ]);
    expect(signals[2]).toEqual({
      file: 'serverless.yml',
      line: 5,
      text: 'runtime: nodejs16.x',
      name: 'node',
      version: '16.x',
      source: 'serverless.yml runtime',
    });
  });

  it('reads requires-python but not the build-system requires', async () => {
    const { signals } = await findRuntimeVersions(await repoWith(DEMO_PYTHON_APP));
    expect(brief(signals)).toEqual([
      '.python-version:1 python=3.9 [.python-version]',
      'pyproject.toml:9 python=>=3.9,<3.10 [pyproject.toml requires-python]',
    ]);
  });

  it('finds nothing in a repo with no runtime pins', async () => {
    const { signals } = await findRuntimeVersions(await repoWith(DEMO_NEXT_WEB));
    expect(signals).toEqual([]);
  });

  it('reads per-package engines, .nvmrc and poetry python in the monorepo', async () => {
    const { signals } = await findRuntimeVersions(await repoWith(MONOREPO));
    expect(brief(signals)).toEqual([
      '.nvmrc:1 node=20 [.nvmrc]',
      'apps/web/package.json:8 node=20.x [package.json engines]',
      'package.json:6 node=>=20 [package.json engines]',
      'services/worker/.python-version:1 python=3.11 [.python-version]',
      'services/worker/pyproject.toml:6 python=^3.11 [pyproject.toml poetry python]',
    ]);
  });

  it('strips comments and quotes and splits tool-version files', async () => {
    const repoDir = await repoWith({
      '.nvmrc': '# pinned\n18 # lts\n',
      '.tool-versions': 'nodejs 18.12.0\n\n# dropped\npython 3.11.1 3.10.4\n',
      'go.mod': 'module example.com/x\n\ngo 1.21\ntoolchain go1.22.1\n',
      'netlify.toml': '[build.environment]\n  NODE_VERSION = "18"\n  PYTHON_VERSION = \'3.8\'\n',
      'runtime.txt': 'python-3.9.1\n',
      'setup.py': 'setup(name="x", python_requires=">=3.7,<4", install_requires=[])\n',
    });
    const { signals } = await findRuntimeVersions(repoDir);
    expect(brief(signals)).toEqual([
      '.nvmrc:2 node=18 [.nvmrc]',
      '.tool-versions:1 node=18.12.0 [.tool-versions]',
      '.tool-versions:4 python=3.11.1 3.10.4 [.tool-versions]',
      'go.mod:3 go=1.21 [go.mod]',
      'go.mod:4 go=1.22.1 [go.mod]',
      'netlify.toml:2 node=18 [netlify.toml]',
      'netlify.toml:3 python=3.8 [netlify.toml]',
      'runtime.txt:1 python=3.9.1 [runtime.txt]',
      'setup.py:1 python=>=3.7,<4 [setup.py python_requires]',
    ]);
  });

  it('reads package managers, volta and infrastructure runtimes, keeping the raw line', async () => {
    const repoDir = await repoWith({
      Pipfile: '[requires]\npython_version = "3.9"\n',
      'app.yaml': 'runtime: python39\nentrypoint: gunicorn main:app\n',
      'main.tf': 'resource "aws_lambda_function" "f" {\n  runtime = "nodejs18.x" # pinned\n}\n',
      'package.json': [
        '{',
        '  "packageManager": "pnpm@9.1.0",',
        '  "engines": {',
        '    "node": ">=18",',
        '    "npm": ">=9"',
        '  },',
        '  "volta": {',
        '    "node": "18.20.0",',
        '    "yarn": "1.22.19"',
        '  },',
        '  "dependencies": {',
        '    "node": "0.0.1"',
        '  }',
        '}',
        '',
      ].join('\n'),
      'template.yaml': 'Resources:\n  Fn:\n    Properties:\n      Runtime: "python3.9"\n',
      'vercel.json':
        '{\n  "functions": {\n    "api/*.js": { "runtime": "@vercel/node@3.0.0" }\n  }\n}\n',
    });
    const { signals } = await findRuntimeVersions(repoDir);
    expect(brief(signals)).toEqual([
      'Pipfile:2 python=3.9 [Pipfile python_version]',
      'app.yaml:1 python=39 [app.yaml runtime]',
      'main.tf:2 node=18.x [terraform runtime]',
      'package.json:2 pnpm=9.1.0 [package.json packageManager]',
      'package.json:4 node=>=18 [package.json engines]',
      'package.json:5 npm=>=9 [package.json engines]',
      'package.json:8 node=18.20.0 [package.json volta]',
      'package.json:9 yarn=1.22.19 [package.json volta]',
      'template.yaml:4 python=3.9 [CloudFormation Runtime]',
      'vercel.json:3 @vercel/node=3.0.0 [vercel.json runtime]',
    ]);
    expect(signals.find((signal) => signal.file === 'main.tf')?.text).toBe(
      'runtime = "nodejs18.x" # pinned',
    );
    expect(signals.find((signal) => signal.file === 'template.yaml')?.text).toBe(
      'Runtime: "python3.9"',
    );
  });
});

describe('findContainerImages', () => {
  it('reads the FROM line of the Node demo API', async () => {
    const { signals } = await findContainerImages(await repoWith(DEMO_NODE_API));
    expect(signals).toEqual([
      {
        file: 'Dockerfile',
        line: 1,
        text: 'FROM node:18',
        name: 'node',
        version: '18',
        source: 'Dockerfile FROM',
      },
    ]);
  });

  it('resolves ARG defaults and finds both stages in the monorepo', async () => {
    const { signals } = await findContainerImages(await repoWith(MONOREPO));
    expect(signals).toEqual([
      {
        file: 'apps/web/Dockerfile',
        line: 2,
        text: 'FROM node:${NODE_VERSION}-alpine AS build',
        name: 'node',
        version: '20-alpine',
        source: 'Dockerfile FROM',
      },
      {
        file: 'apps/web/Dockerfile',
        line: 4,
        text: 'FROM nginx:1.25-bookworm',
        name: 'nginx',
        version: '1.25-bookworm',
        source: 'Dockerfile FROM',
      },
      {
        file: 'services/worker/Dockerfile',
        line: 1,
        text: 'FROM python:3.11-slim-bookworm',
        name: 'python',
        version: '3.11-slim-bookworm',
        source: 'Dockerfile FROM',
      },
    ]);
  });

  it('skips scratch and earlier stages, and handles platforms, digests and registry ports', async () => {
    const repoDir = await repoWith({
      'Dockerfile.dev': [
        'FROM --platform=linux/amd64 node:18-alpine AS base',
        'FROM base AS deps',
        'FROM scratch',
        'FROM ghcr.io/acme/app@sha256:abc123',
        'FROM registry:5000/team/tool:2.1 as tool',
        'FROM $BASE_IMAGE',
        '# FROM commented:1',
        '',
      ].join('\n'),
      'notDockerfile.txt': 'FROM ignored:1\n',
    });
    const { signals } = await findContainerImages(repoDir);
    expect(brief(signals)).toEqual([
      'Dockerfile.dev:1 node=18-alpine [Dockerfile FROM]',
      'Dockerfile.dev:4 ghcr.io/acme/app=sha256:abc123 [Dockerfile FROM]',
      'Dockerfile.dev:5 registry:5000/team/tool=2.1 [Dockerfile FROM]',
      'Dockerfile.dev:6 $BASE_IMAGE= [Dockerfile FROM]',
    ]);
  });

  it('resolves ARG defaults, inline fallbacks and leaves unknown arguments raw', async () => {
    const repoDir = await repoWith({
      'api.dockerfile': [
        'ARG REGISTRY=ghcr.io/acme',
        'ARG TAG',
        'FROM ${REGISTRY}/base:${TAG:-3.1}',
        'FROM $REGISTRY/other:${TAG}',
        '',
      ].join('\n'),
      Containerfile: 'FROM docker.io/library/alpine:3.19\n',
    });
    const { signals } = await findContainerImages(repoDir);
    expect(brief(signals)).toEqual([
      'Containerfile:1 docker.io/library/alpine=3.19 [Dockerfile FROM]',
      'api.dockerfile:3 ghcr.io/acme/base=3.1 [Dockerfile FROM]',
      'api.dockerfile:4 ghcr.io/acme/other=${TAG} [Dockerfile FROM]',
    ]);
  });

  it('reads image keys in compose, CI and devcontainer files, ignoring comments', async () => {
    const repoDir = await repoWith({
      '.circleci/config.yml': 'jobs:\n  build:\n    docker:\n      - image: cimg/node:18.0\n',
      '.devcontainer/devcontainer.json': [
        '{',
        '  // "image": "old:1",',
        '  "image": "mcr.microsoft.com/devcontainers/typescript-node:20"',
        '}',
        '',
      ].join('\n'),
      '.github/workflows/ci.yml': [
        'jobs:',
        '  t:',
        '    container: node:18',
        '    services:',
        '      pg:',
        '        image: postgres:14',
        '',
      ].join('\n'),
      'docker-compose.yml': [
        'services:',
        '  db:',
        '    image: "postgres:15" # primary',
        '  cache:',
        '    image: redis',
        '  app:',
        '    build: .',
        '    # image: commented:1',
        '',
      ].join('\n'),
    });
    const { signals } = await findContainerImages(repoDir);
    expect(brief(signals)).toEqual([
      '.circleci/config.yml:4 cimg/node=18.0 [yaml image]',
      '.devcontainer/devcontainer.json:3 mcr.microsoft.com/devcontainers/typescript-node=20 [devcontainer.json image]',
      '.github/workflows/ci.yml:3 node=18 [yaml container]',
      '.github/workflows/ci.yml:6 postgres=14 [yaml image]',
      'docker-compose.yml:3 postgres=15 [yaml image]',
      'docker-compose.yml:5 redis= [yaml image]',
    ]);
  });
});

describe('findCiVersions', () => {
  it('reads runner, actions and node-version in the Next demo workflow', async () => {
    const { signals, otherCiFiles } = await findCiVersions(await repoWith(DEMO_NEXT_WEB));
    expect(brief(signals)).toEqual([
      '.github/workflows/ci.yml:10 runner=ubuntu-latest [workflow runs-on]',
      '.github/workflows/ci.yml:12 actions/checkout=v2 [workflow uses]',
      '.github/workflows/ci.yml:13 actions/setup-node=v2 [workflow uses]',
      '.github/workflows/ci.yml:15 node=16 [workflow node-version]',
    ]);
    expect(signals[1].text).toBe('- uses: actions/checkout@v2');
    expect(otherCiFiles).toEqual([]);
  });

  it('expands matrices, keeps expressions raw and skips local actions in the monorepo', async () => {
    const { signals } = await findCiVersions(await repoWith(MONOREPO));
    expect(brief(signals)).toEqual([
      '.github/workflows/ci.yml:7 node=18 [workflow matrix]',
      '.github/workflows/ci.yml:7 node=20 [workflow matrix]',
      '.github/workflows/ci.yml:8 os=ubuntu-20.04 [workflow matrix]',
      '.github/workflows/ci.yml:8 os=ubuntu-22.04 [workflow matrix]',
      '.github/workflows/ci.yml:9 runner=${{ matrix.os }} [workflow runs-on]',
      '.github/workflows/ci.yml:11 actions/checkout=v3 [workflow uses]',
      '.github/workflows/ci.yml:12 actions/setup-node=v3 [workflow uses]',
      '.github/workflows/ci.yml:14 node=${{ matrix.node }} [workflow node-version]',
      '.github/workflows/ci.yml:15 actions/setup-python=v4 [workflow uses]',
      '.github/workflows/ci.yml:17 python=3.11 [workflow python-version]',
    ]);
  });

  it('finds nothing in a repo with no CI', async () => {
    expect(await findCiVersions(await repoWith(DEMO_NODE_API))).toEqual({
      signals: [],
      otherCiFiles: [],
    });
  });

  it('reads block lists, flow lists, include entries, docker actions and reusable workflows', async () => {
    const repoDir = await repoWith({
      '.github/workflows/a.yaml': [
        'jobs:',
        '  a:',
        '    runs-on: [self-hosted, linux]',
        '    strategy:',
        '      matrix:',
        '        python:',
        '          - "3.9"      # oldest',
        "          - '3.10'",
        '        include:',
        '          - os: ubuntu-18.04',
        '            node: 14',
        '    steps:',
        '      - uses: actions/setup-python@v4',
        '        with:',
        '          python-version:',
        '            - 3.9',
        '            - ${{ matrix.python }}',
        '      - uses: octo/repo/.github/workflows/build.yml@main',
        '      - uses: docker://alpine:3.8',
        '      - uses: actions/cache/restore@a1b2c3 # v3',
        '  b:',
        '    runs-on:',
        '      - ubuntu-22.04',
        '    uses: acme/shared/.github/workflows/deploy.yml@v1',
        '',
      ].join('\n'),
    });
    const { signals } = await findCiVersions(repoDir);
    expect(brief(signals)).toEqual([
      '.github/workflows/a.yaml:3 runner=self-hosted [workflow runs-on]',
      '.github/workflows/a.yaml:3 runner=linux [workflow runs-on]',
      '.github/workflows/a.yaml:7 python=3.9 [workflow matrix]',
      '.github/workflows/a.yaml:8 python=3.10 [workflow matrix]',
      '.github/workflows/a.yaml:10 os=ubuntu-18.04 [workflow matrix]',
      '.github/workflows/a.yaml:11 node=14 [workflow matrix]',
      '.github/workflows/a.yaml:13 actions/setup-python=v4 [workflow uses]',
      '.github/workflows/a.yaml:16 python=3.9 [workflow python-version]',
      '.github/workflows/a.yaml:17 python=${{ matrix.python }} [workflow python-version]',
      '.github/workflows/a.yaml:18 octo/repo/.github/workflows/build.yml=main [workflow uses]',
      '.github/workflows/a.yaml:19 docker://alpine=3.8 [workflow uses]',
      '.github/workflows/a.yaml:20 actions/cache/restore=a1b2c3 [workflow uses]',
      '.github/workflows/a.yaml:23 runner=ubuntu-22.04 [workflow runs-on]',
      '.github/workflows/a.yaml:24 acme/shared/.github/workflows/deploy.yml=v1 [workflow uses]',
    ]);
  });

  it('reads composite actions and lists other CI systems without parsing them', async () => {
    const repoDir = await repoWith({
      '.github/actions/setup/action.yml': [
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: actions/setup-node@v4',
        '      with:',
        '        node-version: 20',
        '',
      ].join('\n'),
      '.github/other/not-a-workflow.yml': 'runs-on: ubuntu-18.04\n',
      '.gitlab-ci.yml': 'image: node:18\n',
      '.circleci/config.yml': 'version: 2.1\n',
      Jenkinsfile: 'pipeline {}\n',
      'ci/azure-pipelines.yml': 'pool: {}\n',
    });
    const { signals, otherCiFiles } = await findCiVersions(repoDir);
    expect(brief(signals)).toEqual([
      '.github/actions/setup/action.yml:4 actions/setup-node=v4 [workflow uses]',
      '.github/actions/setup/action.yml:6 node=20 [workflow node-version]',
    ]);
    expect(otherCiFiles).toEqual([
      '.circleci/config.yml',
      '.gitlab-ci.yml',
      'Jenkinsfile',
      'ci/azure-pipelines.yml',
    ]);
  });
});

describe('findSetupFiles', () => {
  it('points at setup files and the lines in them that pin a version', async () => {
    const repoDir = await makeRepo(MONOREPO);
    const { files, versionLines } = await findSetupFiles(repoDir);
    await removeRepo(repoDir);
    expect(files).toEqual(['Makefile', 'scripts/lint-dockerfiles.sh']);
    expect(versionLines.map(({ file, line }) => `${file}:${line}`)).toEqual([
      'Makefile:2',
      'Makefile:3',
      'scripts/lint-dockerfiles.sh:2',
    ]);
  });

  it('ignores ordinary source, and lines with no install or version', async () => {
    const repoDir = await makeRepo({
      'src/app.py': 'import python3.8\n',
      'run.sh': 'echo hello\nnode-v18-linux\napt-get install -y curl\n',
    });
    const { files, versionLines } = await findSetupFiles(repoDir);
    await removeRepo(repoDir);
    expect(files).toEqual(['run.sh']);
    expect(versionLines.map(({ line }) => line)).toEqual([2, 3]);
  });
});
