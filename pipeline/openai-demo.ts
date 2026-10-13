import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runDeprecationPipeline } from './deprecated-models.ts';
import { digest } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

type CheckResult = {
  status: 'passed' | 'failed' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

async function containerCheck(directory: string, image: string, mode: 'live' | 'patched') {
  const name = `refit-openai-demo-${randomUUID()}`;
  try {
    const result = await execute(
      'docker',
      [
        'run',
        '--name',
        name,
        '--pull',
        'never',
        '--network',
        'none',
        '--read-only',
        '--user',
        '65534:65534',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '128',
        '--memory',
        '1g',
        '--cpus',
        '1',
        '--tmpfs',
        '/workspace:rw,exec,size=512m,uid=65534,gid=65534,mode=0700',
        '--tmpfs',
        '/tmp:rw,noexec,size=64m,mode=1777',
        '--mount',
        `type=bind,src=${directory},dst=/input,readonly`,
        '--workdir',
        '/workspace',
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        'cp -R /input/. /workspace/ && exec "$@"',
        'refit-check',
        'node',
        'harness/contract.mjs',
        '.',
        mode,
      ],
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
    );
    return { status: 'passed', exitCode: 0, ...result } satisfies CheckResult;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = error as Error & {
      code?: number | string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    return {
      status: exitCode !== null && !failure.killed && exitCode < 125 ? 'failed' : 'error',
      exitCode,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      error: failure.message,
    } satisfies CheckResult;
  } finally {
    try {
      await execute('docker', ['rm', '--force', name], {
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('stderr' in error) ||
        typeof error.stderr !== 'string' ||
        !error.stderr.includes('No such container')
      )
        throw error;
    }
  }
}

function reviewBody(report: OpenAiDemoReport) {
  const findingList = report.findings
    .map(
      (finding) =>
        `- \`${finding.location.file}:${finding.location.line}:${finding.location.column}\`: \`${finding.modelId}\` (${finding.confidence})`,
    )
    .join('\n');
  return `# Replace a retired OpenAI model ID

The deterministic proposal replaces the confirmed model literal with the replacement recorded in the pinned deprecation fixture.

## Validation

- Original code against the live contract: **${report.validation.baseline.status}**
- Patched code against the retired contract: **${report.validation.patched.status}**
- External container networking: **disabled**
- Remaining deprecation findings: **${report.patch.unresolvedFindings}**

Passing these checks does not prove behavioral compatibility. Replacement models can differ in behavior, capabilities, pricing, limits, and output. Review the patch and every unresolved finding before use.

## Findings

${findingList || '- No findings recorded.'}

This is a local review artifact. No branch was pushed and no pull request was published.
`;
}

type DeprecationReport = Awaited<ReturnType<typeof runDeprecationPipeline>>;
type ProposedDeprecationPatch = Exclude<DeprecationReport['patch'], { status: 'not-generated' }>;
type OpenAiDemoReport = Omit<DeprecationReport, 'patch'> & {
  kind: 'refit-openai-deprecation-validation';
  sdkVersion: string;
  patch: Omit<ProposedDeprecationPatch, 'validation'> & { validation: 'passed' | 'failed' };
  validation: {
    status: 'passed' | 'failed';
    revision: string;
    image: string;
    baselineCommand: string[];
    command: string[];
    baseline: CheckResult;
    patched: CheckResult;
    limits: { timeoutMs: number; outputBytes: number; network: 'none' };
  };
};

async function writeReviewBundle(directory: string, report: OpenAiDemoReport) {
  if (!('diff' in report.patch))
    throw new PipelineInputError('The OpenAI demo requires a deterministic patch.');
  const files: Record<string, string> = {
    'report.json': `${JSON.stringify(report, null, 2)}\n`,
    'migration.patch': report.patch.diff,
    'pull-request.md': reviewBody(report),
  };
  const manifest = {
    formatVersion: 1,
    kind: 'refit-review-bundle',
    runId: report.runId,
    revision: report.validation.revision,
    title: 'Replace a retired OpenAI model ID',
    validationStatus: report.validation.status,
    reviewRequired: true,
    published: false,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: digest(content),
      bytes: Buffer.byteLength(content),
    })),
  };
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(directory, name), content, { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

export async function runOpenAiDemo(options: { image: string; output: string }) {
  const processOptions = { timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES };
  const image = (
    await execute(
      'docker',
      ['image', 'inspect', '--format', '{{.Id}}', options.image],
      processOptions,
    )
  ).stdout.trim();
  if (!IMAGE_ID.test(image))
    throw new PipelineInputError('Docker did not resolve a unique immutable image ID.');

  const output = resolve(options.output);
  await mkdir(output, { mode: 0o700 });
  const root = await mkdtemp(join(tmpdir(), 'refit-openai-demo-'));
  try {
    const repository = join(root, 'repository');
    await cp(join(fixtures, 'openai-completions/repository'), repository, { recursive: true });
    await mkdir(join(repository, 'harness'));
    await cp(
      join(fixtures, 'openai-completions/contract.mjs'),
      join(repository, 'harness/contract.mjs'),
    );
    await cp(join(fixtures, 'provider-api'), join(repository, 'provider-api'), { recursive: true });
    const localOptions = { ...processOptions, cwd: repository };
    await execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], localOptions);
    const contract = (mode: 'live' | 'retired') =>
      execute(process.execPath, ['harness/contract.mjs', '.', mode], localOptions);
    const live = JSON.parse((await contract('live')).stdout);
    let retiredFailure: { exitCode: number; stderr: string };
    try {
      await contract('retired');
      throw new PipelineInputError('Expected the retired OpenAI model contract to fail.');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 1 ||
        !('stderr' in error) ||
        typeof error.stderr !== 'string' ||
        !error.stderr.includes('"status":404,"code":"model_not_found"')
      )
        throw error;
      retiredFailure = { exitCode: error.code, stderr: error.stderr };
    }
    await writeFile(
      join(output, 'contract-before-migration.json'),
      `${JSON.stringify({ live, retired: retiredFailure }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    const git = (argumentsList: string[], cwd = repository) =>
      execute('git', ['-c', 'core.hooksPath=/dev/null', ...argumentsList], {
        ...processOptions,
        cwd,
      });
    await git(['init']);
    await git(['add', '--force', '.']);
    await git([
      '-c',
      'user.name=Refit Demo',
      '-c',
      'user.email=demo@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'test: seed isolated OpenAI demo',
    ]);
    const revision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();

    const scan = await runDeprecationPipeline({
      repository,
      providerConfig: join(fixtures, 'openai/provider.json'),
      snapshot: join(fixtures, 'openai/deprecation-snapshot.json'),
      proposePatch: true,
    });
    if (!('diff' in scan.patch) || scan.patch.status !== 'proposed')
      throw new PipelineInputError('The OpenAI demo did not produce a deterministic patch.');

    const baseline = await containerCheck(repository, options.image, 'live');
    const candidate = join(root, 'candidate');
    await cp(repository, candidate, { recursive: true });
    const patchFile = join(root, 'migration.patch');
    await writeFile(patchFile, scan.patch.diff);
    await execute('git', ['apply', '--check', patchFile], { ...processOptions, cwd: candidate });
    await execute('git', ['apply', patchFile], { ...processOptions, cwd: candidate });
    const patched = await containerCheck(candidate, options.image, 'patched');
    const validationStatus =
      baseline.status === 'passed' && patched.status === 'passed' ? 'passed' : 'failed';
    const installed = JSON.parse(
      await readFile(join(repository, 'node_modules/openai/package.json'), 'utf8'),
    ) as { version: string };
    const report: OpenAiDemoReport = {
      ...scan,
      kind: 'refit-openai-deprecation-validation',
      sdkVersion: installed.version,
      patch: { ...scan.patch, validation: validationStatus },
      validation: {
        status: validationStatus,
        revision,
        image,
        baselineCommand: ['node', 'harness/contract.mjs', '.', 'live'],
        command: ['node', 'harness/contract.mjs', '.', 'patched'],
        baseline,
        patched,
        limits: { timeoutMs: PROCESS_TIMEOUT_MS, outputBytes: MAX_OUTPUT_BYTES, network: 'none' },
      },
    };
    const manifest = await writeReviewBundle(join(output, 'migration'), report);
    const summary = {
      kind: 'refit-openai-demo',
      sdkVersion: installed.version,
      api: 'simulated loopback HTTP server',
      originalLive: 'passed',
      originalRetired: 'failed as expected',
      scan: {
        status: scan.status,
        findings: scan.findings.length,
        confirmedFindings: scan.findings.filter((finding) => finding.confidence === 'confirmed')
          .length,
        needsReviewFindings: scan.findings.filter(
          (finding) => finding.confidence === 'needs-review',
        ).length,
        patchedLiterals: scan.patch.edits,
        unresolvedFindings: scan.patch.unresolvedFindings,
      },
      validation: {
        status: validationStatus,
        baseline: baseline.status,
        patched: patched.status,
        network: 'none',
      },
      migration: { manifest },
      published: false,
    };
    await writeFile(join(output, 'demo.json'), `${JSON.stringify(summary, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return summary;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
