// Serverless: the runtimes declared in serverless.yml, SAM or CloudFormation templates and Terraform are
// not on AWS Lambda's deprecated list, and the function's tests pass on the runtime they target.
import { createSandbox } from '../sandbox.ts';
import type { Sandbox } from '../types.ts';
import type { ProofCheck } from './types.ts';
import {
  execLog,
  lineOf,
  optString,
  proofDetail,
  readRoot,
  readText,
  walkFiles,
  withSandbox,
} from './util.ts';

// Source: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html ("Deprecated runtimes" and
// "Upcoming runtime deprecations"), as recorded on 2026-11-06. `deprecated` is the date AWS stops
// patching the runtime. The agent should confirm newer dates at the source; pass `deprecated` to add them.
export const LAMBDA_DEPRECATIONS: Record<string, string> = {
  nodejs: '2016-10-31',
  'nodejs4.3': '2020-03-05',
  'nodejs6.10': '2019-08-12',
  'nodejs8.10': '2020-03-06',
  'nodejs10.x': '2021-07-30',
  'nodejs12.x': '2023-03-31',
  'nodejs14.x': '2023-12-04',
  'nodejs16.x': '2024-06-12',
  'nodejs18.x': '2025-09-01',
  'nodejs20.x': '2026-04-30',
  'python2.7': '2021-07-15',
  'python3.6': '2022-07-18',
  'python3.7': '2023-12-04',
  'python3.8': '2024-10-14',
  'python3.9': '2025-12-15',
  'ruby2.5': '2021-07-30',
  'ruby2.7': '2023-12-07',
  'ruby3.2': '2026-03-31',
  java8: '2024-01-08',
  'go1.x': '2024-01-08',
  provided: '2024-01-08',
  'dotnetcore1.0': '2019-07-30',
  'dotnetcore2.0': '2019-05-30',
  'dotnetcore2.1': '2022-01-05',
  'dotnetcore3.1': '2023-04-03',
  dotnet6: '2024-12-20',
  dotnet7: '2024-05-14',
};

const RUNTIME_FAMILY = /^(nodejs|python|ruby|java|go|provided|dotnet)/;

export type DeclaredRuntime = { file: string; line: number; runtime: string; source: string };

export function findRuntimes(file: string, text: string): DeclaredRuntime[] {
  const out: DeclaredRuntime[] = [];
  const patterns: { re: RegExp; source: string }[] = /\.tf$/.test(file)
    ? [{ re: /^\s*runtime\s*=\s*"([^"]+)"/gm, source: 'terraform' }]
    : /serverless\.(ya?ml|json|ts|js)$/.test(file)
      ? [{ re: /^\s*["']?runtime["']?\s*:\s*["']?([\w.-]+)["']?/gm, source: 'serverless' }]
      : [{ re: /^\s*["']?Runtime["']?\s*:\s*["']?([\w.-]+)["']?/gm, source: 'sam/cloudformation' }];
  for (const { re, source } of patterns) {
    for (const match of text.matchAll(re)) {
      const runtime = match[1];
      if (!RUNTIME_FAMILY.test(runtime)) continue;
      out.push({ file, line: lineOf(text, match.index ?? 0), runtime, source });
    }
  }
  return out;
}

function candidate(file: string): boolean {
  return (
    /(^|\/)serverless\.(ya?ml|json|ts|js)$/.test(file) ||
    /\.tf$/.test(file) ||
    /(^|\/)(template|sam|samconfig|cloudformation|stack)[\w.-]*\.(ya?ml|json)$/i.test(file) ||
    /(^|\/)(cdk\.out|cloudformation)\/.*\.(ya?ml|json)$/.test(file)
  );
}

// nodejs22.x → ['node', '22']; python3.12 → ['python3', '3.12'].
function expectedBinary(runtime: string): { command: string; expect: string } | undefined {
  const node = /^nodejs(\d+)/.exec(runtime);
  if (node) return { command: 'node --version', expect: `v${node[1]}.` };
  const python = /^python(\d+\.\d+)/.exec(runtime);
  if (python) return { command: 'python3 --version', expect: `Python ${python[1]}.` };
  const ruby = /^ruby(\d+\.\d+)/.exec(runtime);
  if (ruby) return { command: 'ruby --version', expect: `ruby ${ruby[1]}.` };
  return undefined;
}

export const serverlessCheck: ProofCheck = {
  name: 'serverless',
  description:
    "Check that serverless function runtimes (serverless.yml, SAM/CloudFormation templates, Terraform) are not deprecated on AWS Lambda, and optionally run the function's tests in the sandbox on that runtime. Returns evidence, never blocks.",
  inputSchema: {
    type: 'object',
    properties: {
      testCommand: {
        type: 'string',
        description: 'The function\'s tests, e.g. "npm test". Run in the sandbox',
      },
      runtime: {
        type: 'string',
        description:
          'The runtime the tests should run on, e.g. "nodejs22.x". Default: the newest declared',
      },
      image: {
        type: 'string',
        description:
          'A Docker image with that runtime for the tests, e.g. "node:22-bookworm" or "public.ecr.aws/lambda/nodejs:22"',
      },
      asOf: {
        type: 'string',
        description: 'Judge deprecations as of this date (YYYY-MM-DD). Default: today',
      },
      deprecated: {
        type: 'object',
        description: 'Extra runtime → deprecation date entries the agent found at the source',
        additionalProperties: { type: 'string' },
      },
    },
  },
  run: async (input, ctx) => {
    const root = readRoot(ctx);
    const asOf = optString(input, 'asOf') ?? (ctx.now ?? new Date()).toISOString().slice(0, 10);
    const extra =
      input.deprecated && typeof input.deprecated === 'object'
        ? (input.deprecated as Record<string, unknown>)
        : {};
    const table: Record<string, string> = { ...LAMBDA_DEPRECATIONS };
    for (const [key, value] of Object.entries(extra))
      if (typeof value === 'string') table[key] = value;

    const declared: DeclaredRuntime[] = [];
    for (const file of (await walkFiles(root)).filter(candidate)) {
      const text = await readText(root, file);
      if (text) declared.push(...findRuntimes(file, text));
    }

    const passedItems: string[] = [];
    const failedItems: string[] = [];
    const notes: string[] = [];
    for (const d of declared) {
      const where = `${d.file}:${d.line} (${d.source}) runtime ${d.runtime}`;
      const date = table[d.runtime];
      if (date && date <= asOf)
        failedItems.push(`${where} was deprecated on AWS Lambda on ${date}`);
      else if (date) notes.push(`${where} will be deprecated on ${date}`);
      else passedItems.push(`${where} is not on the deprecation list as of ${asOf}`);
    }
    if (declared.length === 0)
      notes.push(
        'no serverless runtime declarations found; the agent can point at other files with paths it reads itself',
      );

    const testCommand = optString(input, 'testCommand');
    const commands: string[] = [];
    let logTail: string | undefined;
    let skipped: string | undefined;
    if (testCommand) {
      const runtime =
        optString(input, 'runtime') ??
        [...declared]
          .map((d) => d.runtime)
          .sort()
          .at(-1);
      const image = optString(input, 'image');
      const runTests = async (sandbox: Sandbox) => {
        const expected = runtime ? expectedBinary(runtime) : undefined;
        if (expected) {
          commands.push(expected.command);
          const version = await sandbox.exec(expected.command, { timeoutMs: 30_000 });
          const got = version.stdout.trim() || version.stderr.trim();
          if (got.startsWith(expected.expect))
            passedItems.push(`sandbox runtime ${got} matches ${runtime}`);
          else
            notes.push(
              `tests ran on ${got || 'an unknown runtime'}, not ${runtime}; pass an image with ${runtime}`,
            );
        }
        commands.push(testCommand);
        const result = await sandbox.exec(testCommand, { timeoutMs: 15 * 60 * 1000 });
        logTail = execLog(result);
        if (result.code === 0) passedItems.push(`tests passed: ${testCommand}`);
        else
          failedItems.push(
            `tests failed (exit ${result.code}${result.timedOut ? ', timed out' : ''}): ${testCommand}`,
          );
      };
      try {
        if (image) {
          const sandbox = await createSandbox(root, { mode: 'docker', image });
          try {
            await runTests(sandbox);
          } finally {
            await sandbox.dispose().catch(() => undefined);
          }
        } else {
          await withSandbox(ctx, runTests);
        }
      } catch (error) {
        skipped = `tests not run: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      notes.push('no testCommand given, so the function tests were not run');
    }
    // A skipped test run leaves the static findings standing; it only makes a clean result unknown.
    return proofDetail('serverless', {
      commands,
      passedItems,
      failedItems,
      notes: skipped ? [skipped, ...notes] : notes,
      logTail,
      ...(declared.length === 0 && !testCommand ? { passed: 'unknown' as const } : {}),
      ...(skipped && failedItems.length === 0 ? { passed: 'unknown' as const } : {}),
    });
  },
};
