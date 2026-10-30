import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  FALLBACK_MODEL,
  fallbackInput,
  modelLiterals,
  openItems,
  quotedSources,
  TEST_PATH,
  withRegistryTargets,
  runAiFallback,
  type FallbackResult,
  type OpenItem,
  type ScanBundle,
} from './ai-fallback.ts';
import type { AiOptions } from './ai-budget.ts';
import { missRecords, type MissRecord } from './ai-misses.ts';
import {
  PROOF_KEYS,
  proveRequests,
  type ProofCall,
  type ProofProvider,
} from './ai-request-proof.ts';
import type { RequestProof } from './ai-migrations.ts';
import { loadAiRuleTables } from './ai-rules.ts';
import { gateNote, repositoryChecks } from './check-gate.ts';
import { checkSources, loadSourcePages } from './deadline-sources.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { resolveNpmLockfile } from './lockfile-resolution.ts';
import { PipelineInputError } from './types.ts';
import { validateSourcePatch } from './validation.ts';

// `refit ai-migrations --ai-fallback`: the AI fallback (pipeline/ai-fallback.ts) on one checked-out
// repository, from the open items a benchmark row recorded. Each gate uses Refit's own pieces:
// the rescan runs the same `refit` commands the benchmark ran, the checks run in offline Docker
// (validateSourcePatch), a changed npm manifest gets its lockfile re-resolved in networked Docker,
// and each new call shape is sent once with Refit's own key (proveRequests). GitHub Actions only.

const execute = promisify(execFile);
const REFIT = fileURLToPath(new URL('../', import.meta.url));
const SCAN_TIMEOUT_MS = 180_000;
const PACKAGES: Record<ProofProvider, string> = {
  openai: 'openai',
  anthropic: '@anthropic-ai/sdk',
  gemini: '@google/genai',
};
const PROOF_MODEL_ENV: Record<ProofProvider, string> = {
  openai: 'REFIT_PROOF_OPENAI_MODEL',
  anthropic: 'REFIT_PROOF_ANTHROPIC_MODEL',
  gemini: 'REFIT_PROOF_GEMINI_MODEL',
};
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|json|ya?ml|toml|env)$|(?:^|\/)\.env[^/]*$/;

async function refit(args: string[]) {
  const { stdout } = await execute(
    process.execPath,
    [join(REFIT, 'bin', 'refit.mjs'), ...args, '--json'],
    { cwd: REFIT, maxBuffer: 64 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  return JSON.parse(stdout);
}

// The same scan the benchmark row came from, as a ScanBundle. `--edits-only` lists SDK-major
// stops without Docker, so the rescan never needs the network.
export async function scanBundle(
  directory: string,
  options: { provider?: string; language?: 'js' | 'py'; parameterChanges?: string },
): Promise<ScanBundle> {
  const counted = (item: { provider?: string; deadline?: { provider?: string } }) =>
    !options.provider || (item.provider ?? item.deadline?.provider) === options.provider;
  const deadlines = await refit(['deadlines', '--repository', directory]);
  const proposal = await refit([
    'deadlines',
    '--propose-model-fixes',
    '--repository',
    directory,
    ...(options.parameterChanges ? ['--parameter-changes', options.parameterChanges] : []),
  ]);
  const review = (
    (await refit(['ai-migrations', '--review', '--repository', directory])) as Array<{
      provider?: string;
    }>
  ).filter(counted);
  const pkg =
    options.provider && options.provider in PACKAGES
      ? ['--package', PACKAGES[options.provider as ProofProvider]]
      : [];
  const sdk =
    options.language === 'py'
      ? null
      : await refit(['ai-migrations', '--edits-only', '--repository', directory, ...pkg]);
  return {
    provider: options.provider,
    language: options.language,
    exposureSites: exposureSites((deadlines.exposures ?? []).filter(counted)),
    replacements: (proposal.replacements ?? []).filter(counted),
    stops: (proposal.stops ?? []).filter(counted),
    unresolved: (proposal.unresolved ?? []).filter(counted),
    alerts: (proposal.alerts ?? []).filter(counted),
    validation: null,
    migrations: { review: review as never, proposal: sdk, validation: null, ai: null },
  };
}

// The fields of `refit deadlines --json` exposures the fallback reads, with at most 20 sites each.
export function exposureSites(
  exposures: Array<{
    deadline: { id: string; provider: string; kind: string; replacement: string | null };
    evidence?: Array<{ file: string; line: number; version: string; text: string; kind?: string }>;
  }>,
): NonNullable<ScanBundle['exposureSites']> {
  return exposures.map((exposure) => ({
    deadline: exposure.deadline.id,
    provider: exposure.deadline.provider,
    kind: exposure.deadline.kind,
    replacement: exposure.deadline.replacement,
    evidence: (exposure.evidence ?? []).slice(0, 20).map((item) => ({
      file: item.file,
      line: item.line,
      version: item.version,
      text: item.text,
    })),
  }));
}

// The registry, the saved deprecation pages' quotes and the AI rule tables, for quotedSources.
export async function loadSourceContext(now: Date) {
  const registry = await loadDeadlineRegistry(undefined, now);
  const pages = await loadSourcePages().catch(() => null);
  return {
    deadlines: registry.deadlines,
    quotes: pages
      ? checkSources(registry, pages.index, pages.pages, now, undefined, pages.changelogs).evidence
      : [],
    tables: await loadAiRuleTables(),
  };
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SETTINGS_FILE = /\.(?:json|ya?ml|toml|ini)$|(?:^|\/)\.env(?:\.[\w.-]+)?$/;
// Translations, changelogs, docs and vendored packages name models as text, not as a setting.
const NOT_SETTINGS =
  /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml|composer\.lock|node_modules\/|site-packages\/|(?:locales?|i18n|lang|translations?|changelogs?|docs?)\/)/;

// Saved model settings (JSON, YAML, TOML, INI and .env files) that still name a model an item's
// deadline retires, as items: a patch that migrates the code and leaves the setting is partial.
export async function savedModelSettings(
  root: string,
  files: string[],
  items: OpenItem[],
): Promise<OpenItem[]> {
  const retired = new Map<string, { ref: string; provider: string }>();
  for (const item of items)
    for (const model of item.retired ?? [])
      retired.set(model, { ref: item.ref, provider: item.provider });
  if (!retired.size) return [];
  const found: OpenItem[] = [];
  for (const path of files) {
    if (!SETTINGS_FILE.test(path) || NOT_SETTINGS.test(path) || TEST_PATH.test(path)) continue;
    const content = await readFile(join(root, path), 'utf8').catch(() => '');
    if (!content || content.length > 512 * 1024) continue;
    const lines = content.split('\n');
    for (const [model, owner] of retired) {
      const pattern = new RegExp(
        `(?:^|[\\s"'=:\\[,/])${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s"',\\]#])`,
      );
      const at = lines.findIndex((line) => pattern.test(line));
      if (at >= 0)
        found.push({
          id: `model-alert:${owner.ref}:${path}:${at + 1}`,
          kind: 'model-alert',
          provider: owner.provider,
          ref: owner.ref,
          changeType: 'retired-model',
          file: path,
          line: at + 1,
          text: model,
          reason: `A saved model setting still names the retired model ${model}.`,
          target: null,
        });
    }
  }
  return found;
}

async function committedFiles(directory: string) {
  const { stdout } = await execute('git', ['-C', directory, 'ls-files', '-z'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean);
}

// A patch for the AI's files against the checkout, new files included: the touched originals are
// committed in a scratch repository and the AI's versions staged on top.
async function renderPatch(files: Array<{ path: string; before: string | null; after: string }>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-fallback-patch-'));
  const git = (...args: string[]) =>
    execute('git', ['-C', root, '-c', 'core.autocrlf=false', ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    await git('init', '-q');
    for (const file of files)
      if (file.before !== null) {
        await mkdir(dirname(join(root, file.path)), { recursive: true });
        await writeFile(join(root, file.path), file.before);
      }
    await git('add', '-A');
    await git(
      '-c',
      'user.name=Refit',
      '-c',
      'user.email=refit@localhost',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'before',
    );
    for (const file of files) {
      await mkdir(dirname(join(root, file.path)), { recursive: true });
      await writeFile(join(root, file.path), file.after);
    }
    await git('add', '-A');
    return (await git('diff', '--cached', '--no-color', '--no-ext-diff', '--full-index')).stdout;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function dependenciesChanged(before: string, after: string) {
  try {
    const [a, b] = [JSON.parse(before), JSON.parse(after)];
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(
      (field) => JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null),
    );
  } catch {
    return false;
  }
}

// The checks a fix must pass are the repository's own, chosen as the rule lanes choose them
// (`refit ai-migrations --validate` and the benchmark's model fixes): its test script when it has
// a real one, else its build script. Refit never adds a check of its own.
export function fallbackCommand(manifest: Record<string, unknown>) {
  const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
  if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test))
    return { command: ['npm', 'test'] };
  if (typeof scripts.build === 'string') return { command: ['npm', 'run', 'build'] };
  return null;
}

export async function runFallbackOnRepository(options: {
  directory: string;
  row: ScanBundle & { repo: string; commit: string; language?: 'js' | 'py' };
  ai: AiOptions;
  image: string;
  parameterChanges?: string;
  environment?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}): Promise<{ items: OpenItem[]; fallback: FallbackResult; misses: MissRecord[] }> {
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS !== 'true')
    throw new PipelineInputError(
      "The AI fallback runs only in GitHub Actions (refit-bench), with Refit's key and AI budget.",
    );
  const { directory, row } = options;
  const provider = row.provider ?? '';
  const language = row.language ?? 'js';
  const items = openItems(row);
  const context = await loadSourceContext(new Date());
  const sources = quotedSources(items, {
    ...context,
    findings: row.migrations?.review as never,
  });
  const partial = [
    ...(row.validation
      ? [
          {
            lane: 'model replacements',
            status: row.validation.status,
            reason: row.validation.reason ?? '',
          },
        ]
      : []),
    ...(row.migrations?.validation
      ? [
          {
            lane: 'SDK major upgrade',
            status: String(row.migrations.validation.status),
            reason: String(row.migrations.validation.reason ?? ''),
          },
        ]
      : []),
    ...(row.migrations?.ai
      ? [
          {
            lane: 'AI surface lane',
            status: String(row.migrations.ai.status),
            reason: String(row.migrations.ai.reason ?? ''),
          },
        ]
      : []),
  ];
  const input = await fallbackInput({
    directory,
    provider,
    language,
    items: withRegistryTargets(items, context.deadlines, context.quotes),
    sources,
    partial,
  });
  const files = await committedFiles(directory);
  const repositoryModels = new Set<string>();
  for (const path of files.filter((path) => SOURCE_FILE.test(path)).slice(0, 5000)) {
    const content = await readFile(join(directory, path), 'utf8').catch(() => '');
    if (content.length < 512 * 1024)
      for (const model of modelLiterals(content)) repositoryModels.add(model);
  }
  const committed = new Set(files);
  const { stdout: date } = await execute('git', ['-C', directory, 'log', '-1', '--format=%cI']);
  const manifest = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8').catch(() => '{}'),
  ) as Record<string, unknown>;
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter((name) =>
    existsSync(join(directory, name)),
  );
  // The rule lane's checks and gate (check-gate.ts): tests, build and type check run separately on
  // both sides; a check that fails on the original code is not counted, one that passed must still
  // pass, and the tests or the type check must count.
  const checks = repositoryChecks(directory, manifest);
  // The manifest the patch leaves, for the request proof's SDK release.
  let patchedManifest = JSON.stringify(manifest);

  // A worktree of the checkout with the patch applied, for the rescan.
  async function withPatched<T>(patch: string, use: (root: string) => Promise<T>) {
    const root = await mkdtemp(join(tmpdir(), 'refit-fallback-rescan-'));
    const copy = join(root, 'repository');
    try {
      await execute('git', ['-C', directory, 'worktree', 'add', '-q', '--detach', copy, 'HEAD']);
      await writeFile(join(root, 'ai.patch'), patch);
      await execute('git', ['-C', copy, 'apply', '--whitespace=nowarn', join(root, 'ai.patch')]);
      return await use(copy);
    } finally {
      await execute('git', ['-C', directory, 'worktree', 'remove', '--force', copy]).catch(
        () => {},
      );
      await rm(root, { recursive: true, force: true });
    }
  }

  const fallback = await runAiFallback({
    input,
    ai: options.ai,
    repositoryModels,
    exists: async (path) => committed.has(path),
    repositoryFiles: async () => {
      const scripts: Array<{ path: string; content: string }> = [];
      for (const path of files.filter((name) => SCRIPT_FILE.test(name)).slice(0, 4000)) {
        const content = await readFile(join(directory, path), 'utf8').catch(() => '');
        if (content.length < 512 * 1024) scripts.push({ path, content });
      }
      return scripts;
    },
    environment,
    dependencies: {
      render: async (changed) => {
        const manifestChange = changed.find((file) => file.path === 'package.json');
        if (manifestChange) patchedManifest = manifestChange.after;
        let refusal: string | null = null;
        const all = [...changed];
        if (
          manifestChange?.before != null &&
          dependenciesChanged(manifestChange.before, manifestChange.after)
        ) {
          if (lockfiles.length === 1 && lockfiles[0] === 'package-lock.json') {
            options.onProgress?.('Re-resolving package-lock.json for the AI manifest...');
            try {
              const seed = await readFile(join(directory, 'package-lock.json'), 'utf8');
              const resolved = await resolveNpmLockfile({
                manifest: manifestChange.after,
                seed,
                before: date.trim(),
                image: options.image,
              });
              all.push({ path: 'package-lock.json', before: seed, after: resolved.lockfile });
            } catch (error) {
              refusal = `The AI changed dependency versions and npm could not re-resolve the lockfile: ${error instanceof Error ? error.message.slice(0, 300) : 'failed'}`;
            }
          } else if (lockfiles.length)
            refusal = `The AI changed dependency versions; Refit re-resolves only a single package-lock.json, and this repository commits ${lockfiles.join(', ')}.`;
        }
        return { patch: await renderPatch(all), refusal };
      },
      rescan: (patch) =>
        withPatched(patch, async (copy) => [
          ...openItems(
            await scanBundle(copy, {
              provider,
              language,
              parameterChanges: options.parameterChanges,
            }),
          ),
          ...(await savedModelSettings(copy, files, input.items)),
        ]),
      validate: async (patch) => {
        if (!checks.length)
          return {
            status: 'no-checks',
            command: ['none'],
            reason: 'The repository has no test, build or type check.',
          };
        // One line naming every check, for the gate's detail.
        const command = [checks.map((check) => check.command.join(' ')).join('; ')];
        // A patch validation refuses (one that changes no committed file, a failed preparation) fails
        // the checks gate; it must not end the fallback, whose answer and cost are already in hand.
        let validation: Awaited<ReturnType<typeof validateSourcePatch>>;
        try {
          validation = await validateSourcePatch({
            repository: directory,
            image: options.image,
            command: checks[0].command,
            checks,
            prepareDependencies: lockfiles.length > 0,
            propose: async () => patch,
            onProgress: options.onProgress,
          });
        } catch (error) {
          return {
            status: 'error',
            command,
            reason: `Validation refused the patch: ${error instanceof Error ? error.message.slice(0, 300) : 'failed'}`,
          };
        }
        const detail =
          'gate' in validation && validation.gate
            ? `${validation.gate.reason} ${gateNote(validation.gate).join(' ')}`
            : 'baseline' in validation
              ? `Baseline ${validation.baseline.status}, patched ${validation.patched.status}.`
              : '';
        return { status: validation.status, command, reason: detail.trim() };
      },
      prove: (calls, models) =>
        proveFallback({
          provider: provider as ProofProvider,
          language,
          calls,
          models,
          manifest: patchedManifest,
          environment,
        }),
    },
  });
  return { items, fallback, misses: missRecords({ ...row, provider }, items, sources, fallback) };
}

// The environment one proof runs with: a target model the patch writes is the model sent, so a
// model Refit's key cannot use stays unproven. With no target, an OpenAI call shape is sent with
// the fallback's own model (FALLBACK_MODEL) unless a proof model is set: no other model is used.
export function proofEnvironment(
  provider: ProofProvider,
  model: string | null,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const name = PROOF_MODEL_ENV[provider];
  if (model) return { ...environment, [name]: model };
  if (provider === 'openai' && !environment[name]?.trim())
    return { ...environment, [name]: FALLBACK_MODEL };
  return environment;
}

// Each written call shape once with the SDK release the patched manifest declares, and once per
// target model the patch writes (that model sent with the smallest request of each call).
async function proveFallback(options: {
  provider: ProofProvider;
  language: 'js' | 'py';
  calls: ProofCall[];
  models: string[];
  manifest: string;
  environment: NodeJS.ProcessEnv;
}): Promise<RequestProof> {
  const pending = (reason: string): RequestProof => ({ status: 'pending', reason, calls: [] });
  if (!(options.provider in PACKAGES)) return pending(`No request proof for ${options.provider}.`);
  if (options.language === 'py') return pending('Python call shapes have no Node SDK probe.');
  if (!options.environment[PROOF_KEYS[options.provider]]?.trim())
    return pending(`${PROOF_KEYS[options.provider]} is not set, so no request was sent.`);
  const packageName = PACKAGES[options.provider];
  // The release range the patched manifest declares.
  let manifest: Record<string, Record<string, string> | undefined> = {};
  try {
    manifest = JSON.parse(options.manifest);
  } catch {
    return pending('The patched package.json does not parse.');
  }
  const spec = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
  if (!spec || !/^[\w^~<>=.* |-]+$/.test(spec))
    return pending(`The patched package.json declares no registry range for ${packageName}.`);
  const sdkDirectory = await mkdtemp(join(tmpdir(), 'refit-fallback-sdk-'));
  try {
    await writeFile(join(sdkDirectory, 'package.json'), '{"private":true}');
    await execute(
      'npm',
      [
        'install',
        '--no-save',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `${packageName}@${spec}`,
      ],
      { cwd: sdkDirectory, timeout: 180_000 },
    );
    const calls = options.calls.length
      ? options.calls
      : [
          {
            call: {
              openai: 'responses.create',
              anthropic: 'messages.create',
              gemini: 'models.generateContent',
            }[options.provider],
          },
        ];
    const runs: RequestProof[] = [];
    for (const model of options.models.length ? options.models : [null])
      runs.push(
        await proveRequests({
          provider: options.provider,
          calls,
          sdkDirectory,
          env: proofEnvironment(options.provider, model, options.environment),
        }),
      );
    const all = runs.flatMap((run) => run.calls);
    const rejected = runs.find((run) => run.status === 'rejected');
    const open = runs.find((run) => run.status === 'pending');
    return {
      status: rejected ? 'rejected' : open ? 'pending' : 'accepted',
      reason:
        (rejected ?? open ?? runs[0]).reason +
        (options.models.length ? ` Models: ${options.models.join(', ')}.` : ''),
      calls: all,
    };
  } catch (error) {
    return pending(
      `The SDK could not be installed for the proof: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`,
    );
  } finally {
    await rm(sdkDirectory, { recursive: true, force: true });
  }
}
