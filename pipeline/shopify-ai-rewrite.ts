import {
  getNamedType,
  GraphQLError,
  isCompositeType,
  NoUnusedFragmentsRule,
  parse,
  print,
  specifiedRules,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from 'graphql';
import { usageCostUsd, type AiOptions } from './ai-budget.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';

// AI use 4 (docs/SHOPIFY-META-ENGINES.md): a Shopify GraphQL document that breaks on the target
// version and no documented rule fixes is rewritten by the model, and counts only when Refit proves
// deterministically that the rewrite validates on the target schema, keeps every operation and
// variable, and returns every response path the code could read with the same type (aliases keep
// renamed fields at their old keys). The result is always [Needs review] (owner decision 8).

const RULES = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);
const MAX_SCHEMA_TYPES = 40;

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
          if (type)
            shape.set(
              path.join('.'),
              isCompositeType(getNamedType(type)) ? `${String(type)}{}` : String(type),
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
  const errors = validate(after, ast, RULES);
  if (errors.length) return `The rewrite fails on the target schema: ${errors[0].message}`;
  const originalAst = parse(original);
  if (operations(originalAst).join('\n') !== operations(ast).join('\n'))
    return 'The rewrite changes an operation, its name or its variables.';
  const was = responseShape(originalAst, before);
  const now = responseShape(ast, after);
  for (const [key, type] of was) {
    const next = now.get(key);
    if (next === undefined) return `The rewrite no longer returns ${key}.`;
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
