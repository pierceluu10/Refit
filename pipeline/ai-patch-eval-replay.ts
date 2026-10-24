import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { applyPatch, diffLines, parsePatch } from 'diff';
import {
  addedItemChoices,
  addedTypeEscapes,
  changedEventTypes,
  droppedRequestPaths,
  newShapeOnlyReads,
} from './ai-patch-policies.ts';
import { analyzeRepository } from './analyzer.ts';
import { readProviderAdapter, type ProviderAdapter } from './providers.ts';
import { readRepository } from './repository.ts';
import { runPipeline } from './run.ts';
import { readSpecification } from './specifications.ts';
import { repositoryAdapter, stripeOperations } from './stripe-benchmark.ts';
import { findFieldSubstitutions, findUnsafeReplacements } from './substitution-guard.ts';
import { PipelineInputError, type Removal, type Repository, type SourceEdit } from './types.ts';

// Replays recorded patches, such as the October 21 coding-agent diffs, through the AI patch guards
// the way proposeAiPatch() runs them: on the code with Refit's deterministic edits applied, for the
// files the recorded patch changed. No model is called and no repository code runs.

const USAGE =
  'Usage: npx tsx pipeline/ai-patch-eval-replay.ts --results <agent-comparison results.json> --root <benchmark root> --output <file.json>';

const diffPath = (name: string | undefined) =>
  name && name !== '/dev/null' ? name.replace(/^"|"$/g, '').replace(/^[ab]\//, '') : undefined;

const contentOf = (repository: Repository, path: string) =>
  repository.files.find((file) => file.path === path)?.content;

// Applies a unified diff to `repository`. A hunk that does not apply there, because the rules
// already changed its lines, is applied to `fallback` (the original code) instead and listed.
// Existing files outside the scanned sources, such as package.json or docs, are listed and left
// alone: no guard reads them.
export function withDiff(repository: Repository, diff: string, fallback = repository) {
  const files = new Map(repository.files.map((file) => [file.path, file]));
  const fromFallback: string[] = [];
  const unscanned: string[] = [];
  for (const patch of parsePatch(diff)) {
    const path = diffPath(patch.newFileName);
    const removed = diffPath(patch.oldFileName);
    if (!path) {
      if (removed) files.delete(removed);
      continue;
    }
    if (removed && !files.has(path) && contentOf(fallback, path) === undefined) {
      unscanned.push(path);
      continue;
    }
    let content = applyPatch(files.get(path)?.content ?? '', patch);
    if (content === false && fallback !== repository) {
      content = applyPatch(contentOf(fallback, path) ?? '', patch);
      fromFallback.push(path);
    }
    if (content === false)
      throw new PipelineInputError(`The recorded diff does not apply to ${path}.`);
    files.set(path, { ...files.get(path), path, content });
  }
  return { repository: { ...repository, files: [...files.values()] }, fromFallback, unscanned };
}

// Line-level edits that turn `before` into `after`, in `before`'s offsets.
export function lineEdits(file: string, before: string, after: string): SourceEdit[] {
  const edits: SourceEdit[] = [];
  let offset = 0;
  for (const part of diffLines(before, after)) {
    const previous = edits.at(-1);
    const adjacent = previous?.end === offset;
    if (part.added) {
      if (adjacent) previous.replacement += part.value;
      else
        edits.push({
          file,
          start: offset,
          end: offset,
          replacement: part.value,
          changeId: 'replay',
        });
    } else {
      if (part.removed) {
        if (adjacent) previous.end += part.value.length;
        else
          edits.push({
            file,
            start: offset,
            end: offset + part.value.length,
            replacement: '',
            changeId: 'replay',
          });
      }
      offset += part.value.length;
    }
  }
  return edits;
}

// What each guard in proposeAiPatch() reports for the change from `base` to `modified`.
export function guardRefusals(
  base: Repository,
  modified: Repository,
  changes: Removal[],
  provider: ProviderAdapter,
  schemas: Record<string, unknown>,
  afterSchemas: Record<string, unknown>,
) {
  const files = new Set(
    modified.files
      .filter((file) => contentOf(base, file.path) !== file.content)
      .map((file) => file.path),
  );
  const findings = analyzeRepository(base, changes, provider, schemas).findings;
  const edits = [...files].flatMap((path) =>
    lineEdits(path, contentOf(base, path) ?? '', contentOf(modified, path)!),
  );
  return {
    files: [...files],
    refusals: {
      changedEventTypes: changedEventTypes(base, modified, files),
      addedItemChoices: addedItemChoices(base, modified, files),
      droppedRequestPaths: droppedRequestPaths(base, modified, files, provider),
      addedTypeEscapes: addedTypeEscapes(base, modified, files),
      newShapeOnlyReads: newShapeOnlyReads(base, edits, findings, changes),
      substitutions: [
        ...findFieldSubstitutions(base, modified, changes, provider, schemas, files),
        ...findUnsafeReplacements(
          base,
          modified,
          changes,
          provider,
          schemas,
          afterSchemas,
          files,
          [],
        ),
      ],
    },
  };
}

const refusedBy = (result: ReturnType<typeof guardRefusals>) =>
  Object.entries(result.refusals)
    .filter(([, list]) => list.length)
    .map(([guard]) => guard);

interface Entry {
  repo: string;
  before: string;
}

async function replay(
  root: string,
  entry: Entry,
  diff: string,
  after: string,
  sdkSpec: Record<string, unknown>,
) {
  const directory = join(root, 'repos', entry.repo.replace('/', '__'));
  const before = join(root, 'specs', `${entry.before}.json`);
  const original = await readRepository(directory);
  const beforeSpec = JSON.parse(await readFile(before, 'utf8'));
  const { adapter } = repositoryAdapter(original, stripeOperations(sdkSpec, beforeSpec));
  const work = await mkdtemp(join(tmpdir(), 'refit-replay-'));
  try {
    const adapterPath = join(work, 'adapter.json');
    await writeFile(adapterPath, JSON.stringify(adapter));
    const afterPath = join(root, 'specs', `${after}.json`);
    const report = await runPipeline({
      repository: directory,
      before,
      after: afterPath,
      apiVersion: entry.before,
      providerConfig: adapterPath,
      proposePatch: true,
    });
    const rules =
      'diff' in report.patch && report.patch.diff
        ? withDiff(original, report.patch.diff).repository
        : original;
    const onRules = withDiff(rules, diff, original);
    const provider = await readProviderAdapter(adapterPath);
    const schemas = (await readSpecification(before)).schemas;
    const afterSchemas = (await readSpecification(afterPath)).schemas;
    const guard = (base: Repository, modified: Repository) =>
      guardRefusals(base, modified, report.changes, provider, schemas, afterSchemas);
    // As proposeAiPatch() runs the guards, and against the original code, which charges the
    // recorded patch with every change it made itself.
    const againstRules = guard(rules, onRules.repository);
    const againstOriginal = guard(original, withDiff(original, diff).repository);
    return {
      rulePatch: report.patch.status,
      fromFallback: onRules.fromFallback,
      unscanned: onRules.unscanned,
      againstRules: { refusedBy: refusedBy(againstRules), ...againstRules },
      againstOriginal: { refusedBy: refusedBy(againstOriginal), ...againstOriginal },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      results: { type: 'string' },
      root: { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (!values.results || !values.root || !values.output) throw new PipelineInputError(USAGE);
  const results = JSON.parse(await readFile(values.results, 'utf8')) as {
    repos: {
      repo: string;
      agent: { diff?: string };
      validation?: { status: string } | null;
      review?: { verdict: string };
    }[];
  };
  const selected = JSON.parse(
    await readFile(join(values.root, 'selected.json'), 'utf8'),
  ) as Entry[];
  const versions = JSON.parse(await readFile(join(values.root, 'needed-specs.json'), 'utf8')) as {
    version: string;
  }[];
  const after = versions
    .map((spec) => spec.version)
    .sort()
    .at(-1)!;
  const sdkSpec = JSON.parse(
    await readFile(join(values.root, 'specs', `sdk-${after}.json`), 'utf8'),
  );
  const rows = [];
  for (const row of results.repos.filter((candidate) => candidate.agent.diff)) {
    const entry = selected.find((candidate) => candidate.repo === row.repo);
    const base = {
      repo: row.repo,
      validation: row.validation?.status ?? null,
      verdict: row.review?.verdict ?? null,
    };
    if (!entry || !existsSync(join(values.root, 'repos', row.repo.replace('/', '__')))) {
      rows.push({ ...base, error: 'Not in the benchmark root.' });
      continue;
    }
    try {
      const result = await replay(values.root, entry, row.agent.diff!, after, sdkSpec);
      rows.push({ ...base, ...result });
      const listed = (guards: string[]) => guards.join(', ') || 'passes every guard';
      console.error(
        `${row.repo} (${base.validation}, ${base.verdict}): on the rules' code ${listed(result.againstRules.refusedBy)}; on the original ${listed(result.againstOriginal.refusedBy)}`,
      );
    } catch (error) {
      if (!(error instanceof PipelineInputError)) throw error;
      rows.push({ ...base, error: error.message });
      console.error(`${row.repo}: ${error.message}`);
    }
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(
    values.output,
    `${JSON.stringify({ formatVersion: 1, source: values.results, commit, after, rows }, null, 2)}\n`,
  );
}
