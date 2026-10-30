import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProviderAdapter } from './providers.ts';
import { componentReference, isObject, resolvableComponentSchema } from './specifications.ts';
import { isRemovedOperationChange } from './openapi-operations.ts';
import { PASSING_REACH, RESPONSE_REMOVALS } from './operation-reach.ts';
import { equivalentChange } from './schema-equivalence.ts';
import { PipelineInputError } from './types.ts';
import type { Removal, Finding, Location } from './types.ts';
import {
  isHandledOperationRemoval,
  type OperationReplacementEvidence,
} from './provider-operation-replacements.ts';
import {
  isHandledRequestRename,
  type RequestPropertyRenameEvidence,
} from './provider-request-renames.ts';

const execute = promisify(execFile);
const DIFF_TIMEOUT_MS = 30_000;
// Raw oasdiff output; real Stripe version pairs report ~100,000 entries (~85 MB) before filtering.
const MAX_DIFF_BYTES = 256 * 1024 * 1024;
const RESPONSE_ENUM_ADDITION = 'response-property-enum-value-added';

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

const SUBSCHEMA = /^anyOf\[subschema #(\d+)(?:: [^\]]*)?\]$/;
// The response property path and status in oasdiff 1.x texts. Other response changes name no
// property path and keep blocking.
const RESPONSE_PROPERTY_TEXTS: Record<string, RegExp> = {
  'response-required-property-removed':
    /^removed the required property `([^`]+)` from the response with the `([^`]+)` status$/,
  'response-optional-property-removed':
    /^removed the optional property `([^`]+)` from the response with the `([^`]+)` status$/,
  'response-property-any-of-added':
    /^added `[^`]+` to the `([^`]+)` response property `anyOf` list for the response status `([^`]+)`$/,
  'response-property-became-nullable':
    /^the response property `([^`]+)` became nullable for the status `([^`]+)`$/,
  'response-property-became-optional':
    /^the response property `([^`]+)` became optional for the status `([^`]+)`$/,
  'response-property-max-length-unset':
    /^the `([^`]+)` response property's maxLength was unset from `[^`]+` for the response status `([^`]+)`$/,
  'response-property-max-length-increased':
    /^the `([^`]+)` response property's maxLength was increased from `[^`]+` to `[^`]+` for the response status `([^`]+)`$/,
  'response-property-type-changed':
    /^the `([^`]+)` response's property `[^`]+` changed from `[^`]*` to `[^`]*` for status `([^`]+)`$/,
};

// Names the expandable fields whose expanded object a changed response property lies inside.
// Unexpanded responses return those fields as ID strings, so the property cannot appear unless a
// request expands every one of them. Unresolvable paths name nothing and keep blocking.
export function expansionLocation(change: Record<string, unknown>, before: object) {
  const text = RESPONSE_PROPERTY_TEXTS[String(change.id)];
  if (
    !text ||
    typeof change.path !== 'string' ||
    typeof change.operation !== 'string' ||
    typeof change.text !== 'string' ||
    !isObject(before) ||
    !isObject(before.paths)
  )
    return undefined;
  const match = change.text.match(text);
  const item = before.paths[change.path];
  const operation = isObject(item) ? item[change.operation.toLowerCase()] : undefined;
  const responses = isObject(operation) ? operation.responses : undefined;
  const response = match && isObject(responses) ? responses[match[2]] : undefined;
  const content = isObject(response) && isObject(response.content) ? response.content : {};
  const media = content['application/json'];
  const components = isObject(before.components) ? before.components : {};
  const schemas = isObject(components.schemas) ? components.schemas : {};
  const resolve = (value: unknown) => {
    const seen = new Set<string>();
    let current = value;
    while (isObject(current) && typeof current.$ref === 'string') {
      const name = componentReference(current.$ref);
      if (!name || seen.has(name)) return undefined;
      seen.add(name);
      current = schemas[name];
    }
    return isObject(current) ? current : undefined;
  };
  let node = resolve(isObject(media) ? media.schema : undefined);
  let property: string | undefined;
  const expansions: string[] = [];
  for (const segment of match ? match[1].split('/') : []) {
    if (!node) return undefined;
    const subschema = segment.match(SUBSCHEMA);
    if (subschema) {
      const member = Array.isArray(node.anyOf) ? node.anyOf[Number(subschema[1]) - 1] : undefined;
      if (!member) return undefined;
      if (isObject(node['x-expansionResources']) && isObject(member) && member.$ref && property)
        expansions.push(property);
      node = resolve(member);
    } else if (segment === 'items' && node.type === 'array') node = resolve(node.items);
    else {
      property = segment;
      node = resolve(isObject(node.properties) ? node.properties[segment] : undefined);
    }
  }
  return node && expansions.length ? { expansions } : undefined;
}

// A removed response property that is one of `changes`, which the scanner searches the code for.
export function isTrackedResponseRemoval(entry: unknown, changes: Removal[]) {
  return (
    isObject(entry) &&
    typeof entry.id === 'string' &&
    RESPONSE_REMOVALS.has(entry.id) &&
    changes.some(
      (change) =>
        entry.responseSchema === change.schema && entry.removedProperty === change.property,
    )
  );
}

export function unmappedBreakingChanges(
  diff: { engine: string; changes: unknown[] } | undefined,
  changes: Removal[],
  findings: Finding[],
  operationChanges: OperationReplacementEvidence[] = [],
  requestChanges: RequestPropertyRenameEvidence[] = [],
  expandedFields: string[] = ['*'],
) {
  if (!diff || diff.engine !== 'oasdiff') return [];
  const unreachable = (entry: Record<string, unknown>) =>
    !expandedFields.includes('*') &&
    Array.isArray(entry.expansions) &&
    entry.expansions.some((field) => !expandedFields.includes(field));
  const affected = changes.filter((change) =>
    findings.some(
      (finding) => finding.confidence === 'confirmed' && finding.changeId === change.id,
    ),
  );
  return diff.changes.filter(
    (entry) =>
      isObject(entry) &&
      Number(entry.level) >= 2 &&
      !unreachable(entry) &&
      // Traced code does not reach what changed, or a kept rule edit handles it (operation-reach.ts).
      !PASSING_REACH.has(entry.reach) &&
      !isHandledOperationRemoval(entry, operationChanges) &&
      !isHandledRequestRename(entry, requestChanges) &&
      !isTrackedResponseRemoval(entry, affected),
  );
}

// Stripe can add values to open response enums without a version change
// (https://docs.stripe.com/api/versioning#enums), so for Stripe they are listed as compatible and
// not breaking on their own; switchedEnumAdditions adds the ones the code switches over or compares
// (owner decision 6, 2026-10-24).
export async function compareOpenApi(
  before: object,
  after: object,
  // Rule generation diffs years-apart Stripe versions, which take longer than a run's pair.
  options: { openResponseEnums?: boolean; timeoutMs?: number } = {},
) {
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
      { timeout: options.timeoutMs ?? DIFF_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES },
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
    // Informational entries are dropped unless they locate a removed field or operation.
    const kept = (changes as Record<string, unknown>[]).filter(
      (change) =>
        Number(change.level) >= 2 ||
        RESPONSE_REMOVALS.has(String(change.id)) ||
        isRemovedOperationChange(change),
    );
    return {
      engine: 'oasdiff' as const,
      version,
      changes: kept.map((change): Record<string, unknown> => ({
        ...change,
        ...responseRemovalLocation(change, before),
        ...expansionLocation(change, before),
        // D4: a change whose schema accepts the same values in both contracts is compatible.
        ...equivalentChange(
          change,
          before as Record<string, unknown>,
          after as Record<string, unknown>,
        ),
        ...(options.openResponseEnums &&
          change.id === RESPONSE_ENUM_ADDITION && {
            reach: 'compatible',
            reachReason:
              'Stripe can add values to an open response enum without a version change (https://docs.stripe.com/api/versioning#enums). A new value blocks only where traced code switches over or compares the field.',
          }),
      })),
      coverage: `Breaking contract changes reported by oasdiff (levels 2 and 3, plus removed fields and operations); ${changes.length - kept.length} other entries are not listed.${options.openResponseEnums ? ' Stripe response enum additions are listed as compatible; they block only where traced code switches over or compares the field.' : ''} Subschema and format changes whose schema accepts the same values in both contracts are listed as compatible. Documentation-only edits are not classified as code migrations. Mapping to application code remains bounded by the selected adapter and analyzer.`,
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
    if (
      cause instanceof Error &&
      'code' in cause &&
      cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    )
      throw new PipelineInputError(
        `oasdiff reported more than ${MAX_DIFF_BYTES / 1024 / 1024} MiB of contract changes; the full comparison is too large to review automatically.`,
        { cause },
      );
    throw new PipelineInputError(
      'oasdiff could not compare these contracts. Check their validity and external specification references.',
      { cause },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

function schemaReferences(value: unknown) {
  const options = isObject(value) && Array.isArray(value.anyOf) ? value.anyOf : [value];
  return options
    .map((option) => (isObject(option) ? option.$ref : undefined))
    .filter((reference): reference is string => typeof reference === 'string');
}

// Restricts a contract to the operations an adapter maps (by operationId or returned schema) and
// every component they reference. Large provider contracts such as Stripe's (8–11 MB) otherwise
// exceed the comparison limit, and changes to endpoints the application never calls would block
// every migration.
export function adapterContract(document: Record<string, unknown>, provider: ProviderAdapter) {
  const operationIds = new Set(provider.operations.map((operation) => operation.operationId));
  const schemas = new Set(
    provider.operations.map((operation) => `#/components/schemas/${operation.schema}`),
  );
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, item] of Object.entries(isObject(document.paths) ? document.paths : {})) {
    if (!isObject(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method) || !isObject(operation)) continue;
      const responses = isObject(operation.responses) ? operation.responses : {};
      const ok = isObject(responses['200']) ? responses['200'] : undefined;
      const json = ok && isObject(ok.content) ? ok.content['application/json'] : undefined;
      const returned = isObject(json) ? schemaReferences(json.schema) : [];
      if (
        !operationIds.has(operation.operationId as string) &&
        !returned.some((reference) => schemas.has(reference))
      )
        continue;
      paths[path] ??= Object.fromEntries(
        Object.entries(item).filter(([key]) => !HTTP_METHODS.has(key)),
      );
      paths[path][method] = operation;
    }
  }
  const components = isObject(document.components) ? document.components : {};
  const kept: Record<string, Record<string, unknown>> = {};
  const pending = [paths as unknown];
  const seen = new Set<string>();
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (isObject(value))
      for (const [key, child] of Object.entries(value)) {
        const match =
          key === '$ref' && typeof child === 'string'
            ? /^#\/components\/([^/]+)\/([^/]+)$/.exec(child)
            : null;
        if (match && !seen.has(child as string)) {
          seen.add(child as string);
          const group = components[match[1]];
          const target = isObject(group) ? group[match[2]] : undefined;
          if (target !== undefined) {
            (kept[match[1]] ??= {})[match[2]] = target;
            pending.push(target);
          }
        } else pending.push(child);
      }
  }
  if (isObject(components.securitySchemes)) kept.securitySchemes = components.securitySchemes;
  return { ...document, paths, components: kept };
}

function enumValues(schemas: Record<string, unknown>, schema: string, property: string) {
  const owner = resolvableComponentSchema(schemas, schema);
  const definition = owner ? schemas[owner] : undefined;
  let value =
    isObject(definition) && isObject(definition.properties)
      ? definition.properties[property]
      : undefined;
  const seen = new Set<string>();
  const values = new Set<string>();
  const pending = [value];
  while (pending.length) {
    value = pending.pop();
    if (!isObject(value)) continue;
    const referenced = componentReference(value.$ref);
    if (referenced && !seen.has(referenced)) {
      seen.add(referenced);
      pending.push(schemas[referenced]);
    }
    for (const key of ['anyOf', 'oneOf'])
      if (Array.isArray(value[key])) pending.push(...(value[key] as unknown[]));
    if (Array.isArray(value.enum))
      for (const entry of value.enum) if (typeof entry === 'string') values.add(entry);
  }
  return values;
}

// New response enum values on fields the code switches over, checks exhaustively or compares with
// string literals.
export function switchedEnumAdditions(
  checks: (Location & { schema: string; property: string; compare?: true })[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return checks.flatMap((check) => {
    const old = enumValues(before, check.schema, check.property);
    if (!old.size) return [];
    const added = [...enumValues(after, check.schema, check.property)].filter(
      (value) => !old.has(value),
    );
    return added.length
      ? [
          {
            id: RESPONSE_ENUM_ADDITION,
            level: 3,
            text: `added ${added.map((value) => `\`${value}\``).join(', ')} to the \`${check.schema}.${check.property}\` enum, which ${check.file}:${check.line} ${check.compare ? 'compares with string literals' : 'checks exhaustively'}`,
            responseSchema: check.schema,
            property: check.property,
            values: added,
            usage: { file: check.file, line: check.line, column: check.column },
          },
        ]
      : [];
  });
}
