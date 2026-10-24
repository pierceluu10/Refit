import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript-compiler';
import { generatedImportMap } from './generated-checks.ts';
import { parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// Without tests, TypeScript repositories typecheck. No install, no network; with compareTypeErrors
// the patched check fails only on errors the patch introduced.
export const TYPE_CHECK = [
  'npx',
  '--no-install',
  'tsc',
  '--noEmit',
  '--pretty',
  'false',
  '-p',
  '.',
];
const TSCONFIG = 'tsconfig.json';
// Default `npm init` script; it is not a check.
const PLACEHOLDER_TEST = /no test specified/;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const JAVASCRIPT_FILE = /\.[cm]?jsx?$/;
const STRIPE_IMPORT =
  /\bfrom\s*['"]stripe['"]|\brequire\(\s*['"]stripe['"]\s*\)|\bimport\(\s*['"]stripe['"]\s*\)/;
const TEST_RUNNER = /\b(?:vitest|jest|mocha|ava|tap|playwright|cypress|node --test|bun test)\b/;
const TYPE_CHECKER = /\btsc\b/;

export type CheckKind = 'tests' | 'typecheck';

export interface CheckSelection {
  kind: CheckKind | null;
  command: string[] | null;
  compareTypeErrors?: true;
  // Files that import the stripe package, and those a test reaches or the type check covers.
  stripeFiles: string[];
  testedStripeFiles: string[];
  typeCheckedStripeFiles: string[];
  reason: string;
}

export type EvidenceLevel = 'stripe-tests' | 'type-check' | 'generated-check' | 'none';

export interface EvidenceGrade {
  level: EvidenceLevel;
  reason: string;
}

const list = (files: string[]) =>
  files.length > 3
    ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`
    : files.join(', ');

// Files test files import, directly or through other repository files.
function testedFiles(repository: Repository) {
  const imports = generatedImportMap(repository);
  const reached = new Set<string>();
  const queue = repository.files.map((file) => file.path).filter((path) => TEST_FILE.test(path));
  while (queue.length) {
    const path = queue.pop()!;
    for (const target of Object.values(imports[path] ?? {}))
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
  }
  return reached;
}

// Files `tsc -p .` reports errors for: the root tsconfig's program, JavaScript only with checkJs.
// A solution-style tsconfig (`"files": []` with references) checks nothing under `-p .`.
export function typeCheckedFiles(root: string) {
  const path = join(root, TSCONFIG);
  if (!existsSync(path)) return new Set<string>();
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  return new Set(
    (parsed?.fileNames ?? [])
      .filter((file) => !JAVASCRIPT_FILE.test(file) || parsed?.options.checkJs)
      .map((file) => relative(root, file).split('\\').join('/')),
  );
}

async function manifestScripts(root: string) {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return { scripts: {}, declared: {} };
  const manifest = parseObject(await readFile(path, 'utf8'), 'package.json');
  return {
    scripts: (manifest.scripts ?? {}) as Record<string, unknown>,
    declared: {
      ...(manifest.dependencies as Record<string, unknown> | undefined),
      ...(manifest.devDependencies as Record<string, unknown> | undefined),
    },
  };
}

function packageManager(root: string) {
  return existsSync(join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(root, 'yarn.lock'))
      ? 'yarn'
      : 'npm';
}

// The one check enrollment, the hosted worker and the benchmark run: tests that reach Stripe code,
// else a type check that covers it, else whichever of the two exists, never a no-op.
export async function selectCheck(repository: Repository): Promise<CheckSelection> {
  const root = repository.root;
  const { scripts, declared } = await manifestScripts(root);
  const tests = typeof scripts.test === 'string' && !PLACEHOLDER_TEST.test(scripts.test);
  const typecheck = existsSync(join(root, TSCONFIG)) && Boolean(declared.typescript);
  const stripeFiles = repository.files
    .filter((file) => !TEST_FILE.test(file.path) && STRIPE_IMPORT.test(file.content))
    .map((file) => file.path);
  const reached = tests ? testedFiles(repository) : new Set<string>();
  const testedStripeFiles = stripeFiles.filter((path) => reached.has(path));
  const checked = typecheck ? typeCheckedFiles(root) : new Set<string>();
  const typeCheckedStripeFiles = stripeFiles.filter((path) => checked.has(path));
  const evidence = { stripeFiles, testedStripeFiles, typeCheckedStripeFiles };
  const testCheck = {
    kind: 'tests' as const,
    command: [packageManager(root), 'test'],
  };
  const typeCheck = {
    kind: 'typecheck' as const,
    command: TYPE_CHECK,
    compareTypeErrors: true as const,
  };
  if (testedStripeFiles.length)
    return {
      ...testCheck,
      ...evidence,
      reason: `Tests import Stripe code in ${list(testedStripeFiles)}.`,
    };
  if (typeCheckedStripeFiles.length)
    return {
      ...typeCheck,
      ...evidence,
      reason: `${tests ? 'No test imports Stripe code; ' : 'There is no test script; '}tsc over ${TSCONFIG} checks the Stripe code in ${list(typeCheckedStripeFiles)}.`,
    };
  if (tests)
    return {
      ...testCheck,
      ...evidence,
      reason: `No test imports Stripe code${typecheck ? ` and tsc over ${TSCONFIG} checks none of it` : ''}; the tests show only that the rest of the code still works.`,
    };
  if (typecheck)
    return {
      ...typeCheck,
      ...evidence,
      reason: `There is no test script, and tsc over ${TSCONFIG} checks none of the Stripe code.`,
    };
  return {
    kind: null,
    command: null,
    ...evidence,
    reason: 'There is no test script and no TypeScript type check.',
  };
}

// What a check command runs: a test script, the type checker, or both (a script that runs tsc).
export function checkKinds(command: readonly string[], scripts: Record<string, unknown>) {
  const kinds = new Set<CheckKind>();
  if (command.some((part) => TYPE_CHECKER.test(part))) kinds.add('typecheck');
  const [manager, first, second] = command;
  const script = ['npm', 'pnpm', 'yarn', 'bun'].includes(manager)
    ? first === 'run'
      ? second
      : first
    : undefined;
  const text = script && typeof scripts[script] === 'string' ? (scripts[script] as string) : '';
  if (script === 'test' || TEST_RUNNER.test(text)) kinds.add('tests');
  if (TYPE_CHECKER.test(text)) kinds.add('typecheck');
  return kinds;
}

// How much a passing validation proves about the changed code, strongest first.
export async function gradeEvidence(options: {
  // The patched candidate: its files and the directory tsc would run in.
  repository: Repository;
  command: readonly string[];
  changedFiles: readonly string[];
  generated?: { entryPoints: unknown[]; notRunnable: unknown[]; patched: { status: string } };
}): Promise<EvidenceGrade> {
  const { scripts } = await manifestScripts(options.repository.root);
  const kinds = checkKinds(options.command, scripts);
  const changed = options.changedFiles.filter((path) => SOURCE_FILE.test(path));
  const command = options.command.join(' ');
  if (kinds.has('tests')) {
    const reached = testedFiles(options.repository);
    const tested = changed.filter((path) => reached.has(path));
    if (tested.length)
      return {
        level: 'stripe-tests',
        reason: `${command} runs tests that import the changed ${list(tested)}.`,
      };
  }
  if (kinds.has('typecheck') && changed.length) {
    const checked = typeCheckedFiles(options.repository.root);
    const unchecked = changed.filter((path) => !checked.has(path));
    if (!unchecked.length)
      return {
        level: 'type-check',
        reason: `${command} type-checks every changed file (${list(changed)}); no changed code ran.`,
      };
  }
  const generated = options.generated;
  const ran = generated ? generated.entryPoints.length - generated.notRunnable.length : 0;
  if (generated?.patched.status === 'passed' && ran > 0)
    return {
      level: 'generated-check',
      reason: `Only the generated stripe-mock checks ran changed code (${ran} exported ${ran === 1 ? 'function' : 'functions'}); ${command} reaches none of it.`,
    };
  return {
    level: 'none',
    reason: `${command} ${kinds.size ? 'reaches none of the changed code' : 'is neither a test script nor a type check'}, and no generated check ran it.`,
  };
}
