import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  type GraphQLNamedType,
  type GraphQLSchema,
} from 'graphql';
import { usageCostUsd, type AiOptions } from './ai-budget.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';
import {
  ruleProblems,
  type RestContract,
  type RestField,
  type RestRefusal,
  type RestRule,
  type RestStop,
} from './shopify-rest-rewrite.ts';

// AI use 4 (docs/SHOPIFY-META-ENGINES.md) for REST calls no documented rule covers: the model
// proposes a mapping in the rule format, and Refit keeps it only when every GraphQL path exists on
// each target schema, every conversion fits, every mapped value has the type the SDK's REST resource
// declares, and the rewrite it generates produces every field the code reads and validates
// (shopifyRestRewrites re-runs the file with it). The repository's type check runs in validation.
// The model writes no code; Refit generates the call and its adapter.

const INSTRUCTIONS = `You map one Shopify REST Admin API read to the GraphQL Admin API.
The evidence holds the REST request (method, path, query parameters), the REST response fields the code reads, the field types of the REST resource, the GraphQL QueryRoot fields and the SDL of the types likely involved.
Return the GraphQL QueryRoot field that returns the same records, and for every REST field the code reads, the GraphQL path (dot separated, from the returned object; for connections use \`name(first: 250).nodes\`) and a conversion:
- gid-number when REST sends a numeric id and GraphQL an ID (gid://shopify/...);
- lowercase when REST sends a lower-case string and GraphQL an enum;
- join-comma when REST sends a comma-separated string and GraphQL a list of strings;
- empty otherwise.
Nested REST objects or arrays need an entry for the container (rest "variants", graphql "variants(first: 250).nodes") and entries for each field read inside it (rest "variants[].price", graphql "price").
kind is "single" for one record, "list" for a list (the GraphQL field must be a connection; first/after are added for you), "count" for a count field returning { count }.
Arguments: name is the GraphQL argument; from is "path:<placeholder>" or "query:<parameter>"; type is its GraphQL type; gid is the GraphQL type name when a numeric REST id must become a gid, else empty; value is a constant GraphQL literal instead of from, else empty.
Decline (decline: true) when GraphQL would return different records (a default filter REST applies and GraphQL does not, or the reverse), a different count, or when any read field has no field with the same meaning. A wrong mapping is worse than none.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decline', 'explanation', 'root', 'kind', 'arguments', 'fields'],
  properties: {
    decline: { type: 'boolean' },
    explanation: { type: 'string' },
    root: { type: 'string' },
    kind: { type: 'string', enum: ['single', 'list', 'count'] },
    arguments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'from', 'type', 'gid', 'value'],
        properties: {
          name: { type: 'string' },
          from: { type: 'string' },
          type: { type: 'string' },
          gid: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rest', 'graphql', 'convert'],
        properties: {
          rest: { type: 'string' },
          graphql: { type: 'string' },
          convert: { type: 'string', enum: ['', 'gid-number', 'lowercase', 'join-comma'] },
        },
      },
    },
  },
};

const MAX_TYPES = 30;

// The REST resource a request reaches, from the SDK's own paths.
export function restResource(
  contract: RestContract & {
    resources: Record<
      string,
      { paths?: { operation: string; method: string; path: string; ids: string[] }[] }
    >;
  },
  method: string,
  path: string,
  resource?: string,
) {
  if (resource) {
    const [className, operation] = resource.split('.');
    const entry = contract.resources[className];
    if (!entry) return undefined;
    const ids = operation === 'find' ? 1 : 0;
    const restPath = entry.paths?.find(
      (candidate) =>
        candidate.method === 'get' &&
        candidate.ids.length === ids &&
        (operation === 'count'
          ? /\/count\.json$/.test(candidate.path)
          : !/\/count\.json$/.test(candidate.path)),
    );
    return restPath
      ? { className, operation, path: restPath.path.replace(/<(\w+)>/g, '{$1}'), entry }
      : undefined;
  }
  const pattern = path.replace(/\{\w+\}/g, '{}');
  for (const [className, entry] of Object.entries(contract.resources))
    for (const candidate of entry.paths ?? [])
      if (
        candidate.method === method.toLowerCase() &&
        candidate.path.replace(/<\w+>/g, '{}') === pattern
      )
        return {
          className,
          operation: candidate.operation,
          path: candidate.path.replace(/<(\w+)>/g, '{$1}'),
          entry,
        };
  return undefined;
}

function typeSdl(type: GraphQLNamedType) {
  if (isEnumType(type))
    return `enum ${type.name} { ${type
      .getValues()
      .map((value) => value.name)
      .join(' ')} }`;
  if (!isObjectType(type) && !isInterfaceType(type) && !isInputObjectType(type))
    return `scalar ${type.name}`;
  const fields = Object.values(type.getFields()).map((field) => {
    const args =
      'args' in field && field.args.length
        ? `(${field.args.map((arg: { name: string; type: unknown }) => `${arg.name}: ${String(arg.type)}`).join(', ')})`
        : '';
    return `  ${field.name}${args}: ${String(field.type)}`;
  });
  return `type ${type.name} {\n${fields.join('\n')}\n}`;
}

// QueryRoot's fields that name the resource, and the types they reach two levels down.
function graphqlEvidence(schema: GraphQLSchema, className: string) {
  const query = schema.getQueryType()!;
  const stem = className.replace(/^\w/, (letter) => letter.toLowerCase());
  const roots = Object.values(query.getFields()).filter((field) =>
    field.name.toLowerCase().includes(stem.toLowerCase()),
  );
  const types = new Map<string, GraphQLNamedType>();
  const add = (type: GraphQLNamedType, depth: number) => {
    if (types.size >= MAX_TYPES || types.has(type.name) || type.name.startsWith('__')) return;
    types.set(type.name, type);
    if (depth && (isObjectType(type) || isInterfaceType(type)))
      for (const field of Object.values(type.getFields())) add(getNamedType(field.type), depth - 1);
  };
  for (const root of roots) add(getNamedType(root.type), 2);
  return {
    queryRoot: roots.map(
      (field) =>
        `${field.name}(${field.args.map((arg) => `${arg.name}: ${String(arg.type)}`).join(', ')}): ${String(field.type)}`,
    ),
    types: [...types.values()]
      .filter((type) => isObjectType(type) || isEnumType(type))
      .map(typeSdl),
  };
}

// The model's flat field list as the rule's nested fields.
function nestedFields(entries: { rest: string; graphql: string; convert: string }[]) {
  const fields: Record<string, RestField> = {};
  const sorted = [...entries].sort((a, b) => a.rest.split('.').length - b.rest.split('.').length);
  for (const entry of sorted) {
    const steps = entry.rest.split('.').map((step) => step.replace(/\[\]$/, ''));
    let target = fields;
    for (const step of steps.slice(0, -1)) {
      const container = target[step];
      if (!container) return `${entry.rest} has no container entry for ${step}`;
      container.fields ??= {};
      target = container.fields;
    }
    const name = steps.at(-1)!;
    if (target[name]) return `${entry.rest} is mapped twice`;
    target[name] = {
      graphql: entry.graphql,
      ...(entry.convert ? { convert: entry.convert as RestField['convert'] } : {}),
    };
  }
  return fields;
}

export interface ShopifyRestAiAttempt {
  status: 'kept' | 'refused' | 'error';
  model: string;
  costUsd: number | null;
  reason: string;
  rule?: RestRule;
}

export async function proposeRestRule(options: {
  stop: RestStop & { request: NonNullable<RestStop['request']> };
  contract: RestContract;
  refusals: RestRefusal[];
  schemas: { version: string; schema: GraphQLSchema }[];
  ai: AiOptions;
}): Promise<ShopifyRestAiAttempt> {
  const { request } = options.stop;
  const resourceCall = options.stop.entry.resource;
  const resource = restResource(
    options.contract as never,
    request.method,
    request.path,
    resourceCall,
  );
  const refuse = (reason: string): ShopifyRestAiAttempt => ({
    status: 'refused',
    model: options.ai.model,
    costUsd: 0,
    reason,
  });
  if (!resource)
    return refuse(
      'The REST resource this request reaches is not in the SDK contract, so Refit has no REST types to check a mapping against.',
    );
  const refusal = options.refusals.find(
    (entry) =>
      entry.method === request.method &&
      entry.path.replace(/\{\w+\}/g, '{}') === resource.path.replace(/\{\w+\}/g, '{}'),
  );
  if (refusal) return refuse(refusal.reason);
  let response: Awaited<ReturnType<typeof requestStructuredOutput>>;
  try {
    response = await requestStructuredOutput(
      {
        name: 'shopify_rest_mapping',
        instructions: INSTRUCTIONS,
        schema: SCHEMA,
        evidence: {
          request: {
            method: request.method,
            path: resource.path,
            query: request.query,
            ...(resourceCall ? { resourceCall } : {}),
          },
          reads: request.reads,
          restFields: resource.entry.fields,
          restEnvelope: { singular: resource.entry.singular, plural: resource.entry.plural },
          graphql: graphqlEvidence(options.schemas.at(-1)!.schema, resource.className),
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
  const base = { model: response.model, costUsd };
  let output: {
    decline: boolean;
    explanation: string;
    root: string;
    kind: RestRule['kind'];
    arguments: { name: string; from: string; type: string; gid: string; value: string }[];
    fields: { rest: string; graphql: string; convert: string }[];
  };
  try {
    output = JSON.parse(response.content);
  } catch {
    return { ...base, status: 'error', reason: 'The model returned no JSON.' };
  }
  if (output.decline)
    return { ...base, status: 'refused', reason: `The model declined: ${output.explanation}` };
  // A constant argument can change which records come back (a hard-coded filter), which no type
  // check sees; only `null` (lifting a default limit) is accepted.
  const constant = output.arguments.find((argument) => argument.value && argument.value !== 'null');
  if (constant)
    return {
      ...base,
      status: 'refused',
      reason: `The proposed mapping sends a constant ${constant.name}: ${constant.value}, which could change the records returned.`,
    };
  const fields = nestedFields(output.fields);
  if (typeof fields === 'string')
    return { ...base, status: 'refused', reason: `The proposed mapping is malformed: ${fields}.` };
  const rule: RestRule = {
    id: `ai.${resource.className}.${resource.operation}`,
    method: request.method,
    path: resource.path,
    ...(resourceCall
      ? { resource: { class: resource.className, operation: resourceCall.split('.')[1] } }
      : {}),
    restResource: resource.className,
    kind: output.kind,
    envelope:
      output.kind === 'count'
        ? 'count'
        : output.kind === 'list'
          ? resource.entry.plural
          : resource.entry.singular,
    root: output.root,
    arguments: Object.fromEntries(
      output.arguments.map((argument) => [
        argument.name,
        argument.value
          ? { value: argument.value }
          : {
              from: argument.from,
              type: argument.type,
              ...(argument.gid ? { gid: argument.gid } : {}),
            },
      ]),
    ),
    fields,
    notes: [
      `Mapping proposed by ${response.model} and checked by Refit against the GraphQL schemas and the REST resource types: ${output.explanation}`,
    ],
    origin: 'ai',
  };
  for (const { version, schema } of options.schemas) {
    const problems = ruleProblems(rule, schema, options.contract);
    if (problems.length)
      return {
        ...base,
        status: 'refused',
        reason: `The proposed mapping fails on Admin API ${version}: ${problems[0]}.`,
      };
  }
  return { ...base, status: 'kept', reason: output.explanation, rule };
}
