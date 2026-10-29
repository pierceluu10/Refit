import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import ts from 'typescript-compiler';
import type { AiOptions } from './ai-budget.ts';
import type { ProofCall } from './ai-request-proof.ts';
import type { RequestProof } from './ai-migrations.ts';
import type { AiRuleTable } from './ai-rules.ts';
import { changedOldLines } from './ai-surface-lane.ts';
import type { DeadlineEntry } from './deadline-registry.ts';
import { UnusableAiResponse, requestStructuredOutput } from './openai.ts';
import { NO_OP_CHECK } from './review.ts';
import { loadParser, parseWithin } from './tree-sitter.ts';

// The AI fallback (owner decision, Furqan, 2026-10-29): whenever Refit's deterministic engines
// leave a repository not fully fixed, everything they found goes to the AI: each open item with
// its stop reason, file and line, the quoted provider source, the registry's target model or SDK,
// and Refit's own partial patch. The prompt puts no limit on what the AI may edit; what keeps a
// wrong fix out is what happens after. Its patch becomes a proposed fix only when every gate below
// passes. Otherwise the row stays [Needs review] with the attempt attached as a suggestion, never
// as a claimed fix, and Refit never says the AI's code is equivalent to the old code.

export type ChangeType =
  | 'retired-model'
  | 'parameter-change'
  | 'legacy-endpoint'
  | 'old-sdk-major'
  | 'response-parsing'
  | 'beta-header'
  | 'embeddings-fine-tunes'
  | 'other';

export type OpenItemKind =
  // Model retirements (`refit deadlines --propose-model-fixes`).
  | 'model-stop'
  | 'model-unresolved'
  | 'model-alert'
  // A live registry match no lane fixed, Python included.
  | 'exposure'
  // A replacement the deterministic lane proposed whose checks failed or could not run.
  | 'model-fix-failed'
  // An SDK major stop, or a shut-down surface the AI surface lane left.
  | 'sdk-major'
  | 'review';

// One thing Refit could not fix, with what the AI and the miss record need about it.
export interface OpenItem {
  id: string;
  kind: OpenItemKind;
  provider: string;
  // The registry deadline or rule table rule the item comes from.
  ref: string;
  changeType: ChangeType;
  file: string;
  line: number;
  // The code at the site, when the engine recorded it.
  text: string;
  // Why Refit stopped.
  reason: string;
  // The registry's replacement model or the SDK's target major, when one is named.
  target: string | null;
}

export interface QuotedSource {
  ref: string;
  url: string;
  // Verbatim from the provider's page; null when Refit holds no saved quote for the ref.
  quote: string | null;
  summary: string;
}

// The fields of a benchmark row (pipeline/ai-provider-benchmark-cli.ts) that hold open items.
export interface ScanBundle {
  provider?: string;
  language?: 'js' | 'py';
  exposureSites?: Array<{
    deadline: string;
    provider: string;
    kind: string;
    replacement: string | null;
    evidence: Array<{ file: string; line: number; version: string; text: string }>;
  }>;
  replacements?: Array<{
    deadline: string;
    provider: string;
    file: string;
    line: number;
    edited?: { file: string; line: number };
    from: string;
    to: string;
    call?: string;
  }>;
  stops?: Array<{
    deadline: string;
    provider: string;
    file: string;
    line: number;
    call?: string;
    at?: { file: string; line: number };
    model?: string;
    reason: string;
  }>;
  unresolved?: Array<{
    deadline: string;
    provider: string;
    file: string;
    line: number;
    model?: string;
    to?: string | null;
    reason: string;
  }>;
  alerts?: Array<{
    deadline: string;
    provider: string;
    file: string;
    line: number;
    model?: string;
    replacement?: string | null;
    reason: string;
  }>;
  validation?: { status: string; reason?: string } | null;
  migrations?: {
    review?: Array<{
      provider?: string;
      kind?: string;
      rule: string;
      status?: string;
      breaking?: boolean;
      file: string;
      line: number;
      text?: string;
      summary?: string;
      test?: boolean;
    }>;
    proposal?: SdkStops | null;
    validation?: { status?: string; reason?: string; proposal?: SdkStops | null } | null;
    ai?: {
      status?: string;
      reason?: string;
      lane?: { stops?: Array<{ file: string; line: number; reason: string }> } | null;
    } | null;
  };
}

interface SdkStops {
  provider?: string;
  packageName?: string;
  targetMajor?: number;
  stops: Array<{ file: string; line: number; rule: string; reason: string; category?: string }>;
}

const REVIEW_CHANGE: Record<string, ChangeType> = {
  'api-surface': 'legacy-endpoint',
  'response-format': 'response-parsing',
  'beta-feature': 'beta-header',
  'sdk-major': 'old-sdk-major',
};
const EXPOSURE_CHANGE: Record<string, ChangeType> = {
  model: 'retired-model',
  sdk: 'old-sdk-major',
  method: 'legacy-endpoint',
  endpoint: 'legacy-endpoint',
  feature: 'beta-header',
};
const PARAMETER =
  /\b(?:temperature|top_p|top_k|max_tokens|max_completion_tokens|max_tokens_to_sample|functions|function_call|thinkingBudget|reasoning_effort|parameter)\b/i;
const EMBEDDING = /embed|fine[-_ ]?tun/i;

function modelChange(reason: string, model?: string): ChangeType {
  if (model && EMBEDDING.test(model)) return 'embeddings-fine-tunes';
  return PARAMETER.test(reason) ? 'parameter-change' : 'retired-model';
}

// Everything a row leaves open. A replacement whose checks passed resolves the sites it edits;
// optional upgrades (decision A) and report-only review items are not misses; test paths are
// listed by the review but are not live code.
export function openItems(bundle: ScanBundle): OpenItem[] {
  const items = new Map<string, OpenItem>();
  const add = (item: Omit<OpenItem, 'id'>) => {
    const id = `${item.kind}:${item.ref}:${item.file}:${item.line}`;
    if (!items.has(id)) items.set(id, { id, ...item });
  };
  const fixed = bundle.validation?.status === 'validated';
  for (const stop of bundle.stops ?? [])
    add({
      kind: 'model-stop',
      provider: stop.provider,
      ref: stop.deadline,
      changeType: modelChange(stop.reason, stop.model),
      file: stop.at?.file ?? stop.file,
      line: stop.at?.line ?? stop.line,
      text: stop.call ?? stop.model ?? '',
      reason: stop.reason,
      target: null,
    });
  for (const item of bundle.unresolved ?? [])
    add({
      kind: 'model-unresolved',
      provider: item.provider,
      ref: item.deadline,
      changeType: modelChange(item.reason, item.model),
      file: item.file,
      line: item.line,
      text: item.model ?? '',
      reason: item.reason,
      target: item.to ?? null,
    });
  for (const alert of bundle.alerts ?? [])
    add({
      kind: 'model-alert',
      provider: alert.provider,
      ref: alert.deadline,
      changeType: modelChange(alert.reason, alert.model),
      file: alert.file,
      line: alert.line,
      text: alert.model ?? '',
      reason: alert.reason,
      target: alert.replacement ?? null,
    });
  if (!fixed)
    for (const replacement of bundle.replacements ?? [])
      add({
        kind: 'model-fix-failed',
        provider: replacement.provider,
        ref: replacement.deadline,
        changeType: 'retired-model',
        file: replacement.edited?.file ?? replacement.file,
        line: replacement.edited?.line ?? replacement.line,
        text: `${replacement.from} → ${replacement.to}`,
        reason: bundle.validation
          ? `Refit proposed ${replacement.from} → ${replacement.to}; its checks returned ${bundle.validation.status}${bundle.validation.reason ? `: ${bundle.validation.reason}` : ''}.`
          : `Refit proposed ${replacement.from} → ${replacement.to} and could not validate it.`,
        target: replacement.to,
      });
  const migrations = bundle.migrations;
  const sdk = migrations?.validation?.proposal ?? migrations?.proposal ?? null;
  const sdkFailed =
    migrations?.validation?.status === 'validation-failed' ||
    migrations?.validation?.status === 'needs-review';
  for (const stop of sdk?.stops ?? []) {
    if (stop.category === 'optional-upgrade') continue;
    add({
      kind: 'sdk-major',
      provider: sdk?.provider ?? bundle.provider ?? '',
      ref: stop.rule,
      changeType: 'old-sdk-major',
      file: stop.file,
      line: stop.line,
      text: '',
      reason: stop.reason,
      target: sdk?.packageName ? `${sdk.packageName}@${sdk.targetMajor}` : null,
    });
  }
  if (sdk && sdkFailed && !sdk.stops.length)
    add({
      kind: 'sdk-major',
      provider: sdk.provider ?? bundle.provider ?? '',
      ref: `${sdk.packageName}-upgrade`,
      changeType: 'old-sdk-major',
      file: 'package.json',
      line: 1,
      text: '',
      reason: migrations?.validation?.reason ?? 'The SDK upgrade did not validate.',
      target: sdk.packageName ? `${sdk.packageName}@${sdk.targetMajor}` : null,
    });
  for (const finding of migrations?.review ?? []) {
    if (finding.status === 'report' || finding.test) continue;
    add({
      kind: 'review',
      provider: finding.provider ?? bundle.provider ?? '',
      ref: finding.rule,
      changeType: EMBEDDING.test(finding.rule)
        ? 'embeddings-fine-tunes'
        : (REVIEW_CHANGE[finding.kind ?? ''] ?? 'other'),
      file: finding.file,
      line: finding.line,
      text: finding.text ?? '',
      reason: finding.summary ?? 'Listed for review; no documented one-to-one mapping.',
      target: null,
    });
  }
  // A live match is open unless a validated replacement edits it or another item already names it.
  const taken = new Set([...items.values()].map((item) => `${item.file}:${item.line}`));
  const edited = new Set(
    fixed
      ? (bundle.replacements ?? []).map(
          (item) => `${item.edited?.file ?? item.file}:${item.edited?.line ?? item.line}`,
        )
      : [],
  );
  for (const exposure of bundle.exposureSites ?? [])
    for (const site of exposure.evidence) {
      const at = `${site.file}:${site.line}`;
      if (taken.has(at) || edited.has(at)) continue;
      add({
        kind: 'exposure',
        provider: exposure.provider,
        ref: exposure.deadline,
        changeType: EXPOSURE_CHANGE[exposure.kind] ?? 'other',
        file: site.file,
        line: site.line,
        text: site.text,
        reason: `A live use of ${site.version} that no Refit lane fixed.`,
        target: exposure.replacement,
      });
    }
  return [...items.values()].filter(
    (item) => !bundle.provider || item.provider === bundle.provider,
  );
}

// Outcomes Refit stands by as they are: nothing found, informational only, an upgrade that is
// available but not required (decision A), or no row to read (a crash or a failed clone).
const SETTLED = new Set([
  'unaffected',
  'report-only',
  'optional-upgrade',
  'error',
  'infrastructure',
]);

// A row goes to the fallback when Refit did not fully fix it: anything still open, whatever the
// outcome says (a validated replacement can leave other items open).
export function fallbackEligible(outcome: string, items: OpenItem[]) {
  return items.length > 0 && !SETTLED.has(outcome);
}

// Quoted sources for each item's ref: the deadline registry with the saved deprecation page's
// line (pipeline/deadline-sources.ts), else the AI rule tables' quotes (data/rules).
export function quotedSources(
  items: OpenItem[],
  context: {
    deadlines: DeadlineEntry[];
    quotes: Array<{ id: string; quotes: Record<string, string> }>;
    tables: AiRuleTable[];
    findings?: Array<{ rule: string; source?: { url: string; quote: string } }>;
  },
): QuotedSource[] {
  const sources = new Map<string, QuotedSource>();
  for (const item of items) {
    if (sources.has(item.ref)) continue;
    const entry = context.deadlines.find((deadline) => deadline.id === item.ref);
    if (entry?.source) {
      const quotes = context.quotes.find((evidence) => evidence.id === entry.id)?.quotes ?? {};
      sources.set(item.ref, {
        ref: item.ref,
        url: entry.source,
        quote: Object.values(quotes)[0] ?? null,
        summary: entry.summary,
      });
      continue;
    }
    const found = context.findings?.find((finding) => finding.rule === item.ref)?.source;
    if (found) {
      sources.set(item.ref, { ref: item.ref, url: found.url, quote: found.quote, summary: '' });
      continue;
    }
    for (const table of context.tables) {
      const rule = table.rules.find((candidate) => candidate.rule === item.ref);
      if (!rule) continue;
      sources.set(item.ref, {
        ref: item.ref,
        url: table.pages[rule.page]?.url ?? '',
        quote: rule.quote,
        summary: rule.summary,
      });
      break;
    }
  }
  return [...sources.values()];
}

export const INSTRUCTIONS = `You fix a repository that Refit, a deterministic API-migration tool, could not fully fix.
The input lists every open item Refit found ("items"): what changed at the provider, the file, line and code, and why Refit stopped. "sources" quotes the provider's own pages for each change. "targets" names the replacement model or SDK major from Refit's registry. "partial" is the patch Refit itself proposed, if any, and what happened to it. "files" holds the repository files that matter, whole.
Fix the repository so that every item is resolved and the code still works. Edit whatever the fix needs: any file shown, new files, and dependency versions in the manifest (Refit re-resolves an npm lockfile for you).
What happens to your patch: Refit installs dependencies from the lockfile, runs the repository's build, type check and tests before and after, rescans the patched code with its own engines, sends the smallest real request with each new call shape and parses the response, and checks the diff for secrets. Only a patch that passes all of it is proposed, and only as a draft a person reviews. A wrong fix is worse than none: when you cannot fix an item with confidence, leave its code as it is and say why in "unresolved".
Use a model ID only when it is a target or already in the code. Return each changed or new file whole in "files", every provider call you wrote or changed in "calls" (its path such as responses.create, messages.create or models.generateContent, and whether it streams, uses tools or asks for JSON), and a short note per item in "notes". In "patterns", describe for each item, in one sentence with no repository, file or identifier names, the general code pattern that kept Refit from fixing it.`;

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files', 'calls', 'notes', 'unresolved', 'patterns'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
    },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['call', 'stream', 'tools', 'json'],
        properties: {
          call: { type: 'string' },
          stream: { type: 'boolean' },
          tools: { type: 'boolean' },
          json: { type: 'boolean' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    unresolved: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'reason'],
        properties: { item: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'pattern'],
        properties: { item: { type: 'string' }, pattern: { type: 'string' } },
      },
    },
  },
};

// The request input is capped at 64 KiB (pipeline/openai.ts); files fill what the rest leaves.
const MAX_EVIDENCE_BYTES = 60 * 1024;
const MAX_ITEMS = 60;
const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'];

export interface FallbackInput {
  provider: string;
  language: 'js' | 'py';
  items: OpenItem[];
  sources: QuotedSource[];
  targets: Array<{ item: string; target: string }>;
  partial: Array<{ lane: string; status: string; reason: string; patch?: string | null }>;
  files: Array<{ path: string; content: string }>;
  // Files with items that did not fit the input limit; the AI cannot see them.
  omitted: string[];
}

// The request evidence: items, sources and targets first, then the files holding the most items,
// whole, while they fit. A file that does not fit is named in `omitted`, never cut.
export async function fallbackInput(options: {
  directory: string;
  provider: string;
  language: 'js' | 'py';
  items: OpenItem[];
  sources: QuotedSource[];
  partial: FallbackInput['partial'];
}): Promise<FallbackInput> {
  const items = options.items.slice(0, MAX_ITEMS);
  const input: FallbackInput = {
    provider: options.provider,
    language: options.language,
    items,
    sources: options.sources,
    targets: items
      .filter((item) => item.target)
      .map((item) => ({ item: item.id, target: item.target! })),
    partial: options.partial.map((lane) => ({
      ...lane,
      patch: lane.patch && lane.patch.length <= 12 * 1024 ? lane.patch : null,
    })),
    files: [],
    omitted: [],
  };
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.file, (counts.get(item.file) ?? 0) + 1);
  const paths = [
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([path]) => path),
    ...MANIFESTS.filter((path) => !counts.has(path)),
  ];
  let size = Buffer.byteLength(JSON.stringify(input));
  for (const path of paths) {
    if (!safePath(path)) continue;
    const content = await readFile(join(options.directory, path), 'utf8').catch(() => null);
    if (content === null) continue;
    const added = Buffer.byteLength(JSON.stringify({ path, content })) + 1;
    if (size + added > MAX_EVIDENCE_BYTES) {
      if (counts.has(path)) input.omitted.push(path);
      continue;
    }
    input.files.push({ path, content });
    size += added;
  }
  return input;
}

export function safePath(path: string) {
  const normal = normalize(path);
  return (
    Boolean(path) &&
    !path.includes('\0') &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    normal === path.replace(/^\.\//, '') &&
    !normal.split('/').includes('..') &&
    !normal.startsWith('.git/')
  );
}

export interface AiAnswer {
  files: Array<{ path: string; content: string }>;
  calls: ProofCall[];
  notes: string[];
  unresolved: Array<{ item: string; reason: string }>;
  patterns: Array<{ item: string; pattern: string }>;
}

export type GateName = 'output' | 'secrets' | 'scope' | 'resolves' | 'checks' | 'request-proof';
export interface Gate {
  gate: GateName;
  status: 'passed' | 'failed' | 'not-applicable';
  detail: string;
}

// --- Gate 1: the output is usable at all ---------------------------------------------------------

const JS = /\.(?:[cm]?[jt]sx?)$/;
const PY = /\.py$/;
const MAX_CHANGED_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024;

export async function outputGate(
  answer: AiAnswer,
  originals: Map<string, string>,
  // Paths the AI wrote that exist in the repository but were not in its input.
  unseen: Set<string> = new Set(),
): Promise<Gate> {
  const fail = (detail: string): Gate => ({ gate: 'output', status: 'failed', detail });
  const changed = answer.files.filter((file) => originals.get(file.path) !== file.content);
  if (!changed.length) return fail('The AI changed no file.');
  if (changed.length > MAX_CHANGED_FILES)
    return fail(`The AI changed ${changed.length} files, over the limit of ${MAX_CHANGED_FILES}.`);
  if (new Set(answer.files.map((file) => file.path)).size !== answer.files.length)
    return fail('The AI returned the same file twice.');
  for (const file of changed) {
    if (!safePath(file.path)) return fail(`${JSON.stringify(file.path)} is not a repository path.`);
    if (Buffer.byteLength(file.content) > MAX_FILE_BYTES)
      return fail(`${file.path} is over ${MAX_FILE_BYTES} bytes.`);
    // A file that exists but was not shown would be replaced blindly.
    if (unseen.has(file.path))
      return fail(
        `${file.path} exists but was not in the input, so the AI could not have read it.`,
      );
    if (JS.test(file.path) && !parsesAsScript(file.path, file.content))
      return fail(`${file.path} does not parse.`);
    if (PY.test(file.path) && !(await parsesAsPython(file.path, file.content)))
      return fail(`${file.path} does not parse as Python.`);
    if (file.path.endsWith('.json') && !parsesAsJson(file.content))
      return fail(`${file.path} is not valid JSON.`);
  }
  return {
    gate: 'output',
    status: 'passed',
    detail: `${changed.length} file${changed.length === 1 ? '' : 's'} changed; every one parses.`,
  };
}

function parsesAsJson(content: string) {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

export function parsesAsScript(path: string, content: string) {
  const kind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : path.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  return (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0;
}

async function parsesAsPython(path: string, content: string) {
  const parser = await loadParser('python');
  const tree = parseWithin(parser, 'python', { path, content });
  if (!('rootNode' in tree)) return false;
  const ok = !tree.rootNode.hasError;
  tree.delete();
  return ok;
}

// --- Gate 2: no secret enters the diff -----------------------------------------------------------

// Key shapes of the providers Refit proves requests against, plus common cloud and Git tokens.
const SECRET_SHAPES: Array<[string, RegExp]> = [
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ['an OpenAI-style key', /\b(?:sk|rk)-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['a GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    'a hard-coded credential',
    /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=.]{24,}["']/i,
  ],
];
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/;

// Every added line, scanned for key shapes and for the values of the keys in this process's
// environment (the AI never sees them; this proves none came back). A new .env file fails too.
export function secretGate(
  changed: Array<{ path: string; before: string | null; after: string }>,
  environment: NodeJS.ProcessEnv = process.env,
): Gate {
  const values = Object.entries(environment)
    .filter(([name, value]) => /(?:KEY|TOKEN|SECRET)$/.test(name) && (value?.length ?? 0) >= 12)
    .map(([, value]) => value!);
  for (const file of changed) {
    if (ENV_FILE.test(file.path))
      return {
        gate: 'secrets',
        status: 'failed',
        detail: `The patch writes ${file.path}, an environment file.`,
      };
    const added = addedLines(file.before ?? '', file.after);
    for (const line of added) {
      for (const [name, shape] of SECRET_SHAPES)
        if (shape.test(line))
          return {
            gate: 'secrets',
            status: 'failed',
            detail: `An added line in ${file.path} holds ${name}.`,
          };
      if (values.some((value) => line.includes(value)))
        return {
          gate: 'secrets',
          status: 'failed',
          detail: `An added line in ${file.path} holds the value of a key in Refit's environment.`,
        };
    }
  }
  return { gate: 'secrets', status: 'passed', detail: 'No key-shaped value in any added line.' };
}

function addedLines(before: string, after: string) {
  const lines = after.split('\n');
  return changedOldLines(before, after).added.map((line) => lines[line - 1] ?? '');
}

// --- Gate 3: diff scope --------------------------------------------------------------------------

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
]);
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|e2e|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$|(?:^|\/)conftest\.py$/;
const CHECK_CONFIG =
  /(?:^|\/)(?:\.github\/|\.gitlab-ci|\.circleci\/|\.refit[^/]*$|tsconfig[^/]*\.json$|jest\.config|vitest\.config|\.eslintrc|eslint\.config|pytest\.ini$|tox\.ini$|setup\.cfg$|\.husky\/)/;
const MODEL_LITERAL =
  /["'`]((?:gpt-|o\d|chatgpt-|text-|davinci|claude-|gemini-|models\/gemini-)[a-z0-9.:/-]*)["'`]/g;
const MAX_CHANGED_LINES = 600;

// The diff may change anything that is application code or a dependency version. Changes that
// would make the checks prove nothing fail here: a test, check configuration or CI file, the
// manifest's scripts, a lockfile written by hand (Refit re-resolves npm's), and a model ID that is
// neither in the repository nor the registry's target, because the request proof uses the model
// the code sends and Refit never lets an AI choose one.
export function scopeGate(
  changed: Array<{ path: string; before: string | null; after: string }>,
  context: { repositoryModels: Set<string>; targets: Set<string> },
): Gate {
  const fail = (detail: string): Gate => ({ gate: 'scope', status: 'failed', detail });
  let lines = 0;
  for (const file of changed) {
    const name = file.path.split('/').at(-1)!;
    if (LOCKFILES.has(name))
      return fail(`The patch edits ${file.path}; only Refit may re-resolve a lockfile.`);
    if (TEST_PATH.test(file.path))
      return fail(`The patch changes the test file ${file.path}, so passing tests prove nothing.`);
    if (CHECK_CONFIG.test(file.path))
      return fail(`The patch changes ${file.path}, which decides what the checks run.`);
    if (name === 'package.json' && file.before !== null && scriptsChanged(file.before, file.after))
      return fail(
        `The patch changes the scripts in ${file.path}, which decide what the checks run.`,
      );
    for (const match of file.after.matchAll(MODEL_LITERAL)) {
      const model = match[1].replace(/^models\//, '');
      if (!context.repositoryModels.has(model) && !context.targets.has(model))
        return fail(
          `The patch names the model ${model}, which is neither in the repository nor a registry target.`,
        );
    }
    const diff = changedOldLines(file.before ?? '', file.after);
    lines += diff.added.length + diff.removed.length;
  }
  if (lines > MAX_CHANGED_LINES)
    return fail(`The patch changes ${lines} lines, over the review limit of ${MAX_CHANGED_LINES}.`);
  return {
    gate: 'scope',
    status: 'passed',
    detail: `${lines} changed lines in application code and dependency versions; no test, check, CI or lockfile change; no new model ID.`,
  };
}

function scriptsChanged(before: string, after: string) {
  try {
    return (
      JSON.stringify(JSON.parse(before).scripts ?? null) !==
      JSON.stringify(JSON.parse(after).scripts ?? null)
    );
  } catch {
    return true;
  }
}

export function modelLiterals(content: string) {
  const found = new Set<string>();
  for (const match of content.matchAll(MODEL_LITERAL)) found.add(match[1].replace(/^models\//, ''));
  return found;
}

// --- Gate 4: Refit's own engines no longer find the items ----------------------------------------

// Items are compared by kind and ref per file, since the patch moves lines. The gate fails when
// any item group is still found or the patch creates a group that was not there.
export function resolvesGate(before: OpenItem[], after: OpenItem[]): Gate {
  const key = (item: OpenItem) => `${item.kind}:${item.ref}:${item.file}`;
  const was = new Set(before.map(key));
  const left = after.filter((item) => was.has(key(item)));
  const fresh = after.filter((item) => !was.has(key(item)));
  if (!left.length && !fresh.length)
    return {
      gate: 'resolves',
      status: 'passed',
      detail: `Refit's rescan of the patched code finds none of the ${before.length} open item${before.length === 1 ? '' : 's'}.`,
    };
  const sample = [...left, ...fresh]
    .slice(0, 3)
    .map((item) => `${item.file}:${item.line} ${item.ref}`)
    .join('; ');
  return {
    gate: 'resolves',
    status: 'failed',
    detail: `The rescan still finds ${left.length} of ${before.length} open items${fresh.length ? ` and ${fresh.length} new ones` : ''} (${sample}).`,
  };
}

// --- Gate 6: request and output shape -------------------------------------------------------------

const CALL =
  /\.((?:beta\.)?(?:chat\.completions|responses|messages|completions|models|embeddings|batches|files)\.(?:create|parse|stream|generateContent|generateContentStream|countTokens|embedContent))\s*\(/g;

// The call shapes a patch writes: what the AI reports, plus each provider call on an added line.
export function writtenCalls(
  answer: AiAnswer,
  changed: Array<{ path: string; before: string | null; after: string }>,
) {
  const calls = new Map<string, ProofCall>();
  for (const call of answer.calls) calls.set(call.call, call);
  for (const file of changed)
    for (const line of addedLines(file.before ?? '', file.after))
      for (const match of line.matchAll(CALL)) {
        const call = match[1].replace(/^beta\./, '');
        if (!calls.has(call))
          calls.set(call, { call, stream: /stream/i.test(line), tools: false, json: false });
      }
  return [...calls.values()];
}

export function requestProofGate(proof: RequestProof | null, language: 'js' | 'py'): Gate {
  if (!proof)
    return {
      gate: 'request-proof',
      status: 'not-applicable',
      detail: 'The patch writes no provider call and no model ID.',
    };
  const shapes = proof.calls
    .map((call) => `${call.call} ${call.status}: ${call.detail}`)
    .join('; ');
  if (proof.status === 'accepted')
    return {
      gate: 'request-proof',
      status: 'passed',
      detail: `${proof.reason}${shapes ? ` Output shape: ${shapes}` : ''}`,
    };
  return {
    gate: 'request-proof',
    status: 'failed',
    detail: `${language === 'py' ? 'Refit proves requests with the Node SDKs only, so a Python call shape stays unproven. ' : ''}${proof.status}: ${proof.reason}`,
  };
}

// --- The run -------------------------------------------------------------------------------------

// `ai-unavailable`: the provider refused Refit's own key (HTTP 401 or 403) or its quota or rate
// (429). That says nothing about the repository, so it is never a miss and never feeds a rule.
export type FallbackStatus = 'validated' | 'needs-review' | 'no-attempt' | 'ai-unavailable';

export function aiUnavailable(message: string) {
  return /\bHTTP (?:401|403|429)\b/.test(message);
}

export interface FallbackResult {
  status: FallbackStatus;
  reason: string;
  items: number;
  ai: { model: string; responseId: string; costUsd: number | null } | null;
  gates: Gate[];
  // The AI's patch: the proposed fix when validated, else attached as a suggestion only. Dropped
  // when the secret gate fails, so no secret is ever stored or shown.
  patch: string | null;
  suggestion: boolean;
  notes: string[];
  unresolved: AiAnswer['unresolved'];
  patterns: AiAnswer['patterns'];
  calls: ProofCall[];
}

export interface FallbackDependencies {
  request?: typeof requestStructuredOutput;
  // Renders the AI's files as a patch on the original checkout (plus any re-resolved lockfile).
  render: (
    files: Array<{ path: string; before: string | null; after: string }>,
  ) => Promise<{ patch: string; refusal: string | null }>;
  // Refit's engines on the patched code, as open items.
  rescan: (patch: string) => Promise<OpenItem[]>;
  // The repository's own install, build, type check and tests, before and after, offline.
  validate: (patch: string) => Promise<{
    status: string;
    command: string[];
    reason: string;
  }>;
  // A real request per call shape with Refit's key, null when there is nothing to prove.
  prove: (calls: ProofCall[], models: string[]) => Promise<RequestProof | null>;
}

export async function runAiFallback(options: {
  input: FallbackInput;
  ai: AiOptions;
  // Every model ID the repository already names, so the scope gate can tell a new one.
  repositoryModels: Set<string>;
  // Whether each file outside the input exists, for the output gate.
  exists: (path: string) => Promise<boolean>;
  environment?: NodeJS.ProcessEnv;
  dependencies: FallbackDependencies;
}): Promise<FallbackResult> {
  const { input } = options;
  const empty = {
    items: input.items.length,
    gates: [] as Gate[],
    patch: null,
    suggestion: false,
    notes: [],
    unresolved: [],
    patterns: [],
    calls: [],
  };
  if (!input.items.length)
    return { ...empty, status: 'no-attempt', reason: 'Nothing is open.', ai: null };
  if (!input.files.length)
    return {
      ...empty,
      status: 'no-attempt',
      reason: `No file with an open item fits the AI input limit (${input.omitted.join(', ')}).`,
      ai: null,
    };
  const request = options.dependencies.request ?? requestStructuredOutput;
  let answer: Awaited<ReturnType<typeof request>>;
  try {
    answer = await request(
      { name: 'refit_ai_fallback', instructions: INSTRUCTIONS, schema: SCHEMA, evidence: input },
      options.ai,
    );
  } catch (error) {
    const budget = error instanceof UnusableAiResponse ? error.budget : null;
    const message = error instanceof Error ? error.message : String(error);
    if (aiUnavailable(message))
      return {
        ...empty,
        status: 'ai-unavailable',
        reason: `AI unavailable, not a miss: ${message}`,
        ai: null,
      };
    return {
      ...empty,
      status: 'no-attempt',
      reason: `The AI request did not complete: ${error instanceof Error ? error.message : String(error)}`,
      ai: budget ? { model: options.ai.model, responseId: '', costUsd: budget.costUsd } : null,
    };
  }
  const ai = {
    model: answer.model,
    responseId: answer.responseId,
    costUsd: answer.budget?.costUsd ?? null,
  };
  let parsed: AiAnswer;
  try {
    parsed = JSON.parse(answer.content) as AiAnswer;
  } catch {
    return {
      ...empty,
      status: 'needs-review',
      reason: 'The AI answer was not valid JSON; nothing was kept.',
      ai,
      gates: [{ gate: 'output', status: 'failed', detail: 'The answer was not valid JSON.' }],
    };
  }
  const result = (status: FallbackStatus, reason: string, extra: Partial<FallbackResult>) => ({
    ...empty,
    status,
    reason,
    ai,
    notes: parsed.notes,
    unresolved: parsed.unresolved,
    patterns: parsed.patterns,
    ...extra,
  });
  const originals = new Map(input.files.map((file) => [file.path, file.content]));
  const unseen = new Set<string>();
  for (const file of parsed.files)
    if (!originals.has(file.path) && safePath(file.path) && (await options.exists(file.path)))
      unseen.add(file.path);
  const gates: Gate[] = [await outputGate(parsed, originals, unseen)];
  const stop = (reason: string, patch: string | null, extra: Partial<FallbackResult> = {}) =>
    result('needs-review', reason, { gates, patch, suggestion: patch !== null, ...extra });
  if (gates[0].status === 'failed') return stop(`AI output not kept: ${gates[0].detail}`, null);
  const changed = parsed.files
    .filter((file) => originals.get(file.path) !== file.content)
    .map((file) => ({
      path: file.path,
      before: originals.get(file.path) ?? null,
      after: file.content,
    }));
  gates.push(secretGate(changed, options.environment));
  if (gates[1].status === 'failed') return stop(`AI output not kept: ${gates[1].detail}`, null);
  const rendered = await options.dependencies.render(changed);
  const patch = rendered.patch;
  const calls = writtenCalls(parsed, changed);
  const targets = new Set(input.targets.map((item) => item.target));
  gates.push(scopeGate(changed, { repositoryModels: options.repositoryModels, targets }));
  if (rendered.refusal) gates.push({ gate: 'checks', status: 'failed', detail: rendered.refusal });
  // Every gate runs while the earlier ones pass; a failure keeps the patch as a suggestion.
  const failed = () => gates.find((gate) => gate.status === 'failed');
  if (!failed()) gates.push(resolvesGate(input.items, await options.dependencies.rescan(patch)));
  if (!failed()) {
    if (input.language === 'py')
      gates.push({
        gate: 'checks',
        status: 'failed',
        detail:
          'Refit has no offline Python install-and-test runner yet, so the patch is unchecked.',
      });
    else {
      const validation = await options.dependencies.validate(patch);
      const noOp = validation.command.join(' ') === NO_OP_CHECK;
      gates.push({
        gate: 'checks',
        status: validation.status === 'passed' && !noOp ? 'passed' : 'failed',
        detail: noOp
          ? 'No check runs the changed code.'
          : `\`${validation.command.join(' ')}\` before and after in offline Docker: ${validation.status}. ${validation.reason}`.trim(),
      });
    }
  }
  if (!failed()) {
    const models = [...changed.flatMap((file) => [...modelLiterals(file.after)])].filter((model) =>
      targets.has(model),
    );
    gates.push(
      requestProofGate(
        calls.length || models.length ? await options.dependencies.prove(calls, models) : null,
        input.language,
      ),
    );
  }
  const failure = failed();
  if (failure) return stop(`AI attempt kept as a suggestion: ${failure.detail}`, patch, { calls });
  return result(
    'validated',
    'Every gate passed: output, secrets, scope, rescan, checks and request proof.',
    { gates, patch, suggestion: false, calls },
  );
}
