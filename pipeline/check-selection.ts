import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { createSourceImportResolver } from './source-imports.ts';
import { parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// The repository's own compiler, without install or network. With compareTypeErrors the patched
// check fails only on errors the patch introduced.
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
// Refit's own compiler, mounted read-only in every check sandbox (validation.ts), for a repository
// that installs none.
export const REFIT_TSC = '/refit/typescript/lib/tsc.js';
// The configuration a scoped type check writes into the sandbox's copy of the repository.
export const SCOPED_TSCONFIG = '.refit-tsconfig.json';
// What a tests-then-type-check chain prints between its parts: type errors count only after the
// second line, and a run that printed the first failed its tests (validation.ts compareTypeCheck).
// The type check runs after failing tests too, so tests broken before a patch leave it as evidence.
export const TESTS_FAILED = 'Refit: the tests failed, the type check still runs.';
export const TYPE_CHECK_STARTED = 'Refit: type check.';
const TSCONFIG = 'tsconfig.json';
const BASE_CONFIGURATIONS = [TSCONFIG, 'jsconfig.json'];
// Above this, a scoped type check covers the whole repository instead of listing files.
const MAX_SCOPED_LIST_BYTES = 16 * 1024;
// Default `npm init` script; it is not a check.
const PLACEHOLDER_TEST = /no test specified/;
// A test script that is one Vitest or Jest command, so file arguments select its test files.
const FILE_RUNNER = /^\s*(vitest|jest)\b[^&|;<>`$()]*$/;
// Browser suites another runner owns, which a unit runner given their paths would fail on.
const BROWSER_TEST = /(?:^|\/)(?:e2e|playwright|cypress)(?:\/|\.)/;
// Above this, the whole suite runs rather than a long list of files.
const MAX_LISTED_TESTS = 50;
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const JAVASCRIPT_FILE = /\.[cm]?jsx?$/;
const STRIPE_IMPORT =
  /\bfrom\s*['"]stripe['"]|\brequire\(\s*['"]stripe['"]\s*\)|\bimport\(\s*['"]stripe['"]\s*\)/;
// TypeScript types the client only through an import: stripe-node's typings export a class, so
// `require('stripe')(key)` is not callable to it and leaves every Stripe call untyped.
const TYPED_STRIPE_IMPORT =
  /\bfrom\s*['"]stripe['"]|\bimport\(\s*['"]stripe['"]\s*\)|\bimport\s+\w+\s*=\s*require\(\s*['"]stripe['"]\s*\)/;
const TEST_RUNNER = /\b(?:vitest|jest|mocha|ava|tap|playwright|cypress|node --test|bun test)\b/;
const TYPE_CHECKER = /\btsc\b/;
const CONFIGURATION_HOST = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };

export type CheckKind = 'tests' | 'typecheck';

export interface CheckSelection {
  // `tests` whenever the tests run (a type check may run after them), `typecheck` when only a type
  // check runs, null when no check can.
  kind: CheckKind | null;
  command: string[] | null;
  compareTypeErrors?: true;
  // The type check: the root tsconfig.json's program, or a generated one over the Stripe files.
  typeCheck?: 'project' | 'scoped';
  // Files that import the stripe package, and those a test reaches or the type check covers.
  stripeFiles: string[];
  testedStripeFiles: string[];
  typeCheckedStripeFiles: string[];
  reason: string;
}

export type EvidenceLevel =
  'behaviour-tests' | 'stripe-tests' | 'type-check' | 'generated-check' | 'none';

// A: behaviour tests cover every changed Stripe line; B: the repository's tests reach every changed
// file; C: a type check covers the rest; D: some changed file has no check, or no check passed.
export type EvidenceLetter = 'A' | 'B' | 'C' | 'D';

export interface EvidenceGrade {
  letter: EvidenceLetter;
  level: EvidenceLevel;
  reason: string;
}

// Grade A's evidence, built by a behaviour-test harness: tests that ran every changed Stripe line
// on the original code against the old API version's stripe-mock and on the patched code against
// the new one's. Generated placeholder checks are not behaviour tests.
export interface BehaviourEvidence {
  passed: boolean;
  coversEveryChangedLine: boolean;
  reason: string;
}

const list = (files: string[]) =>
  files.length > 3
    ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`
    : files.join(', ');

const posix = (root: string, path: string) => relative(root, path).split('\\').join('/');

// Each source file's static, dynamic and require() imports of other repository files.
function importGraph(repository: Repository) {
  const root = resolve(repository.root);
  const sources = new Map(repository.files.map((file) => [resolve(root, file.path), file.content]));
  const resolver = createSourceImportResolver(repository, sources);
  const graph = new Map<string, Set<string>>();
  for (const file of repository.files) {
    if (!SOURCE_FILE.test(file.path)) continue;
    const targets = new Set<string>();
    const add = (specifier: string) => {
      const target = resolver.resolve(specifier, resolve(root, file.path));
      if (target && sources.has(target)) targets.add(posix(root, target));
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        add(node.moduleSpecifier.text);
      else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      )
        add(node.moduleReference.expression.text);
      else if (
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true));
    graph.set(file.path, targets);
  }
  return graph;
}

function importers(graph: Map<string, Set<string>>) {
  const reversed = new Map<string, Set<string>>();
  for (const [file, targets] of graph)
    for (const target of targets) {
      if (!reversed.has(target)) reversed.set(target, new Set());
      reversed.get(target)!.add(file);
    }
  return reversed;
}

// `start` and every file reachable from it along the graph's edges.
function reach(graph: Map<string, Set<string>>, start: Iterable<string>) {
  const seen = new Set(start);
  const queue = [...seen];
  while (queue.length)
    for (const next of graph.get(queue.pop()!) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
  return seen;
}

const testFiles = (repository: Repository) =>
  repository.files.map((file) => file.path).filter((path) => TEST_FILE.test(path));

function readConfiguration(path: string, existingOptions: ts.CompilerOptions = {}) {
  return existsSync(path)
    ? ts.getParsedCommandLineOfConfigFile(path, existingOptions, CONFIGURATION_HOST)
    : undefined;
}

// The files a type check over `parsed` reports errors in: its root files and the repository files
// they import, TypeScript always and JavaScript only with checkJs.
function programFiles(
  root: string,
  parsed: ts.ParsedCommandLine | undefined,
  graph: Map<string, Set<string>>,
) {
  if (!parsed) return new Set<string>();
  return new Set(
    [
      ...reach(
        graph,
        parsed.fileNames.map((file) => posix(root, file)),
      ),
    ].filter((file) => !JAVASCRIPT_FILE.test(file) || parsed.options.checkJs),
  );
}

// Files `tsc -p .` reports errors for. A solution-style tsconfig (`"files": []` with references)
// checks nothing under `-p .`.
export function typeCheckedFiles(repository: Repository) {
  return programFiles(
    repository.root,
    readConfiguration(join(repository.root, TSCONFIG)),
    importGraph(repository),
  );
}

// The repository configuration a scoped type check extends: the one whose program, JavaScript
// included, holds the most Stripe files, among the root's, those a solution-style root references
// and the nearest one above each Stripe file. The root's wins a tie, and otherwise any it has.
function baseConfiguration(root: string, stripeFiles: string[]) {
  const candidates = BASE_CONFIGURATIONS.filter((name) => existsSync(join(root, name)));
  const references =
    readConfiguration(join(root, TSCONFIG))?.projectReferences?.map((reference) =>
      existsSync(reference.path) && statSync(reference.path).isDirectory()
        ? join(reference.path, TSCONFIG)
        : reference.path,
    ) ?? [];
  const nearest = stripeFiles.flatMap((file) => {
    for (
      let directory = dirname(join(root, file));
      directory.startsWith(`${root}/`);
      directory = dirname(directory)
    ) {
      const found = BASE_CONFIGURATIONS.map((name) => join(directory, name)).find(existsSync);
      if (found) return [found];
    }
    return [];
  });
  let best: { name: string; covered: number } | undefined;
  for (const path of new Set([
    ...candidates.map((name) => join(root, name)),
    ...references,
    ...nearest,
  ])) {
    const name = posix(root, path);
    if (name.startsWith('../') || !existsSync(path)) continue;
    const files = new Set(
      (readConfiguration(path, { allowJs: true })?.fileNames ?? []).map((file) =>
        posix(root, file),
      ),
    );
    const covered = stripeFiles.filter((file) => files.has(file)).length;
    if (!best || covered > best.covered) best = { name, covered };
  }
  return best && (best.covered > 0 || candidates.includes(best.name)) ? best.name : candidates[0];
}

// The configuration a scoped type check writes: the base configuration's settings with JavaScript
// checked, over `files`, and modern defaults for what the base leaves unset (an ES5 default target
// declares no Promise, which would leave every Stripe response untyped).
function scopedConfiguration(root: string, base: string | undefined, files: string[]) {
  const parsed = base ? readConfiguration(join(root, base)) : undefined;
  const options = parsed?.options ?? {};
  // An `extends` only the sandbox can resolve (a package's tsconfig) sets what Refit cannot see here.
  const unknown = parsed?.errors.some((error) => error.code === 6053);
  return {
    ...(base ? { extends: `./${base}` } : {}),
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      // A composite project reports every imported file the list leaves out, a new helper included.
      composite: false,
      ...(unknown
        ? {}
        : {
            ...(options.target === undefined ? { target: 'es2022' } : {}),
            ...(options.module === undefined && options.moduleResolution === undefined
              ? { module: 'esnext', moduleResolution: 'bundler' }
              : {}),
            ...(options.jsx === undefined ? { jsx: 'preserve' } : {}),
          }),
    },
    ...(JSON.stringify(files).length <= MAX_SCOPED_LIST_BYTES
      ? { files, include: [] }
      : { include: ['**/*'] }),
  };
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

// The one check enrollment, the hosted worker and the benchmark run. A real test script always runs.
// A type check runs after it, or alone without tests, when it can cover the Stripe code: the root
// tsconfig.json's program when it holds every file importing stripe, otherwise a generated tsconfig
// over those files and every file importing them (with Refit's compiler only without tests, and
// never for a client only `require()` loads). Never a no-op.
export async function selectCheck(repository: Repository): Promise<CheckSelection> {
  const root = repository.root;
  const { scripts, declared } = await manifestScripts(root);
  const tests = typeof scripts.test === 'string' && !PLACEHOLDER_TEST.test(scripts.test);
  const ownCompiler = Boolean(declared.typescript);
  const graph = importGraph(repository);
  const stripeFiles = repository.files
    .filter((file) => !TEST_FILE.test(file.path) && STRIPE_IMPORT.test(file.content))
    .map((file) => file.path);
  const tested = tests ? reach(graph, testFiles(repository)) : new Set<string>();
  const testedStripeFiles = stripeFiles.filter((path) => tested.has(path));
  const rootConfiguration = readConfiguration(join(root, TSCONFIG));
  const project = ownCompiler ? programFiles(root, rootConfiguration, graph) : new Set<string>();
  const uncovered = stripeFiles.filter((path) => !project.has(path));
  const projectCheck = project.size > 0 && !uncovered.length;
  const dependents = stripeFiles.length ? [...reach(importers(graph), stripeFiles)].sort() : [];
  const scope = dependents.filter((path) => !TEST_FILE.test(path));
  // The test files that reach Stripe code, run alone when the runner takes file arguments: no other
  // test imports a file the patch can change, and a long suite then fits the check's time limit.
  const runner =
    typeof scripts.test === 'string' && !/passWithNoTests/.test(scripts.test)
      ? FILE_RUNNER.exec(scripts.test)?.[1]
      : undefined;
  const stripeTests = dependents.filter((path) => TEST_FILE.test(path) && !BROWSER_TEST.test(path));
  const listed =
    tests &&
    runner &&
    stripeTests.length > 0 &&
    stripeTests.length < testFiles(repository).length &&
    stripeTests.length <= MAX_LISTED_TESTS
      ? stripeTests
      : [];
  const typed = repository.files.some(
    (file) => stripeFiles.includes(file.path) && TYPED_STRIPE_IMPORT.test(file.content),
  );
  const scoped = !projectCheck && typed && (ownCompiler || !tests);
  const base = scoped ? baseConfiguration(root, stripeFiles) : undefined;
  const manager = packageManager(root);
  // npm passes script arguments only after `--`; pnpm and Yarn pass them as given.
  const fileOptions = [
    ...(manager === 'npm' ? ['--'] : []),
    ...(runner === 'jest' ? ['--runTestsByPath'] : []),
  ];
  const chained = tests && (projectCheck || scoped);
  // In a `sh -c` chain the generated tsconfig and the test files are arguments, never script text.
  const typeCheckScript = projectCheck
    ? TYPE_CHECK.join(' ')
    : `printf '%s' "${chained && listed.length ? '$config' : '$1'}" > ${SCOPED_TSCONFIG} && ${ownCompiler ? 'npx --no-install tsc' : `node ${REFIT_TSC}`} --noEmit --pretty false -p ${SCOPED_TSCONFIG}`;
  const testScript = [manager, 'test', ...(listed.length ? [...fileOptions, '"$@"'] : [])].join(
    ' ',
  );
  const command = chained
    ? [
        'sh',
        '-c',
        `${scoped && listed.length ? 'config=$1; shift; ' : ''}${testScript} || echo '${TESTS_FAILED}'; echo '${TYPE_CHECK_STARTED}'; ${typeCheckScript}`,
        'refit-check',
        ...(scoped ? [JSON.stringify(scopedConfiguration(root, base, scope))] : []),
        ...listed,
      ]
    : tests
      ? [manager, 'test', ...(listed.length ? [...fileOptions, ...listed] : [])]
      : projectCheck
        ? TYPE_CHECK
        : scoped
          ? [
              'sh',
              '-c',
              typeCheckScript,
              'refit-check',
              JSON.stringify(scopedConfiguration(root, base, scope)),
            ]
          : null;
  const testsClause = !tests
    ? 'There is no test script'
    : listed.length
      ? `The tests import Stripe code in ${list(testedStripeFiles)}, and only the ${listed.length} test ${listed.length === 1 ? 'file' : 'files'} that reach it run (${list(listed)}); no other test reaches a file the patch can change`
      : testedStripeFiles.length
        ? `The tests import Stripe code in ${list(testedStripeFiles)}`
        : 'No test imports Stripe code, so the tests show only that the rest of the code still works';
  const because = !rootConfiguration
    ? ', because there is no tsconfig.json'
    : !ownCompiler
      ? ''
      : !project.size
        ? `, because tsc -p . checks no file${rootConfiguration.projectReferences?.length ? ' (tsconfig.json only references other projects)' : ''}`
        : `, because tsconfig.json leaves out ${list(uncovered)}`;
  const typeClause = projectCheck
    ? stripeFiles.length
      ? `the type check (tsc over tsconfig.json) covers the Stripe code in ${list(stripeFiles)}`
      : 'the type check (tsc over tsconfig.json) covers the code, though no file imports stripe'
    : scoped
      ? `a generated tsconfig${base ? ` extending ${base}` : ''} type-checks the Stripe code (${list(stripeFiles)}) and every file importing it${because}${ownCompiler ? '' : ", with Refit's own TypeScript because the repository installs none"}`
      : !stripeFiles.length
        ? 'no file imports stripe, so no type check can cover the Stripe code'
        : !typed
          ? `stripe is loaded with require() (${list(stripeFiles)}), which TypeScript leaves untyped, so no type check can cover the Stripe code`
          : 'TypeScript is not installed, so no type check runs with them';
  return {
    kind: tests ? 'tests' : command ? 'typecheck' : null,
    command,
    ...(projectCheck || scoped ? { compareTypeErrors: true as const } : {}),
    ...(projectCheck
      ? { typeCheck: 'project' as const }
      : scoped
        ? { typeCheck: 'scoped' as const }
        : {}),
    stripeFiles,
    testedStripeFiles,
    typeCheckedStripeFiles: projectCheck || scoped ? stripeFiles : [],
    reason: `${testsClause}. ${typeClause[0].toUpperCase()}${typeClause.slice(1)}.${chained ? ' Both must pass.' : ''}`,
  };
}

// The simple commands a check runs: `sh -c` scripts (Refit's chains and configured ones) are split
// into their parts.
function simpleCommands(command: readonly string[]) {
  return command[0] === 'sh' && command[1] === '-c' && command[2]
    ? command[2].split(/&&|\|\||[;|{}]/).map((part) =>
        part
          .trim()
          .replace(/^exec\s+/, '')
          .split(/\s+/),
      )
    : [command];
}

// What a check command runs: a test script, the type checker, or both.
export function checkKinds(command: readonly string[], scripts: Record<string, unknown>) {
  const kinds = new Set<CheckKind>();
  for (const part of simpleCommands(command)) {
    if (part.some((word) => TYPE_CHECKER.test(word))) kinds.add('typecheck');
    const [manager, first, second] = part;
    const script = ['npm', 'pnpm', 'yarn', 'bun'].includes(manager)
      ? first === 'run'
        ? second
        : first
      : undefined;
    const text = script && typeof scripts[script] === 'string' ? (scripts[script] as string) : '';
    if (script === 'test' || TEST_RUNNER.test(text)) kinds.add('tests');
    if (TYPE_CHECKER.test(text)) kinds.add('typecheck');
  }
  return kinds;
}

// The test files a check command names, when it runs only some.
function listedTests(command: readonly string[]) {
  return command
    .slice(command[0] === 'sh' ? 3 : 0)
    .filter((part) => !part.startsWith('{') && TEST_FILE.test(part));
}

// The part of a tests-then-type-check chain that failed, when the check is one, as a command a
// person can rerun.
export function failingPart(command: readonly string[], output: string) {
  const script = command[0] === 'sh' && command[1] === '-c' ? (command[2] ?? '') : '';
  const testsEnd = script.indexOf(` || echo '${TESTS_FAILED}'`);
  const typeStart = script.indexOf(`echo '${TYPE_CHECK_STARTED}'; `);
  if (testsEnd < 0 || typeStart < 0) return undefined;
  // Without either line, the tests were still running or ended the shell.
  return output.includes(TYPE_CHECK_STARTED) && !output.includes(TESTS_FAILED)
    ? {
        part: 'type check' as const,
        command: script
          .slice(typeStart + `echo '${TYPE_CHECK_STARTED}'; `.length)
          .replace(/^printf '%s' "\$\w+" > \S+ && /, ''),
      }
    : {
        part: 'tests' as const,
        command: script
          .slice(0, testsEnd)
          .replace(/^config=\$1; shift; /, '')
          .replace('"$@"', listedTests(command).join(' ')),
      };
}

// The type check part of a tests-then-type-check chain, as a command of its own.
export function typeCheckCommand(command: readonly string[]) {
  const script = command[0] === 'sh' && command[1] === '-c' ? (command[2] ?? '') : '';
  const start = script.indexOf(`echo '${TYPE_CHECK_STARTED}'; `);
  if (start < 0) return undefined;
  const configuration = command.slice(3).find((part) => part.startsWith('{'));
  return [
    'sh',
    '-c',
    script.slice(start + `echo '${TYPE_CHECK_STARTED}'; `.length).replace('"$config"', '"$1"'),
    'refit-check',
    ...(configuration ? [configuration] : []),
  ];
}

// The files a type check command covered: a scoped check's generated configuration, or the
// repository root's tsconfig.json.
function checkedProgram(root: string, command: readonly string[], graph: Map<string, Set<string>>) {
  const configuration = command.slice(3).find((part) => part.startsWith('{'));
  const scoped =
    command[0] === 'sh' && command[2]?.includes(SCOPED_TSCONFIG) && configuration
      ? ts.parseConfigFileTextToJson(SCOPED_TSCONFIG, configuration).config
      : undefined;
  return programFiles(
    root,
    scoped
      ? ts.parseJsonConfigFileContent(
          scoped,
          CONFIGURATION_HOST,
          root,
          undefined,
          join(root, SCOPED_TSCONFIG),
        )
      : readConfiguration(join(root, TSCONFIG)),
    graph,
  );
}

// A validation whose checks did not pass proves nothing about the patch.
export const ungradedEvidence = (reason: string): EvidenceGrade => ({
  letter: 'D',
  level: 'none',
  reason,
});

// How much a passing validation proves about the changed files, file by file: grade B when the
// repository's tests import every one, C when the type check covers those they miss, else D.
export async function gradeEvidence(options: {
  // The patched candidate: its files and the directory tsc would run in.
  repository: Repository;
  command: readonly string[];
  changedFiles: readonly string[];
  generated?: { entryPoints: unknown[]; notRunnable: unknown[]; patched: { status: string } };
  // The behaviour-test harness's result, the only evidence for grade A.
  behaviour?: BehaviourEvidence;
  // Tests that already failed on the original code: why, and whether the type check that ran after
  // them passed on both sides. They prove nothing about the patch, so only the type check can.
  testsBroken?: { reason: string; typeCheck: { passed: boolean; detail?: string } };
}): Promise<EvidenceGrade> {
  if (options.behaviour?.passed && options.behaviour.coversEveryChangedLine)
    return { letter: 'A', level: 'behaviour-tests', reason: options.behaviour.reason };
  const root = options.repository.root;
  const { scripts } = await manifestScripts(root);
  const kinds = checkKinds(options.command, scripts);
  const graph = importGraph(options.repository);
  const changed = options.changedFiles.filter((path) => SOURCE_FILE.test(path));
  if (options.testsBroken) {
    const { reason, typeCheck } = options.testsBroken;
    const typed = checkedProgram(root, options.command, graph);
    const unchecked = changed.filter((path) => !typed.has(path));
    return typeCheck.passed && changed.length && !unchecked.length
      ? {
          letter: 'C',
          level: 'type-check',
          reason: `${reason} The tests were broken before the patch, so they prove nothing about it; tsc type-checks ${list(changed)} and passed on both sides.`,
        }
      : {
          letter: 'D',
          level: 'none',
          reason: `${reason} The tests were broken before the patch, and ${!typeCheck.passed ? (typeCheck.detail ?? 'the type check did not pass on both sides') : changed.length ? `the type check does not cover ${list(unchecked)}` : 'the patch changes no source file a check could reach'}.`,
        };
  }
  const listed = listedTests(options.command);
  const tested = kinds.has('tests')
    ? reach(graph, listed.length ? listed : testFiles(options.repository))
    : new Set<string>();
  const typed = kinds.has('typecheck')
    ? checkedProgram(root, options.command, graph)
    : new Set<string>();
  const reached = changed.filter((path) => tested.has(path));
  const untested = changed.filter((path) => !tested.has(path));
  const unchecked = untested.filter((path) => !typed.has(path));
  if (changed.length && !untested.length)
    return {
      letter: 'B',
      level: 'stripe-tests',
      reason: `The repository's tests reach every changed file (${list(changed)}).`,
    };
  if (changed.length && !unchecked.length)
    return {
      letter: 'C',
      level: 'type-check',
      reason: `${
        !kinds.has('tests')
          ? ''
          : reached.length
            ? `The tests reach ${list(reached)} but not ${list(untested)}. `
            : 'The tests pass but reach none of the changed files. '
      }tsc type-checks ${list(untested)}; no test ran that code.`,
    };
  const generated = options.generated;
  const ran = generated ? generated.entryPoints.length - generated.notRunnable.length : 0;
  const generatedNote =
    generated?.patched.status === 'passed' && ran > 0
      ? `; only the generated stripe-mock checks ran changed code (${ran} exported ${ran === 1 ? 'function' : 'functions'})`
      : ', and no generated check ran it';
  const missed = !changed.length
    ? 'The patch changes no source file a check could reach'
    : kinds.has('tests') && kinds.has('typecheck')
      ? `Neither the tests nor the type check reach ${list(unchecked)}`
      : kinds.has('tests')
        ? `No test reaches ${list(unchecked)}`
        : kinds.has('typecheck')
          ? `The type check does not cover ${list(unchecked)}`
          : `${options.command.join(' ')} is neither a test script nor a type check`;
  return {
    letter: 'D',
    level: generatedNote.startsWith(';') ? 'generated-check' : 'none',
    reason: `${missed}${generatedNote}.`,
  };
}
