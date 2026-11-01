import {
  getNamedType,
  isInputObjectType,
  isEnumType,
  parse,
  printType,
  typeFromAST,
  validate,
  visit,
  type GraphQLSchema,
} from 'graphql';
import { usageCostUsd, type AiOptions } from './ai-budget.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';
import type { ShopifyLiveCase } from './shopify-live-proof.ts';

// The AI use Shopify proof makes (docs/SHOPIFY-META-ENGINES.md, AI use 3): the model writes inputs
// that Refit checks and runs itself, and it cannot raise a grade on its own.

const MAX_INPUT_TYPES = 40;

export interface ShopifyAiRecord {
  status: 'completed' | 'error';
  model: string;
  costUsd: number | null;
  reason?: string;
}

// The budget's settled cost, else the usage priced from the built-in table (null for an unknown model).
function cost(response: Awaited<ReturnType<typeof requestStructuredOutput>>) {
  if (response.budget) return response.budget.costUsd;
  try {
    return response.usage ? usageCostUsd(response.model, response.usage) : null;
  } catch {
    return null;
  }
}

const failure = (ai: AiOptions, error: unknown): ShopifyAiRecord => ({
  status: 'error',
  model: ai.model,
  costUsd: error instanceof UnusableAiResponse && error.budget ? error.budget.costUsd : null,
  reason: error instanceof Error ? error.message : String(error),
});

// The input types (SDL) the documents' variables carry, so the model writes values the target
// accepts without the whole schema.
function inputTypes(documents: readonly string[], schema: GraphQLSchema) {
  const names = new Set<string>();
  const add = (name: string) => {
    if (names.has(name) || names.size >= MAX_INPUT_TYPES) return;
    const type = schema.getType(name);
    if (!type || !(isInputObjectType(type) || isEnumType(type))) return;
    names.add(name);
    if (isInputObjectType(type))
      for (const field of Object.values(type.getFields())) add(getNamedType(field.type).name);
  };
  for (const document of documents)
    try {
      visit(parse(document), {
        VariableDefinition(node) {
          const type = typeFromAST(schema, node.type);
          if (type) add(getNamedType(type).name);
        },
      });
    } catch {
      // Documents that do not parse were already refused by the schema proof.
    }
  return [...names].map((name) => printType(schema.getType(name)!));
}

const step = {
  type: 'object',
  additionalProperties: false,
  required: ['document', 'variablesJson'],
  properties: { document: { type: 'string' }, variablesJson: { type: 'string' } },
};

const CASE_INSTRUCTIONS = `You write inputs for Refit's live proof of Shopify Admin GraphQL operations on Refit's own Partner development store. Refit sends each operation at two API versions and checks for errors. For each operation given, return one case:
- document: the id given; operationName: the operation's name, or "" when it has none.
- variablesJson: a JSON object with a value for every variable. Use realistic test values. Write any ID as {"$ref": "setup.<index>.<path>"} pointing at an ID a setup step returned (path through the response data, e.g. "setup.0.productCreate.product.id"), or {"$ref": "operation.<path>"} in cleanup for an ID the operation itself returned. Never write a literal gid:// ID: the store holds nothing Refit did not create in this run.
- setup: mutations whose every root field ends in "Create" that make the objects the operation reads or changes. Select the id of each created object. Use [] when the operation needs no object.
- cleanup: mutations whose every root field ends in "Delete" that delete every object setup or the operation created, by $ref.
Refit refuses any step that breaks these rules, any mutation that is not a create and receives no ID this run created, and any document that does not validate at both versions.`;

// AI use 3: inputs for the operations live proof cannot run alone (required variables, mutations).
// Refit validates every setup and cleanup document against both schemas and keeps only valid cases;
// liveShopifyProof enforces the store rules again before sending anything.
export async function writeShopifyLiveCases(options: {
  ai: AiOptions;
  documents: { id: string; text: string }[];
  schemas: [GraphQLSchema, GraphQLSchema];
}): Promise<{ record: ShopifyAiRecord & { dropped: string[] }; cases: ShopifyLiveCase[] }> {
  const [before, after] = options.schemas;
  try {
    const response = await requestStructuredOutput(
      {
        name: 'shopify_live_cases',
        instructions: CASE_INSTRUCTIONS,
        evidence: {
          operations: options.documents,
          inputTypes: inputTypes(
            options.documents.map((document) => document.text),
            after,
          ),
        },
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['cases'],
          properties: {
            cases: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['document', 'operationName', 'variablesJson', 'setup', 'cleanup'],
                properties: {
                  document: { type: 'string' },
                  operationName: { type: 'string' },
                  variablesJson: { type: 'string' },
                  setup: { type: 'array', items: step },
                  cleanup: { type: 'array', items: step },
                },
              },
            },
          },
        },
      },
      options.ai,
    );
    const dropped: string[] = [];
    const cases: ShopifyLiveCase[] = [];
    const answer = JSON.parse(response.content) as {
      cases: {
        document: string;
        operationName: string;
        variablesJson: string;
        setup: { document: string; variablesJson: string }[];
        cleanup: { document: string; variablesJson: string }[];
      }[];
    };
    const valid = (text: string) => {
      try {
        const ast = parse(text);
        return !validate(before, ast).length && !validate(after, ast).length;
      } catch {
        return false;
      }
    };
    const object = (text: string) => {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('variables are not a JSON object');
      return value as Record<string, unknown>;
    };
    for (const entry of answer.cases) {
      const label = `${entry.document}${entry.operationName ? ` (${entry.operationName})` : ''}`;
      try {
        const steps = [...entry.setup, ...entry.cleanup];
        const invalid = steps.find((item) => !valid(item.document));
        if (invalid)
          throw new Error('a setup or cleanup document does not validate at both versions');
        cases.push({
          document: entry.document,
          operationName: entry.operationName || null,
          variables: object(entry.variablesJson),
          setup: entry.setup.map((item) => ({
            document: item.document,
            variables: object(item.variablesJson),
          })),
          cleanup: entry.cleanup.map((item) => ({
            document: item.document,
            variables: object(item.variablesJson),
          })),
        });
      } catch (error) {
        dropped.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      record: {
        status: 'completed',
        model: response.model,
        costUsd: cost(response),
        dropped,
      },
      cases,
    };
  } catch (error) {
    return { record: { ...failure(options.ai, error), dropped: [] }, cases: [] };
  }
}
