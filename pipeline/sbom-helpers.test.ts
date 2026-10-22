import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import {
  debianComponents,
  describeArchive,
  imageBom,
  npmGlobalComponents,
  npmPurl,
  type Sbom,
} from '../scripts/sbom-helpers.mjs';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function npmSbom(): Sbom {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    metadata: {
      component: {
        'bom-ref': 'package@0.39.0',
        type: 'application',
        name: 'package',
        version: '0.39.0',
      },
    },
    components: [
      {
        'bom-ref': 'pg@8.23.1',
        type: 'library',
        name: 'pg',
        version: '8.23.1',
        purl: npmPurl('pg', '8.23.1'),
      },
    ],
    dependencies: [
      { ref: 'package@0.39.0', dependsOn: ['pg@8.23.1'] },
      { ref: 'pg@8.23.1', dependsOn: [] },
    ],
  };
}

it('encodes npm scopes in package URLs', () => {
  expect(npmPurl('pg', '8.23.1')).toBe('pkg:npm/pg@8.23.1');
  expect(npmPurl('@esbuild/linux-x64', '0.28.2')).toBe('pkg:npm/%40esbuild/linux-x64@0.28.2');
});

it('names the archive root after the package and records the archive digest', () => {
  const bom = describeArchive(npmSbom(), {
    name: 'refit',
    version: '0.39.0',
    license: 'MIT',
    sha256: 'a'.repeat(64),
  });
  expect(bom.metadata.component).toMatchObject({
    'bom-ref': 'refit@0.39.0',
    name: 'refit',
    purl: 'pkg:npm/refit@0.39.0',
    hashes: [{ alg: 'SHA-256', content: 'a'.repeat(64) }],
    licenses: [{ license: { id: 'MIT' } }],
  });
  expect(bom.dependencies).toEqual([
    { ref: 'refit@0.39.0', dependsOn: ['pg@8.23.1'] },
    { ref: 'pg@8.23.1', dependsOn: [] },
  ]);
  expect(bom.components).toEqual(npmSbom().components);
});

it('reads dpkg-query output, keeping epochs and architectures in the package URL', () => {
  expect(
    debianComponents('git\t1:2.39.5-0+deb12u2\tamd64\nca-certificates\t20230311\tall\n', 'debian'),
  ).toEqual([
    {
      'bom-ref': 'pkg:deb/debian/git@1%3A2.39.5-0%2Bdeb12u2?arch=amd64',
      type: 'library',
      name: 'git',
      version: '1:2.39.5-0+deb12u2',
      purl: 'pkg:deb/debian/git@1%3A2.39.5-0%2Bdeb12u2?arch=amd64',
    },
    {
      'bom-ref': 'pkg:deb/debian/ca-certificates@20230311?arch=all',
      type: 'library',
      name: 'ca-certificates',
      version: '20230311',
      purl: 'pkg:deb/debian/ca-certificates@20230311?arch=all',
    },
  ]);
  expect(() => debianComponents('git 2.39\n', 'debian')).toThrow('Unexpected dpkg-query line');
});

it('lists global npm tools except the ones described separately', () => {
  const listing = { dependencies: { npm: { version: '10.9.4' }, refit: { version: '0.39.0' } } };
  expect(npmGlobalComponents(listing, ['refit']).map((component) => component.purl)).toEqual([
    'pkg:npm/npm@10.9.4',
  ]);
  expect(() => npmGlobalComponents({ dependencies: { corepack: {} } })).toThrow('no version');
});

it('builds one image SBOM whose root depends on everything installed, and refuses duplicates', () => {
  const refit = describeArchive(npmSbom(), {
    name: 'refit',
    version: '0.39.0',
    sha256: 'b'.repeat(64),
  });
  const input = {
    image: 'refit-hosted:test',
    imageId: `sha256:${'c'.repeat(64)}`,
    debian: debianComponents('git\t1:2.39.5\tamd64\n', 'debian'),
    node: '22.22.0',
    oasdiff: '1.33.0',
    globals: npmGlobalComponents({ dependencies: { npm: { version: '10.9.4' } } }),
    refit,
    timestamp: '2026-10-22T00:00:00.000Z',
  };
  const bom = imageBom(input);
  expect(bom.metadata.component).toEqual({
    'bom-ref': 'refit-hosted:test',
    type: 'container',
    name: 'refit-hosted:test',
    version: `sha256:${'c'.repeat(64)}`,
  });
  expect(bom.components.map((component) => component.name)).toEqual([
    'git',
    'node',
    'oasdiff',
    'npm',
    'refit',
    'pg',
  ]);
  expect(bom.dependencies?.[0]).toEqual({
    ref: 'refit-hosted:test',
    dependsOn: [
      'pkg:deb/debian/git@1%3A2.39.5?arch=amd64',
      'pkg:generic/node@22.22.0',
      'pkg:golang/github.com/oasdiff/oasdiff@v1.33.0',
      'pkg:npm/npm@10.9.4',
      'refit@0.39.0',
    ],
  });
  expect(bom.dependencies?.slice(1)).toEqual(refit.dependencies);
  expect(() => imageBom({ ...input, globals: [...input.globals, ...input.globals] })).toThrow(
    'Duplicate SBOM component',
  );
});

it('writes the CLI tarball SBOM from its shrinkwrap without installing anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'refit-sbom-test-'));
  roots.push(root);
  const packed = JSON.parse(
    (
      await execute(
        process.execPath,
        [resolve('scripts/package-cli.mjs'), '--output', join(root, 'archive')],
        {
          timeout: 60_000,
        },
      )
    ).stdout,
  ) as { archive: string; version: string };
  const output = join(root, 'refit.cdx.json');
  await execute(
    process.execPath,
    [resolve('scripts/sbom.mjs'), 'cli', '--archive', packed.archive, '--output', output],
    { timeout: 60_000 },
  );
  const bom = JSON.parse(await readFile(output, 'utf8')) as Sbom;
  const shrinkwrap = JSON.parse(
    (await execute('tar', ['-xOf', packed.archive, 'package/npm-shrinkwrap.json'])).stdout,
  ) as { packages: Record<string, unknown> };
  expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5' });
  expect(bom.metadata.component).toMatchObject({
    name: 'refit',
    version: packed.version,
    licenses: [{ license: { id: 'MIT' } }],
    hashes: [
      {
        alg: 'SHA-256',
        content: createHash('sha256')
          .update(await readFile(packed.archive))
          .digest('hex'),
      },
    ],
  });
  expect(bom.components).toHaveLength(Object.keys(shrinkwrap.packages).length - 1);
  expect(bom.components.every((component) => component.purl?.startsWith('pkg:npm/'))).toBe(true);
  // A second run never overwrites an existing SBOM.
  await expect(
    execute(process.execPath, [
      resolve('scripts/sbom.mjs'),
      'cli',
      '--archive',
      packed.archive,
      '--output',
      output,
    ]),
  ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('EEXIST') });
}, 120_000);
