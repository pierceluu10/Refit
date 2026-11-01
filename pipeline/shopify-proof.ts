import {
  getNamedType,
  GraphQLError,
  isAbstractType,
  isEnumType,
  isInputObjectType,
  isNonNullType,
  NoUnusedFragmentsRule,
  parse,
  print,
  specifiedRules,
  TypeInfo,
  typeFromAST,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLSchema,
} from 'graphql';
import type { AiOptions } from './ai-budget.ts';
import type { EvidenceGrade } from './check-selection.ts';
import { writeShopifyLiveCases } from './shopify-ai.ts';
import {
  documentLocation,
  scanShopify,
  type AdminDocument,
  type DocumentSegment,
  type ShopifyScan,
} from './shopify-analysis.ts';
import {
  liveShopifyProof,
  needsCase,
  shopifyAccessToken,
  shopifyTestStore,
  type ShopifyLiveCase,
  type ShopifyLiveProof,
} from './shopify-live-proof.ts';
import { proveShopifyRest } from './shopify-rest-contract.ts';
import type { Repository } from './types.ts';

type GraphqlFile = { path: string; content: string };

// Offline proof for Shopify patches (docs/SHOPIFY-PROOF.md). Shopify versions its Admin GraphQL
// schema per release, so every document the code sends can be validated against the exact schema of
// the version it will run on: the original documents against the original version, the patched
// documents against the target. Validation alone does not see a selected field that changes type or
// a variable whose input type gains a required field, so those count as unproven too.

const RULES = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);
const MAX_TEXT = 300;
const CODEGEN_CONFIG = /(?:^|\/)(?:\.graphqlrc\.[cm]?[jt]s|codegen\.[cm]?[jt]s|codegen\.ya?ml)$/;
const CODEGEN_PACKAGE = /@shopify\/api-codegen-preset|@graphql-codegen\//;
// What Shopify's codegen preset and graphql-codegen's client preset write into generated types.
const GENERATED_TYPES =
  /declare module ['"]@shopify\/(?:admin|storefront)-api-client['"]|from ['"]@graphql-typed-document-node\/core['"]/;
const CODE_WEBHOOKS = /\bDeliveryMethod\.\w+/;
// Shopify version pins as a codegen configuration writes them.
const VERSION_PIN =
  /\bApiVersion\b(?:\.\w+)?|\bLATEST_API_VERSION\b|(['"`])(?:\d{4}-\d{2}|unstable)\1/g;

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

export function checkDocument(
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
  // Only committed generated types reach the type check: the sandbox cannot run codegen offline.
  if (!files.length || !repository.files.some((file) => GENERATED_TYPES.test(file.content)))
    return undefined;
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

// Codegen configurations the patch changes only in their Admin API version pin. The pin chooses the
// schema the types are generated from, which codegenEvidence proves equivalent for the documents, so
// no type check has to cover the file (a .graphqlrc.ts is outside the app's tsconfig).
export function codegenPinFiles(original: Repository, patched: Repository) {
  const files = (repository: Repository) => [
    ...repository.files,
    ...(repository.configurations ?? []),
  ];
  const before = new Map(files(original).map((file) => [file.path, file.content]));
  return files(patched)
    .filter((file) => {
      const old = before.get(file.path);
      if (!CODEGEN_CONFIG.test(file.path) || !CODEGEN_PACKAGE.test(file.content)) return false;
      if (old === undefined || old === file.content) return false;
      const [was, now] = [old.split('\n'), file.content.split('\n')];
      return (
        was.length === now.length &&
        was.every(
          (line, index) =>
            line === now[index] ||
            line.replace(VERSION_PIN, '$') === now[index].replace(VERSION_PIN, '$'),
        )
      );
    })
    .map((file) => file.path);
}

export function shopifySchemaProof(options: {
  original: Repository;
  patched: Repository;
  before: ShopifyVersionedSchema;
  after: ShopifyVersionedSchema;
  scans?: { original: ShopifyScan; patched: ShopifyScan };
  // Documents the model read from calls Refit cannot read (AI use 5), at their patched lines.
  reconstructed?: { file: string; line: number; document: string }[];
}): ShopifySchemaProof {
  const original = options.scans?.original ?? scanShopify(options.original);
  const patched = options.scans?.patched ?? scanShopify(options.patched);
  const originalFailures: ShopifyProofFailure[] = [];
  const failures: ShopifyProofFailure[] = [];
  const read = (entry: { file: string; line: number }) =>
    options.reconstructed?.find((item) => item.file === entry.file && item.line === entry.line);
  // Storefront clients keep their own version and contract; the Admin proof leaves them out.
  const unreadable: string[] = patched.unreadable
    .filter((entry) => !entry.api && !read(entry))
    .map((entry) => `${entry.file}:${entry.line} (${entry.reason})`);
  const reconstructed = patched.unreadable.flatMap((entry) => {
    const found = !entry.api && read(entry);
    return found
      ? [
          {
            ...entry,
            text: found.document,
            // Errors in a reconstruction point at the call's line; its text is not in the source.
            segments: [
              {
                documentStart: 0,
                documentEnd: found.document.length,
                file: entry.file,
                sourceStart: entry.line - 1,
                sourceText: '\n'.repeat(entry.line - 1),
              },
            ],
            traced: true,
          } satisfies AdminDocument,
        ]
      : [];
  });
  const otherApi: string[] = [];
  const widened: string[] = [];
  // Fragments defined in another file or .graphql document are inlined, as the scan does.
  const originalPool = fragmentPool(original.documents);
  const patchedPool = fragmentPool(patched.documents);
  let checkedOriginal = 0;
  for (const document of original.documents) {
    if (document.api) continue;
    const result = checkDocument(withFragments(document, originalPool), options.before.schema);
    if (result.unreadable) continue;
    checkedOriginal++;
    for (const error of result.errors)
      originalFailures.push({ ...error, version: options.before.version });
  }
  const originalTexts = new Set(original.documents.map((document) => document.text));
  let checkedPatched = 0;
  for (const document of [...patched.documents, ...reconstructed]) {
    if (document.api) continue;
    const result = checkDocument(
      withFragments(document, patchedPool),
      options.after.schema,
      options.before.schema,
    );
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
      checkDocument(withFragments(document, patchedPool), options.before.schema).errors.length
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
  // REST calls count only when the versioned REST contract proves each one (shopify-rest-contract.ts).
  const rest = patched.rest.length
    ? proveShopifyRest(options.patched, patched, {
        before: options.before.version,
        after: options.after.version,
      })
    : [];
  const restUnproven = rest.filter((item) => item.proof.status !== 'proven');
  const restProven = rest.length
    ? ` Every REST Admin call (${rest.length}) uses only endpoints, parameters, body keys and response fields the ${options.before.version} REST contract lists and ${options.after.version} keeps unchanged.`
    : '';
  if (restUnproven.length) {
    const first = restUnproven[0];
    return {
      ...base,
      status: 'unproven',
      reason: `Refit cannot prove ${restUnproven.length === 1 ? 'a REST Admin call' : `${restUnproven.length} REST Admin calls`} against the ${options.before.version} and ${options.after.version} REST contracts, first ${first.entry.file}:${first.entry.line}: ${(first.proof as { reason: string }).reason}`,
    };
  }
  if (unreadable.length)
    return {
      ...base,
      status: 'unproven',
      reason: `Refit could not read ${unreadable.length === 1 ? 'a GraphQL document' : `${unreadable.length} GraphQL documents`} the code sends, first ${unreadable[0]}, so it cannot prove ${unreadable.length === 1 ? 'it works' : 'they work'} on Admin API ${options.after.version}.`,
    };
  // Nothing the code sends depends on the Admin API version: no Admin call, no document, no REST
  // call, and no webhook subscription registered in code (those receive the app version's payloads).
  if (
    !checkedPatched &&
    !patched.adminCalls &&
    !patched.documents.some((document) => !document.api) &&
    !options.patched.files.some((file) => CODE_WEBHOOKS.test(file.content))
  )
    return {
      ...base,
      status: 'proven',
      reason: rest.length
        ? `The code sends no Admin GraphQL request and registers no webhook subscription in code.${restProven}${codegen ? ` ${codegen.reason}` : ''}`
        : `The code sends no Admin API request: Refit found no Admin GraphQL call or document, no REST call and no webhook subscription registered in code, so nothing it sends depends on the version moving to ${options.after.version}.${codegen ? ` ${codegen.reason}` : ''}`,
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
    reason: `Every traced Shopify GraphQL document (${checkedPatched}${reconstructed.length ? `, ${reconstructed.length} read by AI from code Refit could not read and checked to name only what that code writes` : ''}) validates against the Admin API ${options.after.version} schema with graphql-js, and no selected field or variable input type changes between ${options.before.version} and ${options.after.version}.${restProven}${codegen ? ` ${codegen.reason}` : ''}`,
  };
}

// Proof levels A–D for a Shopify patch (docs/PROOF-BASED-VALIDATION.md): without schema proof the
// patch is grade D whatever its checks did; with it, a live run on the dev store gives A, and the
// repository's own tests or type check keep their B or C. Nothing else raises the grade.
export function shopifyGrade(
  own: EvidenceGrade | undefined,
  schema: ShopifySchemaProof,
  live?: { status: string; reason: string },
  codegenPins: readonly string[] = [],
  // Patched operations whose variables differ from the original's and that the development store
  // did not run: the schema proof cannot see whether the code sends what they now declare.
  uncovered: readonly string[] = [],
): EvidenceGrade {
  const pins = codegenPins.length
    ? ` The patch changes only the version pin of ${codegenPins.join(', ')}, which selects only the schema codegen generates types from; the schema proof covers that schema.`
    : '';
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
  if (uncovered.length)
    return {
      letter: 'D',
      level: 'none',
      reason: `The patch changes the variables of ${uncovered.join(', ')}, and the development store did not run ${uncovered.length === 1 ? 'it' : 'them'}${live ? ` (${live.reason})` : ' (no development store is configured)'}; schema validation cannot see what the code sends. ${schema.reason}`,
    };
  if (live?.status === 'passed')
    return { letter: 'A', level: 'behaviour-tests', reason: `${live.reason} ${schema.reason}` };
  if (own && (own.letter === 'B' || own.letter === 'C'))
    return { ...own, reason: `${schema.reason} ${own.reason}${pins}` };
  return {
    letter: 'D',
    level: 'none',
    reason: `${schema.reason} Grade C also needs a passing type check over the changed files: ${own?.reason ?? 'no check passed.'}`,
  };
}

// The part of a document between two offsets, with its source mapping.
function sliceDocument(document: AdminDocument, start: number, end: number) {
  const segments: DocumentSegment[] = document.segments
    .filter((entry) => entry.documentEnd > start && entry.documentStart < end)
    .map((entry) => {
      const from = Math.max(entry.documentStart, start);
      return {
        ...entry,
        documentStart: from - start,
        documentEnd: Math.min(entry.documentEnd, end) - start,
        sourceStart: entry.sourceStart + from - entry.documentStart,
      };
    });
  return { text: document.text.slice(start, end), segments };
}

// Fragments defined once across every document Refit read, by name: codegen and .graphql projects
// define a fragment in one file and spread it in another. A name defined twice is left out.
export function fragmentPool(documents: AdminDocument[]) {
  const pool = new Map<string, ReturnType<typeof sliceDocument> | null>();
  for (const document of documents) {
    let ast: DocumentNode;
    try {
      ast = parse(document.text);
    } catch {
      continue;
    }
    for (const definition of ast.definitions) {
      if (definition.kind !== 'FragmentDefinition' || !definition.loc) continue;
      const piece = sliceDocument(document, definition.loc.start, definition.loc.end);
      const known = pool.get(definition.name.value);
      pool.set(
        definition.name.value,
        known === undefined || known?.text === piece.text ? piece : null,
      );
    }
  }
  return pool;
}

// The document with every fragment it spreads but does not define appended from the pool.
export function withFragments(
  document: AdminDocument,
  pool: ReturnType<typeof fragmentPool>,
): AdminDocument {
  let current = document;
  for (let round = 0; round < 16; round++) {
    let ast: DocumentNode;
    try {
      ast = parse(current.text);
    } catch {
      return current;
    }
    const defined = new Set(
      ast.definitions
        .filter((entry): entry is FragmentDefinitionNode => entry.kind === 'FragmentDefinition')
        .map((entry) => entry.name.value),
    );
    const missing = new Set<string>();
    visit(ast, {
      FragmentSpread(node) {
        if (!defined.has(node.name.value) && pool.get(node.name.value))
          missing.add(node.name.value);
      },
    });
    if (!missing.size) return current;
    let { text } = current;
    const segments = [...current.segments];
    for (const name of missing) {
      const piece = pool.get(name)!;
      text += '\n';
      for (const entry of piece.segments)
        segments.push({
          ...entry,
          documentStart: entry.documentStart + text.length,
          documentEnd: entry.documentEnd + text.length,
        });
      text += piece.text;
    }
    current = { ...current, text, segments };
  }
  return current;
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
  // The .graphql and .gql documents of each side, which source reading skips (shopifyExtraFiles).
  graphql?: { original: GraphqlFile[]; patched: GraphqlFile[] };
  // Codegen configurations changed only in their version pin, left out of the checks' grade.
  codegenPins?: readonly string[];
  ai?: AiOptions;
  environment: Record<string, string | undefined>;
  fetch?: typeof fetch;
  reconstructed?: { file: string; line: number; document: string }[];
  // Cases the migrations wrote for documents whose variables they changed, at their patched lines.
  cases?: ShopifyLiveCase[];
}) {
  const scans = {
    original: scanShopify(options.original, options.graphql?.original),
    patched: scanShopify(options.patched, options.graphql?.patched),
  };
  const schema = shopifySchemaProof({ ...options, scans });
  const versions = { before: options.before.version, after: options.after.version };
  // The original document at the same position in the same file.
  const originalOf = (document: AdminDocument) => {
    const inFile = (scan: ShopifyScan) =>
      scan.documents.filter((entry) => entry.file === document.file);
    return inFile(scans.original)[inFile(scans.patched).indexOf(document)];
  };
  const variableSignature = (text: string) => {
    try {
      return parse(text)
        .definitions.flatMap((definition) =>
          definition.kind === 'OperationDefinition'
            ? [
                `${definition.name?.value ?? ''}(${(definition.variableDefinitions ?? [])
                  .map((entry) => print(entry))
                  .join(',')})`,
              ]
            : [],
        )
        .join(';');
    } catch {
      return undefined;
    }
  };
  // Patched operations whose variables differ from the original's; each must run on the store.
  const changedVariables = scans.patched.documents.flatMap((document) => {
    const original = originalOf(document);
    if (document.api || !original || original.text === document.text) return [];
    if (variableSignature(original.text) === variableSignature(document.text)) return [];
    return parse(document.text).definitions.flatMap((definition) =>
      definition.kind === 'OperationDefinition'
        ? [{ id: documentId(document), operationName: definition.name?.value ?? null }]
        : [],
    );
  });
  const uncoveredBy = (live: ShopifyLiveProof | undefined) =>
    changedVariables
      .filter(
        (entry) =>
          !live?.operations.some(
            (operation) =>
              operation.document === entry.id &&
              operation.operationName === entry.operationName &&
              operation.status === 'passed',
          ),
      )
      .map((entry) => `${entry.id}${entry.operationName ? ` (${entry.operationName})` : ''}`);
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
        // The original document, for the original version, unless it already fails there: Shopify
        // serves the target's predecessor today, so the patched document runs on both versions.
        const original = originalOf(document);
        return {
          id: documentId(document),
          original:
            original && !checkDocument(original, options.before.schema).errors.length
              ? original.text
              : null,
          patched: document.text,
        };
      });
    const given = options.cases ?? [];
    const needsInput = documents.filter(
      (document) =>
        needsCase(document.patched) && !given.some((entry) => entry.document === document.id),
    );
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
      cases: [...given, ...(written?.cases ?? [])],
      fetch: options.fetch,
    });
  }
  return finish(live);

  async function finish(live: ShopifyLiveProof | undefined) {
    const costs = [liveCases?.costUsd].filter(
      (value): value is number => typeof value === 'number',
    );
    return {
      grade: shopifyGrade(options.own, schema, live, options.codegenPins, uncoveredBy(live)),
      record: {
        schema,
        ...(live ? { live } : {}),
        ...(liveCases ? { liveCases } : {}),
        ...(options.ai ? { aiCostUsd: costs.reduce((sum, value) => sum + value, 0) } : {}),
      },
    };
  }
}
