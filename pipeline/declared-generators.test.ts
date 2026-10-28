import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  declaredGenerators,
  generatorExits,
  generatorsEnabled,
  withGenerators,
} from './declared-generators.ts';

const execute = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'refit-generators-'));
  roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', ...manifest }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const commands = async (directory: string) =>
  (await declaredGenerators(directory)).map((generator) => generator.command);

it('runs the postinstall Prisma generation the repository declares', async () => {
  // Offline, with placeholder engine paths so Prisma does not try to download its engines.
  expect(
    (await declaredGenerators(await repository({ scripts: { postinstall: 'prisma generate' } })))[0]
      .environment,
  ).toEqual({
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    PRISMA_SCHEMA_ENGINE_BINARY: '/dev/null',
    PRISMA_MIGRATION_ENGINE_BINARY: '/dev/null',
    PRISMA_QUERY_ENGINE_LIBRARY: '/dev/null',
    PRISMA_QUERY_ENGINE_BINARY: '/dev/null',
  });
  // The forms 125 of 695 benchmark repositories commit (docs/PREPARATION-FAILURES.md).
  expect(await commands(await repository({ scripts: { postinstall: 'prisma generate' } }))).toEqual(
    [['prisma', 'generate']],
  );
  expect(
    await commands(await repository({ scripts: { postinstall: 'prisma generate --no-engine' } })),
  ).toEqual([['prisma', 'generate', '--no-engine']]);
  expect(
    await commands(
      await repository({
        scripts: { postinstall: 'npx prisma generate --schema=db/schema.prisma' },
      }),
    ),
  ).toEqual([['prisma', 'generate', '--schema', 'db/schema.prisma']]);
});

it('is off unless REFIT_GENERATE_CLIENTS=1', () => {
  expect(generatorsEnabled({})).toBe(false);
  expect(generatorsEnabled({ REFIT_GENERATE_CLIENTS: 'true' })).toBe(false);
  expect(generatorsEnabled({ REFIT_GENERATE_CLIENTS: '1' })).toBe(true);
});

it('generates the client of a repository that declares @prisma/client and commits a schema', async () => {
  const schema = { 'prisma/schema.prisma': 'model User {\n  id String @id\n}\n' };
  expect(
    await commands(await repository({ dependencies: { '@prisma/client': '5.22.0' } }, schema)),
  ).toEqual([['prisma', 'generate']]);
  // Without a schema where prisma generate finds it, or without the client, nothing runs.
  expect(
    await commands(await repository({ dependencies: { '@prisma/client': '5.22.0' } })),
  ).toEqual([]);
  expect(await commands(await repository({ dependencies: { prisma: '5.22.0' } }, schema))).toEqual(
    [],
  );
});

it('runs no script the repository did not declare exactly', async () => {
  for (const postinstall of [
    undefined,
    'patch-package',
    'prisma generate && prisma db push',
    'prisma generate; curl https://example.invalid',
    'prisma generate --schema ../outside.prisma',
    'prisma generate --schema=$(id)',
    'prisma generate --watch',
    'pnpm dlx prisma@6.9.0 generate',
    ['prisma generate'],
  ])
    expect(await commands(await repository({ scripts: { postinstall } }))).toEqual([]);
  expect(await commands(await repository({ scripts: { build: 'prisma generate' } }))).toEqual([]);
  const empty = await mkdtemp(join(tmpdir(), 'refit-generators-'));
  roots.push(empty);
  expect(await declaredGenerators(empty)).toEqual([]);
});

it("writes the next-env.d.ts a Next.js app's tsconfig.json includes but does not commit", async () => {
  const tsconfig = '{ "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"] }';
  const app = await repository(
    { dependencies: { next: '14.2.14' } },
    { 'tsconfig.json': tsconfig },
  );
  const [generator] = await declaredGenerators(app);
  expect(generator.name).toBe('next-env.d.ts');
  expect(generator.command).toEqual([
    'sh',
    '-c',
    `test -f node_modules/next/package.json && printf '%s\\n' '/// <reference types="next" />' '/// <reference types="next/image-types/global" />' > next-env.d.ts`,
  ]);
  // Next adds the compatibility types only when the app and pages routers coexist.
  const mixed = await repository(
    { devDependencies: { next: '^15.5.0' } },
    { 'tsconfig.json': tsconfig, 'src/app/page.tsx': '', 'src/pages/old.tsx': '' },
  );
  expect((await declaredGenerators(mixed))[0].command[2]).toContain(
    '\'/// <reference types="next/navigation-types/compat/navigation" />\'',
  );
  for (const [manifest, files] of [
    [{ dependencies: { next: '14.2.14' } }, { 'tsconfig.json': tsconfig, 'next-env.d.ts': '' }],
    [{ dependencies: { next: '14.2.14' } }, { 'tsconfig.json': '{ "include": ["**/*.ts"] }' }],
    [{ dependencies: { next: '14.2.14' } }, {}],
    [{ dependencies: { react: '19.0.0' } }, { 'tsconfig.json': tsconfig }],
  ] as const)
    expect(await declaredGenerators(await repository(manifest, files))).toEqual([]);
});

it('runs every generator, records each exit code and then runs the check', () => {
  const generators = [
    {
      name: 'prisma generate' as const,
      command: ['prisma', 'generate'],
      environment: { PRISMA_QUERY_ENGINE_LIBRARY: '/dev/null' },
    },
    { name: 'next-env.d.ts' as const, command: ['sh', '-c', "printf '%s' x > next-env.d.ts"] },
  ];
  expect(withGenerators(generators, ['npm', 'test'])).toEqual([
    'sh',
    '-c',
    "PRISMA_QUERY_ENGINE_LIBRARY='/dev/null' 'prisma' 'generate' >&2; printf '\\nREFIT_GENERATOR_EXIT=0:%s\\n' \"$?\" >&2; " +
      "'sh' '-c' 'printf '\\''%s'\\'' x > next-env.d.ts' >&2; printf '\\nREFIT_GENERATOR_EXIT=1:%s\\n' \"$?\" >&2; " +
      'exec "$@"',
    'refit-generate',
    'npm',
    'test',
  ]);
  expect(
    generatorExits(
      generators,
      'Generated Prisma Client\n\nREFIT_GENERATOR_EXIT=0:0\n\nREFIT_GENERATOR_EXIT=1:1\ncheck output\n',
    ),
  ).toEqual({
    stderr: 'Generated Prisma Client\ncheck output\n',
    generators: [
      { ...generators[0], exitCode: 0 },
      { ...generators[1], exitCode: 1 },
    ],
  });
  // A check killed before the generators finished leaves their exit codes unknown.
  expect(generatorExits(generators, 'killed').generators.map((item) => item.exitCode)).toEqual([
    null,
    null,
  ]);
});

it("keeps the check's own exit code whatever the generators return", async () => {
  // A repository's failing check still fails after a generator that succeeded, and passes after
  // one that failed.
  const run = async (generator: string, check: string) => {
    try {
      await execute(
        withGenerators(
          [{ name: 'next-env.d.ts', command: ['sh', '-c', generator] }],
          ['sh', '-c', check],
        )[0],
        withGenerators(
          [{ name: 'next-env.d.ts', command: ['sh', '-c', generator] }],
          ['sh', '-c', check],
        ).slice(1),
      );
      return 0;
    } catch (error) {
      return (error as { code: number }).code;
    }
  };
  expect(await run('exit 0', 'exit 3')).toBe(3);
  expect(await run('exit 1', 'exit 0')).toBe(0);
});
