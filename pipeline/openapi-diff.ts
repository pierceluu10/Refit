import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';
import type { Removal, Finding } from './types.ts';
import {
  isHandledOperationRemoval,
  type OperationReplacementEvidence,
} from './provider-operation-replacements.ts';

const execute = promisify(execFile);
const DIFF_TIMEOUT_MS = 30_000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const RESPONSE_REMOVALS = new Set([
  'response-required-property-removed',
  'response-optional-property-removed',
]);

function responseRemovalLocation(change: Record<string, unknown>, before: object) {
  if (
    !RESPONSE_REMOVALS.has(String(change.id)) ||
    typeof change.path !== 'string' ||
    typeof change.operation !== 'string' ||
    typeof change.text !== 'string'
  )
    return undefined;
  const match = change.text.match(
    /^removed the (?:required|optional) property `([^`]+)` from the response with the `([^`]+)` status$/,
  );
  if (!match || !isObject(before) || !isObject(before.paths)) return undefined;
  const path = before.paths[change.path];
  const operation = isObject(path) ? path[change.operation.toLowerCase()] : undefined;
  const responses = isObject(operation) ? operation.responses : undefined;
  const response = isObject(responses) ? responses[match[2]] : undefined;
  const content = isObject(response) ? response.content : undefined;
  if (!isObject(content) || !Object.keys(content).length) return undefined;
  const references = Object.values(content).map((media) =>
    isObject(media) && isObject(media.schema) ? media.schema.$ref : undefined,
  );
  const reference = references[0];
  if (
    typeof reference !== 'string' ||
    !references.every((value) => value === reference) ||
    !/^#\/components\/schemas\/[^/]+$/.test(reference)
  )
    return undefined;
  return {
    responseSchema: reference
      .slice('#/components/schemas/'.length)
      .replace(/~1/g, '/')
      .replace(/~0/g, '~'),
    removedProperty: match[1],
  };
}

export function unmappedBreakingChanges(
  diff: { engine: string; changes: unknown[] } | undefined,
  changes: Removal[],
  findings: Finding[],
  operationChanges: OperationReplacementEvidence[] = [],
) {
  if (!diff || diff.engine !== 'oasdiff') return [];
  const affected = changes.filter((change) =>
    findings.some(
      (finding) => finding.confidence === 'confirmed' && finding.changeId === change.id,
    ),
  );
  return diff.changes.filter(
    (entry) =>
      isObject(entry) &&
      Number(entry.level) >= 2 &&
      !isHandledOperationRemoval(entry, operationChanges) &&
      !(
        typeof entry.id === 'string' &&
        RESPONSE_REMOVALS.has(entry.id) &&
        affected.some(
          (change) =>
            entry.responseSchema === change.schema && entry.removedProperty === change.property,
        )
      ),
  );
}

export async function compareOpenApi(before: object, after: object) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-oasdiff-'));
  try {
    const base = join(directory, 'before.json');
    const revision = join(directory, 'after.json');
    await writeFile(base, JSON.stringify(before));
    await writeFile(revision, JSON.stringify(after));
    const version = (
      await execute('oasdiff', ['--version'], { timeout: DIFF_TIMEOUT_MS })
    ).stdout.trim();
    const { stdout } = await execute(
      'oasdiff',
      ['changelog', base, revision, '--format', 'json', '--allow-external-refs=false'],
      { timeout: DIFF_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES },
    );
    const changes: unknown = JSON.parse(stdout);
    if (
      !Array.isArray(changes) ||
      !changes.every(
        (change) =>
          isObject(change) &&
          typeof change.id === 'string' &&
          typeof change.text === 'string' &&
          [1, 2, 3].includes(Number(change.level)),
      )
    )
      throw new PipelineInputError('oasdiff returned an unsupported change report.');
    return {
      engine: 'oasdiff' as const,
      version,
      changes: (changes as Record<string, unknown>[]).map((change): Record<string, unknown> => ({
        ...change,
        ...responseRemovalLocation(change, before),
      })),
      coverage:
        'Breaking and non-breaking contract changes reported by oasdiff; levels 2 and 3 require breaking-change review. Documentation-only edits are not classified as code migrations. Mapping to application code remains bounded by the selected adapter and analyzer.',
    };
  } catch (cause) {
    if (cause instanceof PipelineInputError) throw cause;
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
      throw new PipelineInputError(
        'oasdiff is not installed or is not on PATH. Install it before running a full contract comparison.',
        { cause },
      );
    if (cause instanceof Error && 'killed' in cause && cause.killed)
      throw new PipelineInputError('oasdiff exceeded the contract comparison time limit.', {
        cause,
      });
    if (cause instanceof SyntaxError)
      throw new PipelineInputError('oasdiff returned invalid JSON.', { cause });
    throw new PipelineInputError(
      'oasdiff could not compare these contracts. Check their validity and external specification references.',
      { cause },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
