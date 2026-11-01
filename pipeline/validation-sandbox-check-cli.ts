// The sandbox judge's real check (refit-bench `mode: sandbox-check`): for each cloned repository of
// a benchmark list, the original tree is installed and checked once, then judged unchanged, after a
// trivial edit (a comment) and after a probe that adds one type error. Untrusted code runs only in
// the sandbox containers; run it on refit-bench, never on a developer machine.

import { execFile } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { checkoutDirectory } from '../scripts/ai-app-helpers.mjs';
import {
  disposeSandboxBaseline,
  sandboxBaseline,
  sandboxCheck,
  type SandboxCheckResult,
} from './validation-sandbox-check.ts';

const execute = promisify(execFile);
const { values } = parseArgs({
  options: { root: { type: 'string' }, list: { type: 'string' }, output: { type: 'string' } },
});
if (!values.root || !values.list || !values.output) {
  console.error(
    'Usage: validation-sandbox-check-cli --root <dir> --list <list.json> --output <file>',
  );
  process.exit(1);
}
const list = JSON.parse(await readFile(values.list, 'utf8')) as { repos: { repo: string }[] };

const summary = (result: SandboxCheckResult) => ({
  passed: result.passed,
  errors: result.errors.slice(0, 20),
  errorCount: result.errors.length,
  unproven: result.unproven,
  parts: result.parts.map((part) => ({
    kind: part.kind,
    command: part.command.join(' '),
    baseline: part.baseline,
    patched: part.patched,
    newFailures: part.newFailures.length,
    generators: part.generators?.map((generator) => `${generator.name}: ${generator.exitCode}`),
  })),
});

async function editedCopy(directory: string, edit: (copy: string, file: string) => Promise<void>) {
  const copy = await mkdtemp(join(tmpdir(), 'refit-sandbox-edit-'));
  await cp(directory, copy, { recursive: true });
  const { stdout } = await execute('git', ['-C', directory, 'ls-files']);
  const file = stdout
    .split('\n')
    .filter((path) => /\.[jt]sx?$/.test(path) && !/\.d\.ts$|(?:^|\/)node_modules\//.test(path))
    .sort((a, b) => Number(!/\.tsx?$/.test(a)) - Number(!/\.tsx?$/.test(b)))
    .sort((a, b) => Number(!/^app\//.test(a)) - Number(!/^app\//.test(b)))[0];
  if (file) await edit(copy, file);
  return { copy, file };
}

const rows = [];
for (const { repo } of list.repos) {
  const directory = checkoutDirectory(join(values.root, 'repos'), repo);
  const started = Date.now();
  try {
    const baseline = await sandboxBaseline({
      repository: directory,
      onProgress: (message) => console.error(`${repo}: ${message}`),
    });
    try {
      const unchanged = await sandboxCheck(directory, baseline);
      const trivial = await editedCopy(directory, (copy, file) =>
        appendFile(join(copy, file), '\n// Refit sandbox check: a trivial edit.\n'),
      );
      const trivialResult = await sandboxCheck(trivial.copy, baseline);
      const probe = await editedCopy(directory, async (copy, file) => {
        const path = join(copy, file);
        await writeFile(
          path,
          // TypeScript gets a type error; JavaScript, which tsc may not check, an unresolvable import.
          `${await readFile(path, 'utf8')}\n${/\.tsx?$/.test(file) ? "export const refitSandboxProbe: number = 'not a number';" : "import './refit-sandbox-probe-missing.js';"}\n`,
        );
      });
      const probeResult = await sandboxCheck(probe.copy, baseline);
      await Promise.all(
        [trivial, probe].map(({ copy }) => rm(copy, { recursive: true, force: true })),
      );
      rows.push({
        repo,
        seconds: Math.round((Date.now() - started) / 1000),
        install: baseline.install,
        baseline: baseline.parts.map((part) => ({
          kind: part.kind,
          command: part.command.join(' '),
          status: part.result.status,
          generators: part.result.generators?.map(
            (generator) => `${generator.name}: ${generator.exitCode}`,
          ),
        })),
        unchanged: summary(unchanged),
        trivialEdit: { file: trivial.file, ...summary(trivialResult) },
        typeErrorProbe: { file: probe.file, ...summary(probeResult) },
      });
    } finally {
      await disposeSandboxBaseline(baseline);
    }
  } catch (error) {
    rows.push({
      repo,
      outcome: 'infrastructure',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  console.error(JSON.stringify(rows.at(-1), null, 2));
}
await writeFile(values.output, `${JSON.stringify(rows, null, 2)}\n`);
