import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prismaSchemaPaths } from './runtime-stand-ins.ts';
import { isObject, parseObject } from './specifications.ts';
import { hasErrorCode } from './state-files.ts';

// Preparation installs dependencies with lifecycle scripts disabled and checks run on a clean
// checkout, so files a repository's tools generate at install or dev time are missing: the Prisma
// client its `postinstall` generates, and the next-env.d.ts its tsconfig.json includes. With
// Validation recreates them offline in each check's sandbox, before the checks, from committed
// inputs only; they never reach the patch. On by default since the founder's decision of
// 2026-10-28 (AGENTS.md), which superseded the removal of 2026-10-22; REFIT_GENERATE_CLIENTS=0
// turns it off.
export const generatorsEnabled = (environment: NodeJS.ProcessEnv = process.env) =>
  environment.REFIT_GENERATE_CLIENTS !== '0';
const PRISMA_GENERATE =
  /^(?:npx )?prisma generate((?: --no-engine| --schema(?:=| )(?!-)[\w@./-]+)*)$/;
const EXIT_MARKER = 'REFIT_GENERATOR_EXIT=';

export interface DeclaredGenerator {
  name: 'prisma generate' | 'next-env.d.ts';
  command: string[];
  environment?: Record<string, string>;
}

// Prisma's install scripts download its native engines from binaries.prisma.sh, which preparation
// never runs and validation cannot reach. `prisma generate` needs only its bundled WebAssembly to
// build the client, but it downloads missing engines unless these point at existing files. With
// placeholders the client loads and type-checks; a query fails, as it would with no database.
const PRISMA_OFFLINE = {
  CHECKPOINT_DISABLE: '1',
  PRISMA_HIDE_UPDATE_MESSAGE: '1',
  PRISMA_SCHEMA_ENGINE_BINARY: '/dev/null',
  // Prisma 4's name for the schema engine.
  PRISMA_MIGRATION_ENGINE_BINARY: '/dev/null',
  PRISMA_QUERY_ENGINE_LIBRARY: '/dev/null',
  PRISMA_QUERY_ENGINE_BINARY: '/dev/null',
};

async function readText(directory: string, path: string) {
  try {
    return await readFile(join(directory, path), 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return undefined;
    throw error;
  }
}

async function exists(directory: string, path: string, kind: 'file' | 'directory') {
  try {
    const entry = await lstat(join(directory, path));
    return kind === 'file' ? entry.isFile() : entry.isDirectory();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) return false;
    throw error;
  }
}

const declares = (manifest: Record<string, unknown>, name: string) =>
  ['dependencies', 'devDependencies'].some(
    (section) => isObject(manifest[section]) && manifest[section][name] !== undefined,
  );

// The postinstall's exact `prisma generate`, or, for a repository that declares @prisma/client and
// commits a schema where `prisma generate` finds it, the same command with no flags (the client a
// developer generates by hand or in a build script).
async function prismaGenerate(
  directory: string,
  manifest: Record<string, unknown>,
): Promise<DeclaredGenerator | undefined> {
  const script = isObject(manifest.scripts) ? manifest.scripts.postinstall : undefined;
  const match = typeof script === 'string' ? PRISMA_GENERATE.exec(script.trim()) : null;
  if (
    !match &&
    !(declares(manifest, '@prisma/client') && (await prismaSchemaPaths(directory)).length)
  )
    return undefined;
  const flags = match ? match[1].trim().split(/[ =]+/).filter(Boolean) : [];
  if (flags.some((flag) => flag.split('/').includes('..'))) return undefined;
  return {
    name: 'prisma generate',
    command: ['prisma', 'generate', ...flags],
    environment: PRISMA_OFFLINE,
  };
}

// The directives `next dev` and `next build` write (next/dist/lib/typescript/
// writeAppTypeDeclarations.js, 13.4 to 15.5), less Next 15.5's reference to the build's own
// .next/types/routes.d.ts, which a clean checkout does not have.
async function nextEnvironment(directory: string, manifest: Record<string, unknown>) {
  const declared = declares(manifest, 'next');
  const tsconfig = await readText(directory, 'tsconfig.json');
  if (!declared || !tsconfig?.includes('"next-env.d.ts"')) return undefined;
  if (await exists(directory, 'next-env.d.ts', 'file')) return undefined;
  const directories = async (name: string) =>
    (await exists(directory, name, 'directory')) ||
    (await exists(directory, `src/${name}`, 'directory'));
  const directives = [
    '/// <reference types="next" />',
    '/// <reference types="next/image-types/global" />',
    ...((await directories('app')) && (await directories('pages'))
      ? ['/// <reference types="next/navigation-types/compat/navigation" />']
      : []),
  ];
  return {
    name: 'next-env.d.ts' as const,
    command: [
      'sh',
      '-c',
      `test -f node_modules/next/package.json && printf '%s\\n' ${directives.map((line) => `'${line}'`).join(' ')} > next-env.d.ts`,
    ],
  };
}

export async function declaredGenerators(directory: string): Promise<DeclaredGenerator[]> {
  const content = await readText(directory, 'package.json');
  if (content === undefined) return [];
  const manifest = parseObject(content, 'package.json');
  return [
    await prismaGenerate(directory, manifest),
    await nextEnvironment(directory, manifest),
  ].filter((generator) => generator !== undefined);
}

const shellWord = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

// Each generator runs in order and its exit code is recorded; the checks run whatever they return.
export function withGenerators(
  generators: readonly DeclaredGenerator[],
  command: readonly string[],
) {
  return [
    'sh',
    '-c',
    generators
      .map(
        (generator, index) =>
          `${Object.entries(generator.environment ?? {})
            .map(([name, value]) => `${name}=${shellWord(value)} `)
            .join('')}` +
          `${generator.command.map(shellWord).join(' ')} >&2; ` +
          `printf '\\n${EXIT_MARKER}${index}:%s\\n' "$?" >&2; `,
      )
      .join('') + 'exec "$@"',
    'refit-generate',
    ...command,
  ];
}

// Takes the generators' exit codes out of a check's stderr.
export function generatorExits(generators: readonly DeclaredGenerator[], stderr: string) {
  const exitCodes = generators.map(() => null as number | null);
  const output = stderr.replace(
    new RegExp(`\\n?${EXIT_MARKER}(\\d+):(\\d+)\\n`, 'g'),
    (marker, index: string, code: string) => {
      if (Number(index) >= exitCodes.length) return marker;
      exitCodes[Number(index)] = Number(code);
      return '';
    },
  );
  return {
    stderr: output,
    generators: generators.map((generator, index) => ({
      ...generator,
      exitCode: exitCodes[index],
    })),
  };
}
