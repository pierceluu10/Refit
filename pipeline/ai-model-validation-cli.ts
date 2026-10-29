// Validates the model replacements an AI SDK benchmark run proposed (scripts/ai-model-benchmark.mjs)
// the way `refit serve --model-fixes` does: the repository's own checks before and after the patch,
// in offline Docker, with nothing published. A repository is checked with `npm test` when it has a
// real test script, otherwise `npm run build`; one with neither has no runnable checks.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { repositoryChecks } from './check-gate.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';
import { runModelFixes } from './model-fixes.ts';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const { values } = parseArgs({
  options: {
    results: { type: 'string' },
    root: { type: 'string' },
    image: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.results || !values.root || !values.image || !values.output) {
  console.log(
    'Usage: tsx pipeline/ai-model-validation-cli.ts --results <benchmark-results.json> --root <dir> --image <docker image> --output <validation.json>',
  );
  process.exit(values.help ? 0 : 1);
}
const benchmark = JSON.parse(await readFile(values.results, 'utf8'));
const now = new Date();
const registry = await loadDeadlineRegistry(undefined, now);

async function checks(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  // The tests, build and type check as separate checks, decided by the shared gate.
  const separate = repositoryChecks(directory, manifest);
  return {
    command: separate[0]?.command,
    checks: separate,
    prepareDependencies: LOCKFILES.some((name) => existsSync(join(directory, name))),
  };
}

const validated = [];
for (const entry of benchmark.results.filter(
  (item: { replacements?: unknown[] }) => item.replacements?.length,
)) {
  const directory = join(values.root, entry.repo.replace('/', '__'));
  console.error(`${entry.repo}`);
  const { command, checks: separate, prepareDependencies } = await checks(directory);
  if (!command) {
    validated.push({
      repo: entry.repo,
      status: 'no-checks',
      reason: 'No test or build script, or type check.',
    });
    continue;
  }
  try {
    const result = await runModelFixes({
      repository: directory,
      registry,
      now,
      checks: { image: values.image, command, checks: separate, prepareDependencies },
      onProgress: (message) => console.error(`  ${message}`),
    });
    validated.push({
      repo: entry.repo,
      command,
      prepareDependencies,
      status: result.status,
      reason: result.reason,
      replacements: result.replacements.length,
    });
  } catch (error) {
    validated.push({
      repo: entry.repo,
      command,
      prepareDependencies,
      status: 'error',
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}
await writeFile(
  values.output,
  `${JSON.stringify({ formatVersion: 1, results: values.results, image: values.image, checkedAt: now.toISOString(), validated }, null, 2)}\n`,
);
console.error(
  JSON.stringify(
    validated.reduce<Record<string, number>>((counts, item) => {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      return counts;
    }, {}),
  ),
);
