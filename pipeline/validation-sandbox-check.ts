// The judge the agent fixer is graded by (gut plan SC-S1 to SC-S4, founder decision, 2026-10-31;
// docs/GUT-PLAN.md). sandboxBaseline installs the repository in the build sandbox, scripts
// allowed (installInSandbox), and runs its type check, build and tests on the original tree once;
// sandboxCheck runs them on an edited tree and counts only failures the original did not have.
// A regression is returned as errors for the agent, never a stop; no runnable check is unproven
// (needs-review), never a stop. Every check runs offline in the validation sandbox.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { newTestFailures } from './check-failures.ts';
import { readCommittedRepository } from './committed-repository.ts';
import { resolveDockerImage } from './docker-sandbox.ts';
import { gitEnvironment } from './git-environment.ts';
import { baselineStop } from './preparation-stops.ts';
import { installInSandbox } from './repository-environment.ts';
import { typeErrorKeys, typeErrors } from './type-errors.ts';
import { containerCheck, extractSnapshot, type CheckResult } from './validation.ts';
import { DEFAULT_CHECK_TIMEOUT_SECONDS, validateCheckTimeout } from './validation-options.ts';
import { NODE_22_IMAGE, selectValidationRuntime } from './validation-runtime.ts';

const execute = promisify(execFile);
export type SandboxCheckKind = 'typecheck' | 'build' | 'tests';

export interface SandboxCheckPart {
  kind: SandboxCheckKind;
  command: string[];
}

export interface SandboxBaseline {
  root: string;
  image: string;
  timeoutMs: number;
  install: { status: 'installed'; command: string[] } | { status: 'failed'; error: string };
  dependencies?: string;
  packageFiles: string;
  parts: (SandboxCheckPart & { result: CheckResult })[];
  // Archives built for edited package files, by their fingerprint, so rounds reuse them.
  installs: Map<string, Promise<string | undefined>>;
}

export interface SandboxCheckResult {
  passed: boolean;
  // Exact failing lines the patch added, each tagged with its check: what the agent gets back.
  errors: string[];
  // Why passing proves less than it says (needs-review): no check ran, or one fails on the original.
  unproven: string[];
  parts: {
    kind: SandboxCheckKind;
    command: string[];
    baseline: CheckResult['status'];
    patched: CheckResult['status'];
    newFailures: string[];
    generators?: CheckResult['generators'];
  }[];
}

const TYPE_CHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'types', 'tsc'];
const PLACEHOLDER_TEST = /no test specified/;
const tsc = (binary: string) => `${binary} --noEmit --pretty false -p .`;
// The repository's compiler when it installs one, else Refit's (mounted in every check sandbox).
const TSC_COMMAND = [
  '/bin/sh',
  '-c',
  `if [ -x node_modules/.bin/tsc ]; then exec ${tsc('node_modules/.bin/tsc')}; else exec ${tsc('node /refit/typescript/lib/tsc.js')}; fi`,
];

// The checks a tree has: its type check script (it may run typegen first), else tsc over its
// tsconfig.json; its build script; its test script unless it is npm's placeholder.
export function sandboxCheckParts(
  manifest: string | undefined,
  hasTsconfig: boolean,
): SandboxCheckPart[] {
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(manifest ?? '{}');
    if (parsed && typeof parsed.scripts === 'object') scripts = parsed.scripts ?? {};
  } catch {
    scripts = {};
  }
  const has = (name: string) => typeof scripts[name] === 'string' && Boolean(scripts[name]);
  const typeScript = TYPE_CHECK_SCRIPTS.find(has);
  return [
    ...(typeScript
      ? [{ kind: 'typecheck' as const, command: ['npm', 'run', typeScript] }]
      : hasTsconfig
        ? [{ kind: 'typecheck' as const, command: TSC_COMMAND }]
        : []),
    ...(has('build') ? [{ kind: 'build' as const, command: ['npm', 'run', 'build'] }] : []),
    ...(has('test') && !PLACEHOLDER_TEST.test(String(scripts.test))
      ? [{ kind: 'tests' as const, command: ['npm', 'test'] }]
      : []),
  ];
}

const ANSI = /\u001b\[[0-9;]*m/g;
const ERROR_LINE =
  /\berror\b|Error\b|ERR!|ERR_|\bfailed\b|\bFAIL\b|^\s*[×✗✕]\s|not ok\b|Cannot find|Could not resolve|is not defined|is not a function/i;
const MAX_LINES = 40;
// Line and column positions and timings move when the agent edits; the comparison ignores them.
const normalized = (line: string) =>
  line
    .replace(/[:(]\d+[:,]\d+\)?/g, '')
    .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, '')
    .trim();
const errorLines = (check: CheckResult) =>
  `${check.stdout}\n${check.stderr}`
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => ERROR_LINE.test(line))
    .map((line) => line.slice(0, 300));

// The last lines a check printed, for a failure that names no error line.
const tail = (check: CheckResult) =>
  `${check.stdout}\n${check.stderr}`
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-10)
    .map((line) => line.slice(0, 300));

// The failures `after` has that `before` did not, and why a check proves nothing when it fails on
// the original code too. Exported for the unit tests.
export function newFailures(
  kind: SandboxCheckKind,
  command: string[],
  before: CheckResult,
  after: CheckResult,
): { errors: string[]; unproven?: string } {
  const name = `the ${kind === 'tests' ? 'test' : kind === 'typecheck' ? 'type check' : 'build'} (${command.join(' ')})`;
  const baselineNote = () => {
    const stop = baselineStop(`${before.stdout}\n${before.stderr}`);
    return `${name[0].toUpperCase()}${name.slice(1)} already ${before.status === 'error' ? 'does not run or finish' : 'fails'} on the original code${stop ? ` (${stop.summary})` : ''}, so it proves nothing about the patch beyond the new failures it shows.`;
  };
  if (after.status === 'passed' || after.status === 'not-run')
    return { errors: [], ...(before.status === 'passed' ? {} : { unproven: baselineNote() }) };
  if (after.status === 'error')
    return before.status === 'error'
      ? { errors: [], unproven: baselineNote() }
      : { errors: [`${name} did not finish: ${after.error ?? 'the sandbox stopped it'}`] };
  // A failed check from here on.
  if (kind === 'typecheck' && typeErrors(after).length) {
    const known = typeErrorKeys(before);
    const added = typeErrors(after)
      .filter((error) => !known.has(error.key))
      .map(
        (error) =>
          `${error.file}(${error.line},${error.column}): error ${error.code}: ${error.message}`,
      );
    return { errors: added, ...(before.status === 'passed' ? {} : { unproven: baselineNote() }) };
  }
  if (kind === 'tests' && before.status === 'failed') {
    const added = newTestFailures(before, after);
    if (added) return { errors: added };
  }
  const lines = errorLines(after);
  if (before.status === 'passed')
    return {
      errors: (lines.length
        ? lines
        : [`${name} exited with ${after.exitCode}:`, ...tail(after)]
      ).slice(0, MAX_LINES),
    };
  const known = new Set(errorLines(before).map(normalized));
  return {
    errors: lines.filter((line) => !known.has(normalized(line))).slice(0, MAX_LINES),
    unproven: baselineNote(),
  };
}

// Package files decide the installed dependencies; an edit to one needs a new install.
const PACKAGE_FILE =
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|\.yarnrc|\.yarnrc\.yml)$/;
const SKIPPED = new Set(['node_modules', '.git']);
async function packageFiles(directory: string) {
  const hash = createHash('sha256');
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && PACKAGE_FILE.test(entry.name))
        hash.update(`${relative(directory, child)}\0${await readFile(child)}\0`);
    }
  };
  await walk(directory);
  return hash.digest('hex');
}

const git = (directory: string, argumentsList: string[]) =>
  execute(
    'git',
    [
      '-c',
      'gc.auto=0',
      '-c',
      'user.name=Refit',
      '-c',
      'user.email=refit@localhost',
      '-c',
      'commit.gpgsign=false',
      ...argumentsList,
    ],
    { cwd: directory, env: gitEnvironment(), maxBuffer: 16 * 1024 * 1024 },
  );

// Installs a tree in the build sandbox; the install failing is recorded, not thrown: the checks
// still run without dependencies and only new failures count.
async function install(
  repository: string,
  image: string,
  archive: string,
  options: { signal?: AbortSignal; onProgress?: (message: string) => void },
) {
  try {
    const prepared = await installInSandbox({
      repository,
      image,
      copyArchiveTo: archive,
      ...options,
    });
    const command = (prepared.environment.installation as { command: string[] }).command;
    return { status: 'installed' as const, command };
  } catch (error) {
    options.signal?.throwIfAborted();
    return {
      status: 'failed' as const,
      error: error instanceof Error ? error.message : `${error}`,
    };
  }
}

// A committed copy of an edited tree, which installInSandbox reads with git.
async function committedCopy(directory: string, root: string) {
  const copy = await mkdtemp(join(root, 'edited-'));
  await cp(directory, copy, {
    recursive: true,
    filter: (source) => !SKIPPED.has(source.slice(source.lastIndexOf('/') + 1)),
  });
  await git(copy, ['init', '-q']);
  await git(copy, ['add', '-A', '--force']);
  await git(copy, ['commit', '-q', '--allow-empty', '-m', 'Refit agent candidate']);
  return copy;
}

async function treeParts(directory: string) {
  const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch(() => undefined);
  const hasTsconfig = await readFile(join(directory, 'tsconfig.json')).then(
    () => true,
    () => false,
  );
  return sandboxCheckParts(manifest, hasTsconfig);
}

// shortcut: one process-wide limit of two sandboxes at once (a 16 GB runner fits two 5 GiB
// checks); move it into docker-sandbox.ts if other callers need the same limit.
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(run: () => Promise<T>) {
  const limit = Math.max(1, Number(process.env.REFIT_SANDBOX_CHECKS ?? 2) || 1);
  if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await run();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// Installs the committed tree of a git repository and runs its checks on it, once per repository.
// Throws only when the repository cannot be read or Docker fails (infrastructure).
export async function sandboxBaseline(options: {
  repository: string;
  image?: string;
  checkTimeoutSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<SandboxBaseline> {
  const snapshot = await readCommittedRepository(options.repository);
  const runtime = await selectValidationRuntime(snapshot, options.image ?? NODE_22_IMAGE);
  const image = await resolveDockerImage(runtime.image);
  const timeoutMs =
    validateCheckTimeout(options.checkTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS) * 1000;
  const root = await mkdtemp(join(tmpdir(), 'refit-sandbox-check-'));
  try {
    const { baselineDirectory } = await extractSnapshot(
      snapshot.directory,
      snapshot.revision,
      root,
    );
    const dependencies = join(root, 'dependencies.tar');
    options.onProgress?.('Installing the original tree in the build sandbox, scripts allowed...');
    const installed = await install(snapshot.directory, image, dependencies, options);
    const archive = installed.status === 'installed' ? dependencies : undefined;
    const parts = [];
    for (const part of await treeParts(baselineDirectory)) {
      options.onProgress?.(`Running ${part.command.join(' ')} on the original tree...`);
      const result = await limited(() =>
        containerCheck({
          directory: baselineDirectory,
          image,
          command: part.command,
          dependencies: archive,
          timeoutMs,
          signal: options.signal,
        }),
      );
      parts.push({ ...part, result });
    }
    return {
      root,
      image,
      timeoutMs,
      install: installed,
      ...(archive ? { dependencies: archive } : {}),
      packageFiles: await packageFiles(baselineDirectory),
      parts,
      installs: new Map(),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeSandboxBaseline(baseline: SandboxBaseline) {
  await rm(baseline.root, { recursive: true, force: true });
}

// The judge GUT2 and GUT3 pass to fixWithAgent as `check`: the original's checks on the edited
// tree, reinstalled when its package files changed. A check the edit adds or drops (a new build
// script) runs on the edited tree only and counts every failure.
export async function sandboxCheck(
  repoDir: string,
  baseline: SandboxBaseline,
  options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
): Promise<SandboxCheckResult> {
  // The sandbox user reads the mount; a mkdtemp copy (mode 700) would fail every check.
  await chmod(repoDir, 0o755);
  const fingerprint = await packageFiles(repoDir);
  let dependencies = baseline.dependencies;
  const unproven: string[] = [];
  if (baseline.install.status === 'failed')
    unproven.push(
      `The original tree did not install in the sandbox, so the checks ran without dependencies: ${baseline.install.error.slice(0, 600)}`,
    );
  if (fingerprint !== baseline.packageFiles) {
    if (!baseline.installs.has(fingerprint))
      baseline.installs.set(
        fingerprint,
        (async () => {
          const copy = await committedCopy(repoDir, baseline.root);
          const archive = join(baseline.root, `dependencies-${randomUUID()}.tar`);
          options.onProgress?.('Package files changed; installing the edited tree...');
          const installed = await install(copy, baseline.image, archive, options);
          await rm(copy, { recursive: true, force: true });
          return installed.status === 'installed' ? archive : undefined;
        })(),
      );
    dependencies = await baseline.installs.get(fingerprint);
  }
  const errors: string[] = [];
  const parts: SandboxCheckResult['parts'] = [];
  if (fingerprint !== baseline.packageFiles && !dependencies && baseline.dependencies)
    errors.push(
      '[install] The edited package files no longer install in the sandbox; the original ones did.',
    );
  const edited = await treeParts(repoDir);
  const known = new Map(baseline.parts.map((part) => [part.command.join(' '), part.result]));
  for (const part of [
    ...baseline.parts,
    ...edited.filter((part) => !known.has(part.command.join(' '))),
  ]) {
    options.signal?.throwIfAborted();
    const before: CheckResult = known.get(part.command.join(' ')) ?? {
      status: 'passed',
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
    const after = await limited(() =>
      containerCheck({
        directory: repoDir,
        image: baseline.image,
        command: part.command,
        dependencies,
        timeoutMs: baseline.timeoutMs,
        signal: options.signal,
      }),
    );
    const counted = newFailures(part.kind, part.command, before, after);
    errors.push(...counted.errors.map((line) => `[${part.kind}] ${line}`));
    if (counted.unproven) unproven.push(counted.unproven);
    parts.push({
      kind: part.kind,
      command: part.command,
      baseline: before.status,
      patched: after.status,
      newFailures: counted.errors,
      ...(after.generators ? { generators: after.generators } : {}),
    });
  }
  if (!parts.length)
    unproven.push(
      'The repository has no type check, build or test script Refit can run, so nothing checked the patch.',
    );
  return { passed: errors.length === 0, errors, unproven, parts };
}
