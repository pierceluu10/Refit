import {
  getNamedType,
  GraphQLError,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isNonNullType,
  NoUnusedFragmentsRule,
  parse,
  specifiedRules,
  TypeInfo,
  typeFromAST,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type GraphQLNamedType,
  type GraphQLSchema,
} from 'graphql';
import type { AiOptions } from './ai-budget.ts';
import type { EvidenceGrade } from './check-selection.ts';
import { reviewShopifyPatch, writeShopifyLiveCases } from './shopify-ai.ts';
import {
  documentLocation,
  scanShopify,
  type AdminDocument,
  type ShopifyScan,
} from './shopify-analysis.ts';
import {
  liveShopifyProof,
  needsCase,
  shopifyAccessToken,
  shopifyTestStore,
  type ShopifyLiveProof,
} from './shopify-live-proof.ts';
import type { Repository } from './types.ts';

// Offline proof for Shopify patches (docs/SHOPIFY-PROOF.md). Shopify versions its Admin GraphQL
// schema per release, so every document the code sends can be validated against the exact schema of
// the version it will run on: the original documents against the original version, the patched
// documents against the target. Validation alone does not see a selected field that changes type or
// a variable whose input type gains a required field, so those count as unproven too.

const RULES = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);
const MAX_TEXT = 300;
const CODEGEN_CONFIG = /(?:^|\/)(?:\.graphqlrc\.[cm]?[jt]s|codegen\.[cm]?[jt]s|codegen\.ya?ml)$/;
const CODEGEN_PACKAGE = /@shopify\/api-codegen-preset|@graphql-codegen\//;

export interface ShopifyVersionedSchema {
  version: string;
  schema: GraphQLSchema;
}

export interface ShopifyProofFailure {
  file: string;
  line: number;
  version: string;
  text: string;
}

export interface ShopifySchemaProof {
  status: 'proven' | 'failed' | 'unproven';
  reason: string;
  checked: { original: number; patched: number };
  failures: ShopifyProofFailure[];
  // Documents that already fail on the original version; the patch is judged on the target only.
  originalFailures: ShopifyProofFailure[];
  // #graphql literals no Admin call reaches that fail on both versions (another Shopify API).
  otherApi: string[];
  codegen?: { files: string[]; current: boolean; reason: string };
}

interface DocumentCheck {
  errors: { text: string; file: string; line: number }[];
  // Selected output fields whose enum values or possible types differ: harmless to the GraphQL
  // request, but generated types widen.
  widened: string[];
  unreadable?: string;
}

const text = (message: string) => message.replace(/ Did you mean .*$/, '').slice(0, MAX_TEXT);

function errorAt(document: AdminDocument, error: GraphQLError) {
  const position = error.locations?.[0];
  if (!position) return { file: document.file, line: document.line };
  const lines = document.text.split('\n');
  const offset =
    lines.slice(0, position.line - 1).reduce((sum, entry) => sum + entry.length + 1, 0) +
    position.column -
    1;
  const where = documentLocation(document, offset);
  return { file: where.file, line: where.line };
}

const names = (type: GraphQLNamedType) =>
  isEnumType(type)
    ? type
        .getValues()
        .map((value) => value.name)
        .sort()
    : isAbstractType(type)
      ? []
      : undefined;

// Breaking differences in an input type a variable carries, followed through nested input objects:
// removed or retyped fields, new required fields without a default and removed enum values.
function inputChanges(
  name: string,
  before: GraphQLSchema,
  after: GraphQLSchema,
  seen = new Set<string>(),
): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const was = before.getType(name);
  const now = after.getType(name);
  if (!was) return [];
  if (!now) return [`input type ${name} was removed`];
  if (isEnumType(was) && isEnumType(now)) {
    const kept = new Set(now.getValues().map((value) => value.name));
    return was
      .getValues()
      .filter((value) => !kept.has(value.name))
      .map((value) => `${name}.${value.name} was removed`);
  }
  if (!isInputObjectType(was) || !isInputObjectType(now)) return [];
  const [old, current] = [was.getFields(), now.getFields()];
  const changes: string[] = [];
  for (const [field, definition] of Object.entries(old)) {
    const target = current[field];
    if (!target) changes.push(`${name}.${field} was removed`);
    // A required input that becomes optional accepts everything it accepted before.
    else if (
      String(definition.type) !== String(target.type) &&
      String(definition.type) !== `${target.type}!`
    )
      changes.push(`${name}.${field} changes from ${definition.type} to ${target.type}`);
    else if (
      definition.defaultValue !== undefined &&
      target.defaultValue === undefined &&
      isNonNullType(target.type)
    )
      changes.push(`${name}.${field} loses its default and is required`);
    else changes.push(...inputChanges(getNamedType(target.type).name, before, after, seen));
  }
  for (const [field, definition] of Object.entries(current))
    if (!old[field] && isNonNullType(definition.type) && definition.defaultValue === undefined)
      changes.push(`${name}.${field} is a new required field`);
  return changes;
}

function checkDocument(
  document: AdminDocument,
  schema: GraphQLSchema,
  original?: GraphQLSchema,
): DocumentCheck {
  let ast: DocumentNode;
  try {
    ast = parse(document.text);
  } catch (error) {
    if (!(error instanceof GraphQLError)) throw error;
    return {
      errors: [{ ...errorAt(document, error), text: `does not parse: ${text(error.message)}` }],
      widened: [],
    };
  }
  const errors = validate(schema, ast, RULES);
  if (errors.some((error) => error.message.startsWith('Unknown fragment "')))
    return { errors: [], widened: [], unreadable: 'it spreads a fragment Refit could not inline' };
  if (errors.length || !original)
    return {
      errors: errors.map((error) => ({ ...errorAt(document, error), text: text(error.message) })),
      widened: [],
    };
  const changes: string[] = [];
  const widened: string[] = [];
  const info = new TypeInfo(schema);
  visit(
    ast,
    visitWithTypeInfo(info, {
      Field(node) {
        const parent = info.getParentType();
        const field = info.getFieldDef();
        if (!parent || !field || node.name.value.startsWith('__')) return;
        const previous = original.getType(parent.name);
        const was =
          previous && 'getFields' in previous ? previous.getFields()[node.name.value] : undefined;
        if (!was) return;
        const [from, to] = [String(was.type), String(field.type)];
        // A nullable output that becomes non-null only removes a case the code already handles.
        if (from !== to && `${from}!` !== to)
          changes.push(`${parent.name}.${node.name.value} changes from ${from} to ${to}`);
        const [oldNamed, newNamed] = [getNamedType(was.type), getNamedType(field.type)];
        const members = (type: GraphQLNamedType, schema: GraphQLSchema) =>
          isAbstractType(type)
            ? schema
                .getPossibleTypes(type)
                .map((entry) => entry.name)
                .sort()
            : names(type);
        if (
          JSON.stringify(members(oldNamed, original)) !== JSON.stringify(members(newNamed, schema))
        )
          widened.push(`${parent.name}.${node.name.value} (${newNamed.name})`);
      },
      VariableDefinition(node) {
        const type = typeFromAST(schema, node.type);
        if (type) changes.push(...inputChanges(getNamedType(type).name, original, schema));
      },
    }),
  );
  return {
    errors: [...new Set(changes)].map((change) => ({
      file: document.file,
      line: document.line,
      text: change,
    })),
    widened: [...new Set(widened)],
  };
}

// One document's proof on its own, as the patch proof judges it: the errors it gets on the target
// schema, then every selected field or variable input type that changes from the original version.
// Undefined when the document spreads a fragment it does not define.
export function documentProof(text: string, after: GraphQLSchema, before: GraphQLSchema) {
  const document: AdminDocument = {
    file: '',
    line: 1,
    column: 1,
    text,
    segments: [
      { documentStart: 0, documentEnd: text.length, file: '', sourceStart: 0, sourceText: text },
    ],
    traced: true,
  };
  const result = checkDocument(document, after, before);
  return result.unreadable ? undefined : result.errors.map((error) => error.text);
}

// Shopify's codegen preset (and graphql-codegen) write result types for the version they were
// generated against. They are current for the target when no selected field, variable input type,
// enum or union the documents use differs between the versions; otherwise the type check ran
// against stale types and proves nothing about the target.
function codegenEvidence(repository: Repository, widened: string[]) {
  const files = [...repository.files, ...(repository.configurations ?? [])]
    .filter((file) => CODEGEN_CONFIG.test(file.path) && CODEGEN_PACKAGE.test(file.content))
    .map((file) => file.path);
  if (!files.length) return undefined;
  return widened.length
    ? {
        files,
        current: false,
        reason: `The repository generates GraphQL types (${files.join(', ')}), and the target widens ${widened.slice(0, 3).join(', ')}${widened.length > 3 ? ` and ${widened.length - 3} more` : ''}; Refit cannot regenerate them offline, so the type check ran against types for the original version.`,
      }
    : {
        files,
        current: true,
        reason: `The repository generates GraphQL types (${files.join(', ')}); no field, input type, enum or union its documents use differs between the versions, so the committed types match the target.`,
      };
}

export function shopifySchemaProof(options: {
  original: Repository;
  patched: Repository;
  before: ShopifyVersionedSchema;
  after: ShopifyVersionedSchema;
  scans?: { original: ShopifyScan; patched: ShopifyScan };
}): ShopifySchemaProof {
  const original = options.scans?.original ?? scanShopify(options.original);
  const patched = options.scans?.patched ?? scanShopify(options.patched);
  const originalFailures: ShopifyProofFailure[] = [];
  const failures: ShopifyProofFailure[] = [];
  // Storefront clients keep their own version and contract; the Admin proof leaves them out.
  const unreadable: string[] = patched.unreadable
    .filter((entry) => !entry.api)
    .map((entry) => `${entry.file}:${entry.line} (${entry.reason})`);
  const otherApi: string[] = [];
  const widened: string[] = [];
  let checkedOriginal = 0;
  for (const document of original.documents) {
    if (document.api) continue;
    const result = checkDocument(document, options.before.schema);
    if (result.unreadable) continue;
    checkedOriginal++;
    for (const error of result.errors)
      originalFailures.push({ ...error, version: options.before.version });
  }
  const originalTexts = new Set(original.documents.map((document) => document.text));
  let checkedPatched = 0;
  for (const document of patched.documents) {
    if (document.api) continue;
    const result = checkDocument(document, options.after.schema, options.before.schema);
    if (result.unreadable) {
      unreadable.push(`${document.file}:${document.line} (${result.unreadable})`);
      continue;
    }
    // Mirrors the scan: an unchanged untraced literal invalid on both versions targets another
    // Shopify API. One the patch changed is judged like any other document.
    if (
      !document.traced &&
      originalTexts.has(document.text) &&
      result.errors.length &&
      checkDocument(document, options.before.schema).errors.length
    ) {
      otherApi.push(`${document.file}:${document.line}`);
      continue;
    }
    checkedPatched++;
    widened.push(...result.widened);
    for (const error of result.errors) failures.push({ ...error, version: options.after.version });
  }
  const codegen = codegenEvidence(options.patched, [...new Set(widened)]);
  const checked = { original: checkedOriginal, patched: checkedPatched };
  const base = { checked, failures, originalFailures, otherApi, ...(codegen ? { codegen } : {}) };
  if (failures.length)
    return {
      ...base,
      status: 'failed',
      reason: `${failures.length === 1 ? 'A Shopify GraphQL document does' : `${failures.length} Shopify GraphQL document errors do`} not hold on Admin API ${options.after.version}, first ${failures[0].file}:${failures[0].line}: ${failures[0].text}.`,
    };
  if (unreadable.length)
    return {
      ...base,
      status: 'unproven',
      reason: `Refit could not read ${unreadable.length === 1 ? 'a GraphQL document' : `${unreadable.length} GraphQL documents`} the code sends, first ${unreadable[0]}, so it cannot prove ${unreadable.length === 1 ? 'it works' : 'they work'} on Admin API ${options.after.version}.`,
    };
  if (!checkedPatched)
    return {
      ...base,
      status: 'unproven',
      reason: `Refit found no Admin GraphQL document to validate against Admin API ${options.after.version}.`,
    };
  if (codegen && !codegen.current) return { ...base, status: 'unproven', reason: codegen.reason };
  return {
    ...base,
    status: 'proven',
    reason: `Every traced Shopify GraphQL document (${checkedPatched}) validates against the Admin API ${options.after.version} schema with graphql-js, and no selected field or variable input type changes between ${options.before.version} and ${options.after.version}.${codegen ? ` ${codegen.reason}` : ''}`,
  };
}

// Proof levels A–D for a Shopify patch (docs/PROOF-BASED-VALIDATION.md): without schema proof the
// patch is grade D whatever its checks did; with it, a live run on the dev store gives A, and the
// repository's own tests or type check keep their B or C. Nothing else raises the grade.
export function shopifyGrade(
  own: EvidenceGrade | undefined,
  schema: ShopifySchemaProof,
  live?: { status: string; reason: string },
): EvidenceGrade {
  if (schema.status !== 'proven')
    return {
      letter: 'D',
      level: 'none',
      reason: `${schema.reason}${own && own.letter !== 'D' ? ` The checks alone (${own.letter}) prove nothing about the documents.` : ''}`,
    };
  if (live?.status === 'failed')
    return {
      letter: 'D',
      level: 'none',
      reason: `The development store run failed: ${live.reason}`,
    };
  if (live?.status === 'passed')
    return { letter: 'A', level: 'behaviour-tests', reason: `${live.reason} ${schema.reason}` };
  if (own && (own.letter === 'B' || own.letter === 'C'))
    return { ...own, reason: `${schema.reason} ${own.reason}` };
  return {
    letter: 'D',
    level: 'none',
    reason: `${schema.reason} Grade C also needs a passing type check over the changed files: ${own?.reason ?? 'no check passed.'}`,
  };
}

const documentId = (document: AdminDocument) => `${document.file}:${document.line}`;

// Every proof Refit has for a Shopify patch, and the grade it earns: the offline schema proof, the
// live run on the development store when SHOPIFY_TEST_STORE and SHOPIFY_TEST_TOKEN are set (with AI
// inputs for operations that need them), and the AI second opinion, which is advisory.
export async function shopifyProof(options: {
  original: Repository;
  patched: Repository;
  before: ShopifyVersionedSchema;
  after: ShopifyVersionedSchema;
  // The repository's own checks' grade (gradeEvidence).
  own: EvidenceGrade | undefined;
  // The patch broke a check that passed on the original code: never graded A, as for Stripe.
  regression?: boolean;
  diff: string;
  summary: string;
  warnings: readonly string[];
  ai?: AiOptions;
  environment: Record<string, string | undefined>;
  fetch?: typeof fetch;
}) {
  const scans = { original: scanShopify(options.original), patched: scanShopify(options.patched) };
  const schema = shopifySchemaProof({ ...options, scans });
  const versions = { before: options.before.version, after: options.after.version };
  const store = shopifyTestStore(options.environment);
  let live: ShopifyLiveProof | undefined;
  let liveCases: Awaited<ReturnType<typeof writeShopifyLiveCases>>['record'] | undefined;
  if (store && 'refused' in store)
    live = { status: 'not-run', reason: store.refused, operations: [], created: [] };
  else if (store && options.regression)
    live = {
      status: 'not-run',
      reason:
        'The patch broke a check that passed on the original code, so nothing is sent to the store.',
      operations: [],
      created: [],
    };
  else if (store && schema.status !== 'proven')
    live = {
      status: 'not-run',
      reason: 'Live proof runs only once the schema proof holds.',
      operations: [],
      created: [],
    };
  else if (store) {
    const resolved = await shopifyAccessToken(store, options.fetch);
    if ('refused' in resolved)
      return finish({ status: 'not-run', reason: resolved.refused, operations: [], created: [] });
    const skipped = new Set(schema.otherApi);
    const documents = scans.patched.documents
      .filter((document) => !skipped.has(documentId(document)))
      .map((document) => {
        // The original document at the same position in the same file, for the original version.
        const inFile = (scan: ShopifyScan) =>
          scan.documents.filter((entry) => entry.file === document.file);
        const original = inFile(scans.original)[inFile(scans.patched).indexOf(document)];
        return {
          id: documentId(document),
          original: original?.text ?? null,
          patched: document.text,
        };
      });
    const needsInput = documents.filter((document) => needsCase(document.patched));
    const written =
      options.ai && needsInput.length
        ? await writeShopifyLiveCases({
            ai: options.ai,
            documents: needsInput.map((document) => ({ id: document.id, text: document.patched })),
            schemas: [options.before.schema, options.after.schema],
          })
        : undefined;
    liveCases = written?.record;
    live = await liveShopifyProof({
      store: resolved,
      versions,
      documents,
      cases: written?.cases,
      fetch: options.fetch,
    });
  }
  return finish(live);

  async function finish(live: ShopifyLiveProof | undefined) {
    const review = options.ai
      ? await reviewShopifyPatch({
          ai: options.ai,
          diff: options.diff,
          summary: options.summary,
          versions,
          schemaProof: schema,
          warnings: options.warnings,
        })
      : undefined;
    const costs = [liveCases?.costUsd, review?.costUsd].filter(
      (value): value is number => typeof value === 'number',
    );
    return {
      grade: shopifyGrade(options.own, schema, live),
      record: {
        schema,
        ...(live ? { live } : {}),
        ...(liveCases ? { liveCases } : {}),
        ...(review ? { review } : {}),
        ...(options.ai ? { aiCostUsd: costs.reduce((sum, value) => sum + value, 0) } : {}),
      },
    };
  }
}
