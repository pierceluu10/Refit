import { usageCostUsd, type AiOptions } from './ai-budget.ts';
import type { GraphCall } from './meta-graph-calls.ts';
import { requestStructuredOutput, UnusableAiResponse } from './openai.ts';

// AI reconstruction of Graph API requests the request scan cannot read (docs/META-GRAPH.md): a URL
// that reaches no traced call, a helper whose options are not read, or a version built at runtime.
// The model reads the call site and the files it imports, and proposes each request's method,
// path, fields, metrics and parameters, and where the version is written. A proposal is kept only
// when every name in it is written in that code, it agrees with every part the scan did read, and
// its version is written on the line it names; the kept requests then go through the same change
// table, version-move stops and proof as traced ones (reconstructionProblem). The AI's word alone
// never moves a pin: the change table decides, and validation's checks grade the patch.

const INSTRUCTIONS = `You read application code that calls the Meta Graph API (graph.facebook.com or graph.instagram.com) from one call site static analysis could not resolve.
The evidence holds the site's file and line, the parts the analysis did read (null where unknown), why it could not read the rest, and the source of that file and the files it imports.
Return every Graph API request this site sends: HTTP method, path (literal segments as written, runtime node IDs as {name}, for example /{pageId}/feed), the names in the fields parameter, the names in the metric parameter, and every query or body parameter name.
Also return the Graph API version the requests send and the file and line where that version literal (such as 'v19.0' or a URL containing /v19.0) is written; use an empty version when the requests name none.
Write only what the code shows: every path segment, field, metric and parameter name must appear in that source. Keep every part the analysis already read exactly as given.
If any request, its method, path, fields or parameters depend on data the code does not show (values from callers you cannot see, a database, configuration, user input), return no requests and explain why.`;

const PART = { type: 'array', items: { type: 'string' } };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requests', 'version', 'pinFile', 'pinLine', 'explanation'],
  properties: {
    requests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'path', 'fields', 'metrics', 'parameters'],
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'DELETE'] },
          path: { type: 'string' },
          fields: PART,
          metrics: PART,
          parameters: PART,
        },
      },
    },
    version: { type: 'string' },
    pinFile: { type: 'string' },
    pinLine: { type: 'integer' },
    explanation: { type: 'string' },
  },
};

const VERSION = /^v\d+\.\d+$/;
const MAX_SOURCE = 120_000;
const MAX_REQUESTS = 12;
const RELATIVE_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

export interface ReconstructedRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  fields: string[];
  metrics: string[];
  parameters: string[];
}

export interface GraphReconstruction {
  file: string;
  line: number;
  status: 'kept' | 'refused' | 'error';
  model: string;
  costUsd: number | null;
  reason: string;
  requests?: ReconstructedRequest[];
  version?: string;
  pin?: { file: string; line: number };
}

// Whether the scan left a part of this request unread, so a reconstruction could complete it.
export function needsReconstruction(call: GraphCall) {
  return (
    call.kind === 'url' &&
    call.use === 'live' &&
    (call.client === null ||
      call.method === null ||
      call.path === null ||
      call.fields === null ||
      call.metrics === null ||
      call.parameters === null ||
      call.versionSource === 'unknown')
  );
}

// The call's file and the repository files it imports by relative path, up to MAX_SOURCE.
export function reconstructionSources(files: { path: string; content: string }[], file: string) {
  const own = files.find((entry) => entry.path === file);
  if (!own) return [];
  const directory = file.split('/').slice(0, -1);
  const imported = [...own.content.matchAll(RELATIVE_IMPORT)].flatMap((match) => {
    const parts = [...directory];
    for (const part of match[1].split('/'))
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    const base = parts.join('/').replace(/\.[cm]?[jt]sx?$/, '');
    return files.filter((entry) =>
      [base, `${base}/index`].some(
        (stem) =>
          entry.path.startsWith(stem) && /^\.[cm]?[jt]sx?$/.test(entry.path.slice(stem.length)),
      ),
    );
  });
  const sources: { path: string; content: string }[] = [];
  let size = 0;
  for (const entry of [own, ...new Set(imported)]) {
    if (size + entry.content.length > MAX_SOURCE) break;
    size += entry.content.length;
    sources.push(entry);
  }
  return sources;
}

const written = (name: string, sources: { content: string }[]) =>
  sources.some((source) =>
    new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(
      source.content,
    ),
  );

// `posts{message}` and `picture.type(large)` name posts, message, picture, type and large.
const fieldNames = (field: string) => field.match(/[A-Za-z_]\w*/g) ?? [];

const sameList = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const samePath = (a: string, b: string) => {
  const left = a.split('/').filter(Boolean);
  const right = b.split('/').filter(Boolean);
  return (
    left.length === right.length &&
    left.every((segment, index) =>
      segment.includes('{') || right[index].includes('{')
        ? segment.includes('{') === right[index].includes('{')
        : segment === right[index],
    )
  );
};

// Why a reconstruction is not acceptable, or undefined. Deterministic, whatever the model says.
export function reconstructionProblem(
  call: GraphCall,
  output: { requests: ReconstructedRequest[]; version: string; pinFile: string; pinLine: number },
  sources: { path: string; content: string }[],
) {
  if (!output.requests.length) return 'The reconstruction has no request.';
  if (output.requests.length > MAX_REQUESTS)
    return `The reconstruction lists ${output.requests.length} requests, more than ${MAX_REQUESTS}.`;
  for (const request of output.requests) {
    if (!['GET', 'POST', 'DELETE'].includes(request.method))
      return `The reconstruction sends ${request.method}.`;
    if (call.method !== null && request.method !== call.method)
      return `The reconstruction sends ${request.method}; the code sends ${call.method}.`;
    if (!request.path.startsWith('/') || /[?#\s]/.test(request.path))
      return `The reconstructed path ${request.path} is not a Graph path.`;
    if (call.path !== null && !samePath(request.path, call.path))
      return `The reconstructed path ${request.path} differs from the traced ${call.path}.`;
    const segments = request.path.split('/').filter(Boolean);
    if (segments.some((segment) => VERSION.test(segment)))
      return 'The reconstructed path holds the version.';
    const names = [
      ...segments.filter((segment) => !segment.startsWith('{')),
      ...request.fields.flatMap(fieldNames),
      ...request.metrics.flatMap(fieldNames),
      ...request.parameters,
    ];
    const missing = [...new Set(names)].filter((name) => !written(name, sources));
    if (missing.length)
      return `The reconstruction names ${missing.slice(0, 5).join(', ')}, which the code does not contain.`;
    // `fields` is sent exactly when fields are named, and `metric` when metrics are.
    if (request.parameters.includes('fields') !== request.fields.length > 0)
      return 'The reconstruction lists fields without the fields parameter, or the reverse.';
    if (request.parameters.includes('metric') !== request.metrics.length > 0)
      return 'The reconstruction lists metrics without the metric parameter, or the reverse.';
    for (const [part, traced] of [
      ['fields', call.fields],
      ['metrics', call.metrics],
      ['parameters', call.parameters],
    ] as const)
      if (traced !== null && !sameList(request[part], traced))
        return `The reconstructed ${part} differ from the traced ${part}.`;
  }
  if (call.version !== null) {
    if (output.version !== call.version)
      return `The reconstruction sends ${output.version || 'no version'}; the code pins ${call.version}.`;
    return undefined;
  }
  if (call.versionSource === 'unversioned')
    return output.version ? 'The reconstruction adds a version the URL does not name.' : undefined;
  if (!VERSION.test(output.version)) return 'The reconstruction names no version.';
  const pinned = sources.find((source) => source.path === output.pinFile);
  const text = pinned?.content.split('\n')[output.pinLine - 1];
  if (!text?.includes(output.version))
    return `${output.pinFile}:${output.pinLine} does not write ${output.version}.`;
  return undefined;
}

// AI use: a Graph request the scan cannot read is read by the model from the code, and the
// reconstruction counts only when reconstructionProblem finds nothing.
export async function aiReconstructGraphCall(options: {
  call: GraphCall;
  sources: { path: string; content: string }[];
  ai: AiOptions;
  request?: typeof requestStructuredOutput;
}): Promise<GraphReconstruction> {
  const { call } = options;
  const base = { file: call.file, line: call.line };
  let response: Awaited<ReturnType<typeof requestStructuredOutput>>;
  try {
    response = await (options.request ?? requestStructuredOutput)(
      {
        name: 'meta_graph_reconstruction',
        instructions: INSTRUCTIONS,
        schema: SCHEMA,
        evidence: {
          call: {
            file: call.file,
            line: call.line,
            text: call.text,
            read: {
              client: call.client,
              method: call.method,
              version: call.version,
              path: call.path,
              fields: call.fields,
              metrics: call.metrics,
              parameters: call.parameters,
            },
            unreadable: call.unknown,
          },
          files: options.sources,
        },
      },
      options.ai,
    );
  } catch (error) {
    if (!(error instanceof UnusableAiResponse)) throw error;
    return {
      ...base,
      status: 'error',
      model: options.ai.model,
      costUsd: null,
      reason: error.message,
    };
  }
  let costUsd: number | null = response.budget?.costUsd ?? null;
  try {
    costUsd ??= response.usage ? usageCostUsd(response.model, response.usage) : null;
  } catch {
    // An unknown model has no price; the cost stays unknown.
  }
  const answered = { ...base, model: response.model, costUsd };
  let output: {
    requests: ReconstructedRequest[];
    version: string;
    pinFile: string;
    pinLine: number;
    explanation: string;
  };
  try {
    output = JSON.parse(response.content);
  } catch {
    return { ...answered, status: 'error', reason: 'The model returned no JSON.' };
  }
  if (!Array.isArray(output.requests) || !output.requests.length)
    return { ...answered, status: 'refused', reason: `The model declined: ${output.explanation}` };
  const problem = reconstructionProblem(call, output, options.sources);
  if (problem) return { ...answered, status: 'refused', reason: problem };
  return {
    ...answered,
    status: 'kept',
    reason: output.explanation,
    requests: output.requests,
    ...(call.version === null && output.version
      ? { version: output.version, pin: { file: output.pinFile, line: output.pinLine } }
      : {}),
  };
}

// The scan's calls with each kept reconstruction applied at its site: one call per reconstructed
// request, where every part the scan read stays and the model's answer fills only what it did not.
export function applyReconstructions(calls: GraphCall[], reconstructions: GraphReconstruction[]) {
  if (!reconstructions.length) return calls;
  return calls.flatMap((call) => {
    const found = reconstructions.find(
      (item) => item.status === 'kept' && item.file === call.file && item.line === call.line,
    );
    if (!found?.requests || !needsReconstruction(call)) return [call];
    return found.requests.map((request): GraphCall => ({
      ...call,
      client: call.client ?? `ai:${found.model}`,
      method: call.method ?? request.method,
      version: call.version ?? found.version ?? null,
      versionSource: call.version === null && found.version ? 'constant' : call.versionSource,
      pin: call.pin ?? found.pin ?? null,
      path: call.path ?? request.path,
      edge:
        call.edge ??
        (() => {
          const segments = request.path.split('/').filter(Boolean);
          const last = segments.at(-1);
          return segments.length > 1 && last && !last.includes('{') ? last : null;
        })(),
      fields: call.fields ?? request.fields,
      metrics: call.metrics ?? request.metrics,
      parameters: call.parameters ?? request.parameters,
      unknown: [],
      reconstructed: found.model,
    }));
  });
}

// Every live request the scan left partly unread, reconstructed one site at a time. One ledger
// caps the spend (ai-budget.ts); there is no per-repository cap.
export async function reconstructGraphCalls(
  files: { path: string; content: string }[],
  calls: GraphCall[],
  ai: AiOptions,
  request?: typeof requestStructuredOutput,
) {
  const sites = new Map<string, GraphCall>();
  for (const call of calls.filter(needsReconstruction))
    if (!sites.has(`${call.file}:${call.line}`)) sites.set(`${call.file}:${call.line}`, call);
  const results: GraphReconstruction[] = [];
  for (const call of sites.values())
    try {
      results.push(
        await aiReconstructGraphCall({
          call,
          sources: reconstructionSources(files, call.file),
          ai,
          request,
        }),
      );
    } catch (error) {
      // An unreachable model or a spent budget leaves the scan's own result: every site not yet
      // read is recorded with the error, and the run goes on without AI.
      const reason = error instanceof Error ? error.message : String(error);
      for (const rest of [...sites.values()].slice(results.length))
        results.push({
          file: rest.file,
          line: rest.line,
          status: 'error',
          model: ai.model,
          costUsd: null,
          reason,
        });
      break;
    }
  return results;
}

// Reconstructions as they read on a patched copy: a version the patch moved at its pin is the one
// that line writes now. A line that writes no single version keeps the reconstruction's own.
export function movedReconstructions(
  reconstructions: GraphReconstruction[],
  repository: { files: { path: string; content: string }[] },
) {
  return reconstructions.map((item) => {
    if (!item.version || !item.pin) return item;
    const text = repository.files.find((file) => file.path === item.pin!.file)?.content.split('\n')[
      item.pin.line - 1
    ];
    const versions = [...new Set(text?.match(/v\d+\.\d+(?![\w.])/g) ?? [])];
    return versions.length === 1 ? { ...item, version: versions[0] } : item;
  });
}
