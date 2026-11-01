import { GraphQLError, parse, visit, type DocumentNode, type GraphQLSchema } from 'graphql';
import { usageCostUsd, type AiOptions } from './ai-budget.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';
import { documentProof } from './shopify-proof.ts';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['document', 'explanation'],
  properties: { document: { type: 'string' }, explanation: { type: 'string' } },
};

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

const EXTRACT_INSTRUCTIONS = `You read, from application code, exactly what one Shopify Admin API call sends. You never judge whether it is valid.
The evidence names the call (file and line), whether it sends a GraphQL document or a REST request, why static reading failed, and the call's file with the files it imports.
Return every request this call can send, each with the 1-based source lines in the call's file it is assembled from:
- graphql: the exact final document text, every fragment it spreads included; leave method and path empty and the lists empty.
- rest: the HTTP method, the path after /admin/api/{version}/ with each id written as {id} (such as customers/{id}/orders.json), the query parameter names, the body key paths (each a list of keys from the body root; empty for no body) and the response fields the code reads (each a list of keys from the response body root, with "[]" for an array element); leave document empty.
When a part of the request depends on data the code does not show, or you cannot tell which request is sent, return no requests and say why. Write nothing the code does not contain.`;

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requests', 'explanation'],
  properties: {
    requests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['document', 'method', 'path', 'query', 'body', 'reads', 'sourceLines'],
        properties: {
          document: { type: 'string' },
          method: { type: 'string' },
          path: { type: 'string' },
          query: { type: 'array', items: { type: 'string' } },
          body: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          reads: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          sourceLines: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    explanation: { type: 'string' },
  },
};

export interface ShopifyExtractedRequest {
  // A GraphQL document, or a REST request in the shape the REST contract prover reads.
  document?: string;
  rest?: { method: string; path: string; query: string[]; body: string[][]; reads: string[][] };
  sourceLines: number[];
}

export interface ShopifyExtraction {
  status: 'extracted' | 'refused' | 'error';
  model: string;
  costUsd: number | null;
  reason: string;
  requests: ShopifyExtractedRequest[];
}

const written = (name: string, sources: { content: string }[]) =>
  sources.some((source) =>
    new RegExp(`(?<![\\w$])${name.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(
      source.content,
    ),
  );

// Why an extracted request is not what the code sends, or undefined. Deterministic and narrow: the
// text parses and every name in it is written in the code it was read from. It never says whether
// the request is valid; the schema or REST contract judges that.
export function extractionProblem(
  request: ShopifyExtractedRequest,
  sources: { content: string }[],
  lines: number,
) {
  const outside = request.sourceLines.find((line) => line < 1 || line > lines);
  if (outside !== undefined || !request.sourceLines.length)
    return `The extraction cites line ${outside ?? 'none'}, outside the call's file.`;
  const names = new Set<string>();
  if (request.document !== undefined) {
    let ast: DocumentNode;
    try {
      ast = parse(request.document);
    } catch (error) {
      if (error instanceof GraphQLError)
        return `The extracted document does not parse: ${error.message}`;
      throw error;
    }
    visit(ast, {
      Name(node) {
        names.add(node.value);
      },
    });
  } else if (request.rest) {
    if (!/^(GET|POST|PUT|DELETE)$/.test(request.rest.method))
      return `The extraction gives the HTTP method ${request.rest.method}.`;
    for (const segment of request.rest.path.replace(/\.json$/, '').split('/'))
      if (!/^\{\w*\}$/.test(segment)) names.add(segment);
    for (const name of request.rest.query) names.add(name.replace(/\[.*$/, ''));
    for (const path of request.rest.body) for (const key of path) names.add(key);
  } else return 'The extraction is neither a GraphQL document nor a REST request.';
  const missing = [...names].filter((name) => !written(name, sources));
  return missing.length
    ? `The extraction names ${missing.slice(0, 5).join(', ')}, which the code does not contain.`
    : undefined;
}

// AI extraction for the Shopify judge (SH-A2): what a call Refit cannot read statically sends, read
// by the model from the code. Each request is kept only when extractionProblem finds nothing; the
// judge then validates it against the schema or REST contract and marks it as AI-extracted.
export async function aiExtractShopifyRequests(options: {
  file: string;
  line: number;
  kind: 'graphql' | 'rest';
  why: string;
  sources: { path: string; content: string }[];
  ai: AiOptions;
  // Sends the structured request; tests and the measurement script stand in for the API.
  request?: (
    request: Parameters<typeof requestStructuredOutput>[0],
    ai: AiOptions,
  ) => Promise<
    Pick<Awaited<ReturnType<typeof requestStructuredOutput>>, 'content' | 'model'> &
      Partial<Pick<Awaited<ReturnType<typeof requestStructuredOutput>>, 'usage' | 'budget'>>
  >;
}): Promise<ShopifyExtraction> {
  let response: Awaited<ReturnType<NonNullable<typeof options.request>>>;
  try {
    response = await (options.request ?? requestStructuredOutput)(
      {
        name: 'shopify_request_extraction',
        instructions: EXTRACT_INSTRUCTIONS,
        schema: EXTRACT_SCHEMA,
        evidence: {
          call: {
            file: options.file,
            line: options.line,
            kind: options.kind,
            unreadable: options.why,
          },
          files: options.sources,
        },
      },
      options.ai,
    );
  } catch (error) {
    if (!(error instanceof UnusableAiResponse)) throw error;
    return {
      status: 'error',
      model: options.ai.model,
      costUsd: null,
      reason: error.message,
      requests: [],
    };
  }
  let costUsd: number | null = response.budget?.costUsd ?? null;
  try {
    costUsd ??= response.usage ? usageCostUsd(response.model, response.usage) : null;
  } catch {
    // An unknown model has no price; the cost stays unknown.
  }
  const base = { model: response.model, costUsd };
  let output: {
    requests: {
      document: string;
      method: string;
      path: string;
      query: string[];
      body: string[][];
      reads: string[][];
      sourceLines: number[];
    }[];
    explanation: string;
  };
  try {
    output = JSON.parse(response.content);
  } catch {
    return { ...base, status: 'error', reason: 'The model returned no JSON.', requests: [] };
  }
  if (!output.requests.length)
    return {
      ...base,
      status: 'refused',
      reason: `The model could not read it: ${output.explanation}`,
      requests: [],
    };
  const lines =
    options.sources.find((source) => source.path === options.file)?.content.split('\n').length ?? 0;
  // Only requests the cited lines tie to this call: the model sometimes adds the file's other calls.
  const own = output.requests.filter((request) => request.sourceLines.includes(options.line));
  if (!own.length)
    return {
      ...base,
      status: 'refused',
      reason: `No extracted request cites the call's line ${options.line}.`,
      requests: [],
    };
  const requests = own.map(
    ({ document, method, path, query, body, reads, sourceLines }): ShopifyExtractedRequest =>
      options.kind === 'graphql'
        ? { document, sourceLines }
        : {
            rest: {
              method: method.toUpperCase(),
              path: path.replace(/^.*?\/admin\/api\/[^/]+\//, '').replace(/^\/+|[?#].*$/g, ''),
              query,
              body,
              reads,
            },
            sourceLines,
          },
  );
  for (const request of requests) {
    const problem = extractionProblem(request, options.sources, lines);
    if (problem) return { ...base, status: 'refused', reason: problem, requests: [] };
  }
  return { ...base, status: 'extracted', reason: output.explanation, requests };
}
