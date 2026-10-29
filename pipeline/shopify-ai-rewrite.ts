import {
  getNamedType,
  GraphQLError,
  isCompositeType,
  parse,
  print,
  TypeInfo,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';
import { usageCostUsd, type AiOptions } from './ai-budget.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';
import { documentProof } from './shopify-proof.ts';

// AI use 4 (docs/SHOPIFY-META-ENGINES.md): a Shopify GraphQL document that breaks on the target
// version and no documented rule fixes is rewritten by the model, and counts only when Refit proves
// deterministically that the rewrite validates on the target schema, keeps every operation and
// variable, and returns every response path the code could read with the same type (aliases keep
// renamed fields at their old keys). The result is always [Needs review] (owner decision 8).

const MAX_SCHEMA_TYPES = 40;
const UNKNOWN = '(not in the original schema)';

const INSTRUCTIONS = `You migrate one Shopify GraphQL document to a newer API version.
The evidence holds the document, the validation errors it gets on the target version, and the SDL of the target types it touches.
Return the rewritten document. It must validate against the target version and keep:
- every operation, its name and its variable definitions exactly as they are, since application code sends those variables;
- every response key the original returns, with the same kind of value: when a field was renamed, alias the new field to the old response key (\`oldName: newName\`);
- every fragment name.
Change nothing that is not needed to fix the errors. If the document cannot be migrated without changing what the response contains, return an empty document and explain why.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['document', 'explanation'],
  properties: { document: { type: 'string' }, explanation: { type: 'string' } },
};

// Response paths (through aliases and fragments) with the type of the value at each.
export function responseShape(ast: DocumentNode, schema: GraphQLSchema) {
  const shape = new Map<string, string>();
  const info = new TypeInfo(schema);
  const path: string[] = [];
  visit(
    ast,
    visitWithTypeInfo(info, {
      OperationDefinition: {
        enter(node) {
          path.push(`${node.operation}:${node.name?.value ?? ''}`);
        },
        leave() {
          path.pop();
        },
      },
      FragmentDefinition: {
        // Fragments are read through their spreads' types; their own paths start at their name.
        enter(node) {
          path.push(`fragment:${node.name.value}`);
        },
        leave() {
          path.pop();
        },
      },
      Field: {
        enter(node) {
          path.push((node.alias ?? node.name).value);
          const type = info.getType();
          // A field the schema does not have (the original already fails) keeps its key, typeless.
          shape.set(
            path.join('.'),
            !type
              ? UNKNOWN
              : isCompositeType(getNamedType(type))
                ? `${String(type)}{}`
                : String(type),
          );
        },
        leave() {
          path.pop();
        },
      },
    }),
  );
  return shape;
}

const operations = (ast: DocumentNode) =>
  ast.definitions
    .filter((entry): entry is OperationDefinitionNode => entry.kind === 'OperationDefinition')
    .map(
      (entry) =>
        `${entry.operation} ${entry.name?.value ?? ''}(${(entry.variableDefinitions ?? []).map((variable) => print(variable)).join(', ')})`,
    )
    .sort();

const deadSelections = (ast: DocumentNode) => {
  let count = 0;
  visit(ast, {
    Directive(node) {
      const condition = node.arguments?.find((argument) => argument.name.value === 'if')?.value;
      if (condition?.kind === 'BooleanValue' && condition.value === (node.name.value === 'skip'))
        count++;
    },
  });
  return count;
};

// Why a rewrite is not acceptable, or undefined when every check passes.
export function rewriteProblem(
  original: string,
  rewritten: string,
  before: GraphQLSchema,
  after: GraphQLSchema,
) {
  let ast: DocumentNode;
  try {
    ast = parse(rewritten);
  } catch (error) {
    if (error instanceof GraphQLError) return `The rewrite does not parse: ${error.message}`;
    throw error;
  }
  // The patch proof's own check (pipeline/shopify-proof.ts): valid on the target, and no selected
  // field or variable input type changes from the original version.
  const proof = documentProof(rewritten, after, before);
  if (!proof) return 'The rewrite spreads a fragment it does not define.';
  if (proof.length) return `The rewrite fails the schema proof on the target: ${proof[0]}`;
  const originalAst = parse(original);
  // A selection that never runs (`@skip(if: true)`) only hides an error, such as an unused variable.
  if (deadSelections(ast) > deadSelections(originalAst))
    return 'The rewrite adds a selection that never runs (@skip(if: true) or @include(if: false)).';
  if (operations(originalAst).join('\n') !== operations(ast).join('\n'))
    return 'The rewrite changes an operation, its name or its variables.';
  const was = responseShape(originalAst, before);
  const now = responseShape(ast, after);
  for (const [key, type] of was) {
    const next = now.get(key);
    if (next === undefined) return `The rewrite no longer returns ${key}.`;
    // The original already fails here, so no response reached the code: the key must stay, under
    // whatever type the target now returns.
    if (type === UNKNOWN) continue;
    // A nullable value that becomes non-null only removes a case the code already handles.
    if (next !== type && next !== type.replace(/(\{\})?$/, '!$1'))
      return `The rewrite returns ${key} as ${next} where the code read ${type}.`;
  }
  return undefined;
}

// The SDL of the target types the document's selections and arguments name, for the prompt.
function relevantTypes(text: string, before: GraphQLSchema, after: GraphQLSchema) {
  const names = new Set<string>();
  const info = new TypeInfo(before);
  visit(
    parse(text),
    visitWithTypeInfo(info, {
      enter() {
        for (const type of [info.getParentType(), info.getType(), info.getInputType()])
          if (type) names.add(getNamedType(type).name);
      },
    }),
  );
  return [...names]
    .filter((name) => !name.startsWith('__'))
    .slice(0, MAX_SCHEMA_TYPES)
    .flatMap((name) => {
      const type = after.getType(name);
      return type
        ? [printTypeSdl(after, name)]
        : [`# ${name} does not exist on the target version`];
    })
    .join('\n');
}

function printTypeSdl(schema: GraphQLSchema, name: string) {
  const type = schema.getType(name)!;
  if (!('getFields' in type)) return `${type.toString()}: ${type.constructor.name}`;
  const fields = Object.values(type.getFields()).map((field) => {
    const args =
      'args' in field && field.args.length
        ? `(${field.args.map((arg: { name: string; type: unknown }) => `${arg.name}: ${String(arg.type)}`).join(', ')})`
        : '';
    return `  ${field.name}${args}: ${String(field.type)}`;
  });
  return `type ${name} {\n${fields.join('\n')}\n}`;
}

export interface ShopifyAiRewrite {
  status: 'kept' | 'refused' | 'error';
  model: string;
  costUsd: number | null;
  reason: string;
  document?: string;
}

export async function aiRewriteDocument(options: {
  text: string;
  errors: string[];
  before: GraphQLSchema;
  after: GraphQLSchema;
  versions: { before: string; after: string };
  ai: AiOptions;
}): Promise<ShopifyAiRewrite> {
  let response: Awaited<ReturnType<typeof requestStructuredOutput>>;
  try {
    response = await requestStructuredOutput(
      {
        name: 'shopify_document_rewrite',
        instructions: INSTRUCTIONS,
        schema: SCHEMA,
        evidence: {
          from: options.versions.before,
          to: options.versions.after,
          document: options.text,
          errors: options.errors,
          targetTypes: relevantTypes(options.text, options.before, options.after),
        },
      },
      options.ai,
    );
  } catch (error) {
    if (!(error instanceof UnusableAiResponse)) throw error;
    return { status: 'error', model: options.ai.model, costUsd: null, reason: error.message };
  }
  let costUsd: number | null = response.budget?.costUsd ?? null;
  try {
    costUsd ??= response.usage ? usageCostUsd(response.model, response.usage) : null;
  } catch {
    // An unknown model has no price; the cost stays unknown.
  }
  let output: { document: string; explanation: string };
  try {
    output = JSON.parse(response.content);
  } catch {
    return {
      status: 'error',
      model: response.model,
      costUsd,
      reason: 'The model returned no JSON.',
    };
  }
  const base = { model: response.model, costUsd };
  if (!output.document.trim())
    return { ...base, status: 'refused', reason: `The model declined: ${output.explanation}` };
  const problem = rewriteProblem(options.text, output.document, options.before, options.after);
  return problem
    ? { ...base, status: 'refused', reason: problem }
    : { ...base, status: 'kept', reason: output.explanation, document: output.document };
}

const RECONSTRUCT_INSTRUCTIONS = `You read application code that sends a GraphQL document to the Shopify Admin API from one call site that static analysis could not resolve (the document is assembled at runtime, passed through a function or table, or built from parts).
The evidence holds the call's file and line, why it could not be read, and the source of that file and the files it imports.
Return the exact document that call sends: one GraphQL document, with every fragment it spreads defined. Write it only from what the code shows; every operation, field, argument, alias, fragment and variable name must appear in that source.
If the call can send more than one document, or any part of it depends on data the code does not show, return an empty document and explain why.`;

const MAX_RECONSTRUCT_SOURCE = 120_000;
const RELATIVE_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

// The call's file and the repository files it imports by relative path.
export function reconstructionSources(files: { path: string; content: string }[], file: string) {
  const own = files.find((entry) => entry.path === file);
  if (!own) return [];
  const directory = file.split('/').slice(0, -1);
  const imported = [...own.content.matchAll(RELATIVE_IMPORT)].flatMap((match) => {
    const parts = [...directory];
    for (const part of match[1].split('/'))
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    const base = parts.join('/').replace(/\.[cm]?js$/, '');
    return files.filter((entry) =>
      [base, `${base}/index`].some(
        (stem) =>
          /^\.[cm]?[jt]sx?$|^\.graphql$|^\.gql$/.test(entry.path.slice(stem.length)) &&
          entry.path.startsWith(stem),
      ),
    );
  });
  const sources: { path: string; content: string }[] = [];
  let size = 0;
  for (const entry of [own, ...new Set(imported)]) {
    if (size + entry.content.length > MAX_RECONSTRUCT_SOURCE) break;
    size += entry.content.length;
    sources.push(entry);
  }
  return sources;
}

// Why a reconstruction is not acceptable, or undefined. Deterministic, whatever the model says:
// every name is written in the code it was read from, and the document validates on both versions.
export function reconstructionProblem(
  document: string,
  sources: { content: string }[],
  before: GraphQLSchema,
  after: GraphQLSchema,
  versions: { before: string; after: string },
) {
  let ast: DocumentNode;
  try {
    ast = parse(document);
  } catch (error) {
    if (error instanceof GraphQLError) return `The reconstruction does not parse: ${error.message}`;
    throw error;
  }
  if (!ast.definitions.some((entry) => entry.kind === 'OperationDefinition'))
    return 'The reconstruction has no operation.';
  const names = new Set<string>();
  visit(ast, {
    Name(node) {
      names.add(node.value);
    },
  });
  const missing = [...names].filter(
    (name) =>
      !sources.some((source) =>
        new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(source.content),
      ),
  );
  if (missing.length)
    return `The reconstruction names ${missing.slice(0, 5).join(', ')}, which the code does not contain.`;
  const original = documentProof(document, before, before);
  if (!original) return 'The reconstruction spreads a fragment it does not define.';
  if (original.length)
    return `The reconstruction does not validate on ${versions.before}: ${original[0]}`;
  const target = documentProof(document, after, before);
  if (target?.length) return `The reconstruction does not hold on ${versions.after}: ${target[0]}`;
  return undefined;
}

export interface ShopifyReconstruction {
  status: 'kept' | 'refused' | 'error';
  model: string;
  costUsd: number | null;
  reason: string;
  document?: string;
}

// AI use 5: an Admin call whose document Refit cannot read statically is read by the model from the
// code, and the reconstruction counts only when reconstructionProblem finds nothing.
export async function aiReconstructDocument(options: {
  file: string;
  line: number;
  why: string;
  sources: { path: string; content: string }[];
  before: GraphQLSchema;
  after: GraphQLSchema;
  versions: { before: string; after: string };
  ai: AiOptions;
}): Promise<ShopifyReconstruction> {
  let response: Awaited<ReturnType<typeof requestStructuredOutput>>;
  try {
    response = await requestStructuredOutput(
      {
        name: 'shopify_document_reconstruction',
        instructions: RECONSTRUCT_INSTRUCTIONS,
        schema: SCHEMA,
        evidence: {
          call: { file: options.file, line: options.line, unreadable: options.why },
          files: options.sources,
        },
      },
      options.ai,
    );
  } catch (error) {
    if (!(error instanceof UnusableAiResponse)) throw error;
    return { status: 'error', model: options.ai.model, costUsd: null, reason: error.message };
  }
  let costUsd: number | null = response.budget?.costUsd ?? null;
  try {
    costUsd ??= response.usage ? usageCostUsd(response.model, response.usage) : null;
  } catch {
    // An unknown model has no price; the cost stays unknown.
  }
  let output: { document: string; explanation: string };
  try {
    output = JSON.parse(response.content);
  } catch {
    return {
      status: 'error',
      model: response.model,
      costUsd,
      reason: 'The model returned no JSON.',
    };
  }
  const base = { model: response.model, costUsd };
  if (!output.document.trim())
    return { ...base, status: 'refused', reason: `The model declined: ${output.explanation}` };
  const problem = reconstructionProblem(
    output.document,
    options.sources,
    options.before,
    options.after,
    options.versions,
  );
  return problem
    ? { ...base, status: 'refused', reason: problem }
    : { ...base, status: 'kept', reason: output.explanation, document: output.document };
}
