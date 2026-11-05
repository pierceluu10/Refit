// The dead-API scan: plain code that joins a repo's text to the list and says, for each hit, how it's
// used and why. Nothing here runs repo code or follows a symlink, because a rescan reads a working copy
// that untrusted code wrote. See docs/rebuild/PIERCE.md, P4.
import path from 'node:path';
import {
  DATA_DIR,
  entriesInForce,
  loadDeadApis,
  readProviderFiles,
  type DeadApiList,
} from '../dead-apis/list.ts';
import {
  escapeRegex,
  requiredLiterals,
  tokenMatches,
  tokensOf,
  urlMatches,
} from '../dead-apis/match.ts';
import { PROPOSED_DIR, providerId, utcDay } from '../dead-apis/proposals.ts';
import { enqueueUnlisted } from '../dead-apis/queue.ts';
import { redactSecrets } from '../harness/secrets.ts';
import type {
  DeadApiEntry,
  DeadApiMatcher,
  Finding,
  MatchClass,
  ProviderHints,
  ScanRepo,
  ScanResult,
} from '../shared/types.ts';
import { catalogEntry, dependencyProvider } from './catalog.ts';
import {
  besideReplacement,
  bindingsOf,
  fieldReads,
  readEvidence,
  type Binding,
  type FieldRead,
  type FileBindings,
} from './dead-scan-fields.ts';
import {
  innerText,
  lineIndexAt,
  modeOf,
  reportedLine,
  spanAt,
  toSource,
  type FileMode,
  type Source,
  type Span,
} from './dead-scan-lex.ts';
import { calledProviders, namedProviders } from './dead-scan-hosts.ts';
import {
  closeOf,
  enclosing,
  holdsOptionTag,
  isGraphqlText,
  isProse,
  stringPlace,
  textPlace,
  type Place,
} from './dead-scan-place.ts';
import {
  holderReads,
  reachOf,
  recordPicker,
  webhookRegistrations,
  type Readers,
} from './dead-scan-reach.ts';
import { gateFor, loadVersionFacts, type VersionFacts } from './dead-scan-version.ts';
import { OutsideRepoError, readText, walkFiles } from './repo-files.ts';
import { isSecretEnvFile, scanRepo } from './scan.ts';
import { listManifests, type Manifest } from './scanners.ts';

export type FindingDetail = Finding & {
  provider: string;
  what: string;
  reason: string;
  text: string;
  /** Goes to a fix: a live finding, or a catalog hit of a provider that has a live finding. */
  withFix: boolean;
  /** A vendored tool or build output: never reaches a fix. */
  vendored?: boolean;
  /** The scan or the AI check says this isn't a break to fix: it stays out of a fix. */
  ruledOut?: boolean;
  /** Where the code reads what holds this value, so the AI check can see where it goes. */
  reads?: string[];
  /** The list's own words for what counts and what doesn't, for the AI check to go by. */
  lookFor?: string[];
};

export type SkippedFile = { file: string; reason: string };

export type QuietHit = {
  entryId: string;
  provider: string;
  file: string;
  line: number;
  reason: string;
  version?: string;
};

export type CheckOutcome = {
  outcome: 'none' | 'checked' | 'failed' | 'capped';
  costUsd: number;
  asked: number;
  error?: string;
};

export type DeadScanReport = ScanResult & {
  repo: string;
  today: string;
  listVersion: string;
  details: FindingDetail[];
  quiet: QuietHit[];
  /** Files the scan didn't read or read in part, so a clean result says nothing about them. */
  skipped: SkippedFile[];
  filesRead: number;
  seconds: number;
  check?: CheckOutcome;
};

export type DeadScanOptions = {
  today?: string;
  list?: DeadApiList;
  dataDir?: string;
  /** The folder holding the unlisted-provider queue. Without it nothing is enqueued. */
  storeDir?: string;
};

type Context = DeadApiEntry['context'];

type Hit = {
  entry: DeadApiEntry;
  matcher: DeadApiMatcher;
  source: Source;
  offset: number;
  name: string; // the text matched
  read?: FieldRead & { binding?: Binding };
};

type Classed = {
  matchClass: MatchClass;
  reason: string;
  version?: string;
  vendored?: boolean;
  ruledOut?: boolean;
  reads?: string[];
  unclearIfAlone?: boolean;
};
type Verdict = Classed | { quiet: true; reason: string; version?: string };

type Repo = {
  sources: Source[];
  entries: DeadApiEntry[];
  readers: Readers;
  manifests: Manifest[];
  versions: VersionFacts;
  presence: Map<string, boolean>;
  fileNames: Map<string, boolean>;
  bindings: Map<string, FileBindings>;
  /** Folders a deploy config serves as the site, so a docs/ page there runs. */
  published: string[];
};

// Dot folders that hold an installed agent tool or a tool's output. Any other dot folder is the repo's
// own, such as .github, .config or .vitepress, and is read like the rest of it.
const VENDORED_DOT_FOLDERS = new Set([
  '.agent',
  '.agents',
  '.aider',
  '.augment',
  '.aws-sam',
  '.claude',
  '.cline',
  '.codex',
  '.continue',
  '.cursor',
  '.docusaurus',
  '.expo',
  '.gemini',
  '.kiro',
  '.opencode',
  '.output',
  '.parcel-cache',
  '.pnpm',
  '.roo',
  '.serverless',
  '.terraform',
  '.vercel',
  '.windsurf',
  '.wrangler',
  '.yarn',
]);
const TEST_PATH =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|mocks?|fixtures?|e2e|cypress|testdata|test-data)\/|\.(?:test|spec|stories|story|mock|fixture|e2e)\.\w+$|(?:^|\/)test_[^/]+$|_test\.\w+$|(?:^|\/)conftest\.py$/i;
// Words that mean samples at a project's top, and are usually a feature under src/.
const SAMPLE_PATH = /(?:^|\/)(?:stories|examples?|samples?|docs?|documentation)\//i;
const SOURCE_FOLDER = /(?:^|\/)src\//;
// An API route is deployed, whatever its name: app/api/test/route.ts.
const API_ROUTE = /(?:^|\/)(?:app|pages)\/(?:.*\/)?api\//;
// What a host serves as the site. docs/ and examples/ are samples, unless one of these says it's the app.
const PUBLISH_SETTINGS: { name: RegExp; setting: RegExp }[] = [
  { name: /^vercel\.json$/, setting: /"outputDirectory"\s*:\s*"([^"]+)"/ },
  { name: /^netlify\.toml$/, setting: /\bpublish\s*=\s*"([^"]+)"/ },
  { name: /^firebase\.json$/, setting: /"public"\s*:\s*"([^"]+)"/ },
];
const MINIFIED_NAME = /[.-]min\.\w+$|[.-]bundle\.\w+$|\.map$/;
const TYPE_DECLARATIONS = /\.d\.[cm]?ts$/;
const SAVED_COOKIE_KEY = /"httpOnly"\s*:/;
const GENERATED_HEAD = /@generated\b|\bDO NOT EDIT\b|__commonJS\b|__create = Object\.create\b/;
const GENERATED_TAIL = /[#@] sourceMappingURL=/;
const GENERATED_HEAD_CHARS = 2_000;
// A whole repo packed into one file for an AI tool: a copy of code that lives elsewhere, and never runs.
const PACKED_HEAD = /\b(?:merged|packed) representation of\b/i;
const PACKED_FILE_TAG = /<file path="/g;
const MIN_PACKED_FILES = 3;
const GENERATED_TAIL_CHARS = 500;
const MINIFIED_MIN_BYTES = 5_000;
const MINIFIED_MEDIAN_LINE = 500;
// Lexing and field walks slow down with line length, so past these a line is cut. Line numbers survive.
const MAX_LINE_CHARS = 4_000;
const MAX_DATA_LINE_CHARS = 100_000;
// Every file read stays in memory until the scan ends, and the rest of a bigger repo is reported skipped.
const MAX_TOTAL_TEXT_CHARS = 200_000_000;
const LOCK_NAME =
  /(?:^|\/)(?:[\w.-]+\.lock|go\.sum|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|gradle\.lockfile|packages\.lock\.json)$/;
const MAX_TEXT_CHARS = 160;
const XML_EXTENSION = '.xml';
const CODE_MODES: ReadonlySet<FileMode> = new Set(['js', 'python', 'clike', 'php', 'ruby', 'html']);
const URL_IN_LINE = /https?:\/\/[^\s'"`<>)]+/g;
const BASE_URL_LINE = /base.?url|endpoint|api.?url|api.?base/i;
const POINTS_A_CLIENT = /base.?url|endpoint|api.?url|api.?base|AzureOpenAI\s*\(/i;
// `delete x.field`, `del x["field"]`, `unset($x['field'])`, and `x.pop("field")` standing alone.
const STRIPS_FIELD =
  /(?:^|[\s;{(])(?:delete|del)\s+[\w$.?!\[\]'"-]*$|\bunset\(\s*[$\w.\[\]'">-]*$|^\s*[$\w.\[\]'"@>-]+\.(?:pop|delete)\(\s*[:'"]?$/;
// Shopify's own config for an extension. Its api_version moves with @shopify/ui-extensions, as SH-1 says.
const EXTENSION_CONFIG = 'shopify.extension.toml';
const UI_EXTENSION_TYPE = /^\s*type\s*=\s*"\w*ui_extension"/m;
const API_VERSION_SETTING = /^\s*api_version\s*=/;
// Shopify's app config. Its [webhooks] api_version sets the version of the subscriptions the file declares.
const APP_CONFIG = /^shopify\.app(?:\.[\w-]+)?\.toml$/;
const TOML_TABLE = /^\s*\[/;
const WEBHOOKS_TABLE = /^\s*\[webhooks\]/;
const DECLARES_SUBSCRIPTION = /^\s*(?:\[\[\s*webhooks\.subscriptions\s*\]\]|subscriptions\s*=)/m;
// GraphQL's editor and codegen config: dev scripts read these, and nothing runs them in production.
const GRAPHQL_TOOL_CONFIG = /^(?:\.graphqlrc(?:\.\w+)?|graphql\.config\.\w+)$/;
const CODEGEN_CONFIG = /^(?:graphql-)?codegen(?:\.[\w-]+)*\.(?:[cm]?[jt]s|ya?ml|json)$/;
const CODEGEN_SIGN = /\bgenerates\b/;
const MAX_REGISTRATIONS_SHOWN = 5;
const CLASS_RANK: Record<MatchClass, number> = {
  live: 4,
  unclear: 3,
  catalog: 2,
  test: 1,
  comment: 0,
};

// A line or file that clearly targets another host: the same name there isn't this provider's model.
const OTHER_HOSTS: { name: string; pattern: RegExp; lineOnly?: boolean }[] = [
  { name: 'Azure OpenAI', pattern: /\bazure\b|AzureOpenAI|azure_openai|\.openai\.azure\.com/i },
  { name: 'Amazon Bedrock', pattern: /\bbedrock\b|\banthropic\.claude-/i },
  { name: 'Google Vertex AI', pattern: /\bvertex(?:[_-]?ai)?\b|aiplatform\.googleapis/i },
  { name: 'Cloudflare Workers AI', pattern: /@cf\/|@hf\/|\bworkers\.?ai\b/i },
  { name: 'Together', pattern: /together\.(?:xyz|ai)|togethercomputer/i },
  { name: 'OpenRouter', pattern: /openrouter/i },
  { name: 'Ollama', pattern: /\bollama\b|:11434\b/i },
  { name: 'NVIDIA', pattern: /\bnvidia\b/i },
  // Only on the line: a file with a localhost URL is usually just talking to the app's own backend.
  { name: 'a local base URL', pattern: /\blocalhost\b|127\.0\.0\.1|0\.0\.0\.0/, lineOnly: true },
];

const dotFolderOf = (file: string) =>
  file
    .split('/')
    .slice(0, -1)
    .find((segment) => VENDORED_DOT_FOLDERS.has(segment));

const isTestPath = (file: string) =>
  !API_ROUTE.test(file) &&
  (TEST_PATH.test(file) || (SAMPLE_PATH.test(file) && !SOURCE_FOLDER.test(file)));

function publishedFolders(sources: Source[]): string[] {
  return sources.flatMap((source) => {
    const name = path.posix.basename(source.file);
    const folder = PUBLISH_SETTINGS.find((one) => one.name.test(name))?.setting.exec(
      source.text,
    )?.[1];
    return folder ? [path.posix.join(path.posix.dirname(source.file), folder)] : [];
  });
}

/** Paths whose versions and manifests don't speak for the app: tests and vendored tools. */
const isIgnoredForFacts = (file: string) => isTestPath(file) || dotFolderOf(file) !== undefined;

type NotebookCell = { cell_type?: unknown; source?: unknown };

function notebookSource(file: string, raw: string): Source | undefined {
  let cells: unknown;
  try {
    cells = (JSON.parse(raw) as { cells?: unknown } | null)?.cells;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!Array.isArray(cells)) return undefined;
  const rawLines = raw.split('\n');
  const lineMap: number[] = [];
  const code: string[] = [];
  let cursor = 0;
  for (const cell of cells as (NotebookCell | null)[]) {
    if (cell?.cell_type !== 'code') continue;
    const body = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    if (typeof body !== 'string') continue;
    for (const line of body.split('\n')) {
      const needle = JSON.stringify(line).slice(1, -1);
      const found = rawLines.findIndex((one, index) => index >= cursor && one.includes(needle));
      if (found !== -1) cursor = found;
      lineMap.push(cursor);
      code.push(line);
    }
  }
  return toSource(file, code.join('\n'), 'python', lineMap);
}

// By the median, so one long line in a hand-written file, such as a logo, doesn't hide the file.
function isMinified(text: string): boolean {
  if (text.length <= MINIFIED_MIN_BYTES) return false;
  const lengths = text
    .split('\n')
    .map((line) => line.length)
    .filter((length) => length > 0)
    .sort((a, b) => a - b);
  return lengths[(lengths.length - 1) >> 1] > MINIFIED_MEDIAN_LINE;
}

const isPackedDump = (file: string, text: string) =>
  PACKED_HEAD.test(text.slice(0, GENERATED_HEAD_CHARS)) ||
  (file.endsWith(XML_EXTENSION) && (text.match(PACKED_FILE_TAG)?.length ?? 0) >= MIN_PACKED_FILES);

const isGenerated = (file: string, text: string, files: Set<string>) =>
  TYPE_DECLARATIONS.test(file) ||
  files.has(`${file}.map`) ||
  isPackedDump(file, text) ||
  GENERATED_HEAD.test(text.slice(0, GENERATED_HEAD_CHARS)) ||
  GENERATED_TAIL.test(text.slice(-GENERATED_TAIL_CHARS));

const cutLongLines = (text: string, limit: number) =>
  text.replace(new RegExp(`[^\\n]{${limit + 1},}`, 'g'), (line) => line.slice(0, limit));

// A vanished, unreadable or redirected file is skipped: the working copy can change under a rescan.
export async function readSafely(repoDir: string, file: string): Promise<string | undefined> {
  return readText(repoDir, file).catch((error: NodeJS.ErrnoException) => {
    if (error instanceof OutsideRepoError || error.code === 'ENOENT' || error.code === 'ELOOP') {
      return undefined;
    }
    throw error;
  });
}

function toScanned(
  file: string,
  text: string,
  mode: FileMode,
  files: Set<string>,
): Source | undefined {
  const source =
    mode === 'notebook'
      ? notebookSource(file, text)
      : toSource(
          file,
          cutLongLines(text, mode === 'json' ? MAX_DATA_LINE_CHARS : MAX_LINE_CHARS),
          mode,
        );
  return source && { ...source, generated: isGenerated(file, text, files) };
}

async function readSources(
  repoDir: string,
): Promise<{ sources: Source[]; skipped: SkippedFile[] }> {
  const sources: Source[] = [];
  const skipped: SkippedFile[] = [];
  const files: string[] = [];
  for await (const file of walkFiles(repoDir)) files.push(file);
  const present = new Set(files);
  let totalChars = 0;
  for (const file of files) {
    const mode = modeOf(file);
    const name = path.posix.basename(file);
    if (!mode || isSecretEnvFile(name) || LOCK_NAME.test(file)) continue;
    if (MINIFIED_NAME.test(name)) {
      skipped.push({ file, reason: 'minified, by its name' });
      continue;
    }
    if (totalChars > MAX_TOTAL_TEXT_CHARS) {
      skipped.push({ file, reason: 'the repo is past the amount of text one scan holds' });
      continue;
    }
    const text = await readSafely(repoDir, file);
    if (text === undefined) {
      skipped.push({ file, reason: 'binary, oversized or unreadable' });
      continue;
    }
    if (CODE_MODES.has(mode) && isMinified(text)) {
      skipped.push({ file, reason: 'minified' });
      continue;
    }
    try {
      const source = toScanned(file, text, mode, present);
      if (source) {
        sources.push(source);
        totalChars += source.text.length;
        if (source.text.length < text.length && mode !== 'notebook') {
          skipped.push({ file, reason: 'read in part: some lines are too long' });
        }
      }
    } catch (error) {
      // Templates nested past the stack: a crafted file can't end the scan for the rest of the repo.
      if (!(error instanceof RangeError)) throw error;
      skipped.push({ file, reason: 'nested too deeply to read' });
    }
  }
  return { sources, skipped };
}

const contextKey = (context: Context) => JSON.stringify(context ?? {});

const namesPatterns = new Map<string, RegExp>();

function namesPattern(context: NonNullable<Context>): RegExp {
  const key = contextKey(context);
  let pattern = namesPatterns.get(key);
  if (!pattern) {
    const terms = [...(context.hosts ?? []), ...(context.packages ?? [])];
    const all = terms.flatMap((term) => [term, term.replace(/-/g, '_')]);
    pattern = new RegExp(`(?<![\\w-])(?:${all.map(escapeRegex).join('|')})(?![\\w-])`, 'i');
    namesPatterns.set(key, pattern);
  }
  return pattern;
}

function fileNamesProvider(repo: Repo, source: Source, context: NonNullable<Context>): boolean {
  const key = `${source.file}|${contextKey(context)}`;
  let found = repo.fileNames.get(key);
  if (found === undefined) {
    found = namesPattern(context).test(source.text);
    repo.fileNames.set(key, found);
  }
  return found;
}

function importPattern(name: string, mode: Source['mode']): RegExp {
  const names = [name, name.replace(/-/g, '_')].map(escapeRegex).join('|');
  if (mode === 'python') {
    return new RegExp(`^[ \\t]*(?:from|import)[ \\t]+(?:${names})(?![\\w-])`, 'gm');
  }
  // Also the specifier forms of Deno and edge functions: npm:stripe@18 and https://esm.sh/stripe@18?x=y.
  return new RegExp(
    `(?:\\bfrom\\s+|\\bimport\\s+|\\brequire\\(?\\s*|\\bimport\\(\\s*)["'\`](?:npm:|jsr:|https?://[^"'\`\\s]*/)?(?:${names})(?:@[\\w.^~-]+)?(?:/[\\w./-]*)?(?:\\?[^"'\`]*)?["'\`]`,
    'g',
  );
}

const importsPackage = (source: Source, name: string) =>
  importPattern(name, source.mode).test(source.text);

const normalPackage = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

function repoHasProvider(repo: Repo, context: NonNullable<Context>): boolean {
  const key = contextKey(context);
  const known = repo.presence.get(key);
  if (known !== undefined) return known;
  const packages = (context.packages ?? []).map(normalPackage);
  const hosts = (context.hosts ?? []).map((host) => host.toLowerCase());
  const inManifest = repo.manifests.some((manifest) =>
    manifest.dependencies.some((one) => packages.includes(normalPackage(one.name))),
  );
  const present =
    inManifest ||
    repo.sources.some(
      (source) =>
        !isIgnoredForFacts(source.file) &&
        source.mode !== 'prose' &&
        (hosts.some((host) => source.lower.includes(host)) ||
          (context.packages ?? []).some((name) => importsPackage(source, name))),
    );
  repo.presence.set(key, present);
  return present;
}

function bindingsFor(repo: Repo, source: Source, provider: string): FileBindings {
  const key = `${provider}|${source.file}`;
  let bindings = repo.bindings.get(key);
  if (!bindings) {
    bindings = bindingsOf(source, provider.toLowerCase());
    repo.bindings.set(key, bindings);
  }
  return bindings;
}

// ---- Matching ----

const literalOf = (matcher: DeadApiMatcher): string | undefined => {
  if (matcher.kind === 'regex') return undefined;
  const parts = matcher.value.split('*');
  return parts.reduce((longest, part) => (part.length > longest.length ? part : longest), '');
};

type CompiledRegex = { regex: RegExp; literals?: string[] };
const compiledRegexes = new Map<string, CompiledRegex>();

function compiledRegex(value: string): CompiledRegex {
  let compiled = compiledRegexes.get(value);
  if (!compiled) {
    compiled = { regex: new RegExp(value, 'g'), literals: requiredLiterals(value) };
    compiledRegexes.set(value, compiled);
  }
  return compiled;
}

const couldHold = (source: Source, matcher: DeadApiMatcher) => {
  if (matcher.kind === 'regex') {
    const { literals } = compiledRegex(matcher.value);
    return !literals || literals.some((literal) => source.text.includes(literal));
  }
  const literal = literalOf(matcher);
  if (literal === undefined) return true;
  const caseless =
    matcher.kind === 'url' || (matcher.kind === 'string' && matcher.caseSensitive === false);
  return caseless ? source.lower.includes(literal.toLowerCase()) : source.text.includes(literal);
};

type Region = { lineIndex: number; offset: number; text: string };

// Where a name can sit as one line each: strings, comments, config text, and JSX option text.
function regionsOf(source: Source): Region[] {
  const regions: Region[] = [];
  for (const span of source.spans) {
    const first = lineIndexAt(source, span.innerStart);
    const parts = source.text.slice(span.innerStart, span.innerEnd).split('\n');
    parts.forEach((text, index) => {
      if (!text.trim()) return;
      const offset = index === 0 ? span.innerStart : source.lineStarts[first + index];
      regions.push({ lineIndex: first + index, offset, text });
    });
  }
  const code = source.code.split('\n');
  code.forEach((text, lineIndex) => {
    if (!text.trim()) return;
    const textIsRead = source.mode === 'hash' || source.file.endsWith(XML_EXTENSION);
    if (textIsRead || holdsOptionTag(source.lines[lineIndex], source.mode)) {
      regions.push({ lineIndex, offset: source.lineStarts[lineIndex], text });
    }
  });
  return regions;
}

function nameHits(
  source: Source,
  regions: Region[],
  entry: DeadApiEntry,
  matcher: Extract<DeadApiMatcher, { kind: 'string' | 'url' }>,
): Hit[] {
  const hits: Hit[] = [];
  const literal = (literalOf(matcher) ?? '').toLowerCase();
  for (const region of regions) {
    if (!region.text.toLowerCase().includes(literal)) continue;
    const at = region.text.toLowerCase().indexOf(literal);
    // The whole token, so a place check sees all of openai/gpt-4 and not gpt-4 inside it.
    const token =
      matcher.kind === 'string'
        ? tokensOf(region.text).find((one) => tokenMatches(matcher, one))
        : undefined;
    const isHit =
      matcher.kind === 'string' ? token !== undefined : urlMatches(matcher, region.text);
    if (!isHit) continue;
    const name = token ?? region.text.slice(at, at + literal.length);
    const start = token ? region.text.indexOf(token) : at;
    hits.push({ entry, matcher, source, offset: region.offset + Math.max(0, start), name });
  }
  return hits;
}

function regexHits(
  source: Source,
  entry: DeadApiEntry,
  matcher: Extract<DeadApiMatcher, { kind: 'regex' }>,
): Hit[] {
  return [...source.text.matchAll(compiledRegex(matcher.value).regex)].map((match) => ({
    entry,
    matcher,
    source,
    offset: match.index,
    name: match[0],
  }));
}

function packageImportHits(
  source: Source,
  entry: DeadApiEntry,
  matcher: Extract<DeadApiMatcher, { kind: 'package' }>,
): Hit[] {
  const wrongEcosystem =
    matcher.ecosystem !== undefined &&
    (matcher.ecosystem === 'python') !== (source.mode === 'python');
  if (wrongEcosystem) return [];
  return [...source.text.matchAll(importPattern(matcher.value, source.mode))].map((match) => ({
    entry,
    matcher,
    source,
    offset: match.index,
    name: matcher.value,
  }));
}

function hitsIn(repo: Repo, source: Source, entries: DeadApiEntry[]): Hit[] {
  const hits: Hit[] = [];
  let regions: Region[] | undefined;
  for (const entry of entries) {
    for (const matcher of entry.matchers) {
      if (!couldHold(source, matcher)) continue;
      if (matcher.kind === 'string' || matcher.kind === 'url') {
        regions ??= regionsOf(source);
        hits.push(...nameHits(source, regions, entry, matcher));
      } else if (matcher.kind === 'regex') {
        hits.push(...regexHits(source, entry, matcher));
      } else if (matcher.kind === 'package') {
        hits.push(...packageImportHits(source, entry, matcher));
      } else {
        const bindings = bindingsFor(repo, source, entry.provider);
        for (const read of fieldReads(source, matcher, entry, bindings)) {
          hits.push({ entry, matcher, source, offset: read.offset, name: matcher.value, read });
        }
      }
    }
  }
  return hits;
}

// ---- Judging ----

// Code that names something dead without depending on it, so a fix has nothing to do there.
function harmlessUse({ source, entry, matcher, offset, read }: Hit): string | undefined {
  const lineIndex = lineIndexAt(source, offset);
  if (
    path.posix.basename(source.file) === EXTENSION_CONFIG &&
    API_VERSION_SETTING.test(source.lines[lineIndex]) &&
    UI_EXTENSION_TYPE.test(source.text)
  ) {
    return "a UI extension's own version: older ones keep working, and Shopify CLI only refuses to deploy one past 12 months";
  }
  if (STRIPS_FIELD.test(source.text.slice(source.lineStarts[lineIndex], offset))) {
    return 'code that strips the field, which is not a use of it';
  }
  if (matcher.kind === 'field' && read && besideReplacement(source, entry, matcher, read)) {
    return 'the replacement is read here or right beside it, so this handles the new shape';
  }
  return undefined;
}

function isGraphqlToolConfig(source: Source): boolean {
  const name = path.posix.basename(source.file);
  return (
    GRAPHQL_TOOL_CONFIG.test(name) || (CODEGEN_CONFIG.test(name) && CODEGEN_SIGN.test(source.text))
  );
}

// An app config's webhook version with no subscription in that file to apply to.
function isUnsubscribedWebhookVersion({ source, offset }: Hit): boolean {
  const lineIndex = lineIndexAt(source, offset);
  if (
    !APP_CONFIG.test(path.posix.basename(source.file)) ||
    !API_VERSION_SETTING.test(source.lines[lineIndex]) ||
    DECLARES_SUBSCRIPTION.test(source.text)
  ) {
    return false;
  }
  const table = source.lines
    .slice(0, lineIndex)
    .reverse()
    .find((line) => TOML_TABLE.test(line));
  return table !== undefined && WEBHOOKS_TABLE.test(table);
}

// A browser session saved to JSON for a test run, as Playwright and Puppeteer write it.
function isSavedCookie(source: Source, offset: number): boolean {
  if (source.mode !== 'json') return false;
  const record = enclosing(source.code, offset);
  return (
    record?.char === '{' &&
    SAVED_COOKIE_KEY.test(source.text.slice(record.open, closeOf(source.code, record.open)))
  );
}

function placeOf(hit: Hit, span: Span | undefined, repo: Repo): Classed | Place | undefined {
  const { source, entry, name, offset } = hit;
  const dotFolder = dotFolderOf(source.file);
  if (dotFolder) {
    return {
      matchClass: 'catalog',
      vendored: true,
      reason: `in ${dotFolder}, a dot folder holding a vendored tool`,
    };
  }
  if (source.generated) {
    return {
      matchClass: 'catalog',
      vendored: true,
      reason:
        'build output, type declarations or a packed copy of the repo, which a fix never edits',
    };
  }
  if (source.mode === 'prose') return { matchClass: 'comment', reason: 'prose, not code' };
  if (span?.kind === 'comment') return { matchClass: 'comment', reason: 'in a comment' };
  const served = repo.published.some((folder) => source.file.startsWith(`${folder}/`));
  if (isTestPath(source.file) && !served) {
    return { matchClass: 'test', reason: 'a test, fixture, example or docs path' };
  }
  if (isSavedCookie(source, offset)) {
    return {
      matchClass: 'catalog',
      ruledOut: true,
      reason: 'a saved browser cookie, read by nothing',
    };
  }
  const harmless = harmlessUse(hit);
  if (harmless) return { matchClass: 'catalog', ruledOut: true, reason: harmless };
  // Not ruled out: these repeat a pin, so they change along with the real one in a fix.
  if (isGraphqlToolConfig(source)) {
    return {
      matchClass: 'catalog',
      reason: 'GraphQL tooling config: only a dev script reads it, nothing runs it in production',
    };
  }
  if (isUnsubscribedWebhookVersion(hit) && webhookRegistrations(repo.readers).length === 0) {
    return {
      matchClass: 'catalog',
      reason:
        'this file declares no [[webhooks.subscriptions]] and the code registers none, so no webhook arrives at this version',
    };
  }
  if (hit.matcher.kind === 'field' || hit.matcher.kind === 'package') return undefined;
  if (span?.kind === 'string' && offset + name.length <= span.end) {
    if (isProse(source, span, name, offset)) {
      return { matchClass: 'comment', reason: 'named inside a longer prose string' };
    }
    return stringPlace(source, span, entry.provider);
  }
  if (!span && hit.matcher.kind === 'string') {
    return textPlace(source.lines[lineIndexAt(source, offset)], name, entry.provider);
  }
  return undefined;
}

type OtherHosts = { byPath?: string; pointed?: string; named?: string };
const otherHostsBySource = new WeakMap<Source, OtherHosts>();

function otherHostsOf(source: Source): OtherHosts {
  const known = otherHostsBySource.get(source);
  if (known) return known;
  const others = OTHER_HOSTS.filter((host) => !host.lineOnly);
  const named = others.filter((host) => host.pattern.test(source.text));
  const pointing = source.lines.filter((one) => POINTS_A_CLIENT.test(one));
  const urlHosts = new Set(
    pointing.flatMap((one) => [...one.matchAll(URL_IN_LINE)].map((url) => url[0].split('/')[2])),
  );
  // Several base URLs or hosts in one file make a registry of providers, whose lines each speak for themselves.
  const oneClient = named.length === 1 && urlHosts.size <= 1;
  const found: OtherHosts = {
    byPath: others.find((host) => host.pattern.test(source.file))?.name,
    pointed:
      oneClient && pointing.some((one) => named[0].pattern.test(one)) ? named[0].name : undefined,
    named: named[0]?.name,
  };
  otherHostsBySource.set(source, found);
  return found;
}

function otherHostReason(hit: Hit, repo: Repo, line: string, offered: boolean): string | undefined {
  const { context } = hit.entry;
  if (!context) return undefined;
  // azure-keyvault's own lines say azure, and that isn't another host to it.
  if (OTHER_HOSTS.some((host) => host.pattern.test(hit.entry.provider))) return undefined;
  const hosts = context.hosts ?? [];
  const lineHost = OTHER_HOSTS.find((host) => host.pattern.test(line));
  if (lineHost && !hosts.some((host) => line.toLowerCase().includes(host))) {
    return `the line targets ${lineHost.name}`;
  }
  const { source } = hit;
  if (hosts.some((host) => source.lower.includes(host))) return undefined;
  const { byPath, pointed, named } = otherHostsOf(source);
  if (byPath) return `the file is for ${byPath}`;
  // Naming the SDK doesn't help here: an OpenAI client is often pointed at OpenRouter or Azure.
  if (pointed) return `the file points a client at ${pointed}`;
  if (fileNamesProvider(repo, source, context)) return undefined;
  // A row users pick, in the provider's own spelling and not a gateway's vendor/name: it goes to the provider.
  if (offered && !hit.name.includes('/')) return undefined;
  return named ? `the file targets ${named} and never names the provider` : undefined;
}

// The hit sits inside a URL on another host: https://api.pexels.com/v1/search isn't OpenAI's /v1/search.
function foreignUrlHost(hit: Hit, lineStart: number, line: string): string | undefined {
  const hosts = hit.entry.context?.hosts ?? [];
  if (hosts.length === 0) return undefined;
  const at = hit.offset - lineStart;
  for (const url of line.matchAll(URL_IN_LINE)) {
    if (at < url.index || at >= url.index + url[0].length) continue;
    const lower = url[0].toLowerCase();
    return hosts.some((host) => lower.includes(host)) ? undefined : url[0];
  }
  return undefined;
}

function hostOnLineOrBaseUrl(hit: Hit, line: string): boolean {
  const hosts = (hit.entry.context?.hosts ?? []).map((host) => host.toLowerCase());
  const lower = line.toLowerCase();
  if (hosts.some((host) => lower.includes(host))) return true;
  return hit.source.lines.some(
    (one) => BASE_URL_LINE.test(one) && hosts.some((host) => one.toLowerCase().includes(host)),
  );
}

// Every name a guarded list holds is dead, so whatever gets past the guard is too.
function onlyDeadNames(hit: Hit, repo: Repo): boolean {
  const { source, entry, offset } = hit;
  const list = enclosing(source.code, offset);
  if (!list) return false;
  const close = closeOf(source.code, list.open);
  const dead = repo.entries
    .filter((one) => one.provider === entry.provider)
    .flatMap((one) => one.matchers)
    .filter((matcher) => matcher.kind === 'string');
  const names = source.spans
    .filter((span) => span.kind === 'string' && span.start > list.open && span.end <= close)
    .map((span) => innerText(source, span));
  return names.length > 0 && names.every((name) => dead.some((one) => tokenMatches(one, name)));
}

// `'claude-sonnet-4': {...}` beside a request that sends 'claude-sonnet-4-20250514': the key is the app's
// own, and the name sent is reported on its own line. Another key doesn't count: neither is shown sent.
function translatedTo(hit: Hit): string | undefined {
  const { source, entry, name } = hit;
  const names = entry.matchers.filter((matcher) => matcher.kind === 'string');
  return source.spans
    .filter((span) => span.kind === 'string' && source.code[span.end] !== ':')
    .map((span) => innerText(source, span))
    .find(
      (text) =>
        text !== name && tokensOf(text).some((one) => names.some((m) => tokenMatches(m, one))),
    );
}

function classify(hit: Hit, repo: Repo): Verdict {
  const { entry, matcher, source, offset } = hit;
  const lineIndex = lineIndexAt(source, offset);
  const line = source.lines[lineIndex];
  const span = spanAt(source.spans, offset);
  const gate = gateFor(entry, source, repo.versions);
  const version = gate.state === 'at-or-after' || gate.state === 'below' ? gate.version : undefined;
  if (gate.state === 'below') return { quiet: true, reason: gate.reason, version };

  const place = placeOf(hit, span, repo);
  if (place && 'matchClass' in place) return { ...place, version };
  const fed = place?.modelRecord ? recordPicker(repo.readers, source, offset) : undefined;
  if (place && !fed && (place.kind === 'comment' || place.kind === 'catalog')) {
    if (
      place.guardedBy &&
      entry.context &&
      fileNamesProvider(repo, source, entry.context) &&
      onlyDeadNames(hit, repo)
    ) {
      const reason = `${place.guardedBy} only accepts names that are dead, and the code stops on anything else`;
      return { matchClass: 'live', reason, version };
    }
    // Only a line or file that says so: one that merely names another host may hold this provider's table.
    const otherHost = place.kind === 'catalog' ? otherHostReason(hit, repo, line, true) : undefined;
    return otherHost
      ? { matchClass: 'catalog', ruledOut: true, reason: `${place.reason}; ${otherHost}`, version }
      : { matchClass: place.kind, reason: place.reason, version };
  }
  if (place?.tableKey) {
    const sent = translatedTo(hit);
    if (sent) {
      const reason = `a key of the app's own: the code sends ${sent}, reported where it does`;
      return { matchClass: 'catalog', reason, version };
    }
  }
  const picker = place?.kind === 'picker' ? place.reason : fed;
  const table = place?.kind === 'unclear' ? place.reason : undefined;

  const ambiguous = 'ambiguous' in matcher && matcher.ambiguous === true;
  const { context } = entry;
  if (context && !repoHasProvider(repo, context)) {
    const reason = `${entry.provider} has no package or host anywhere in this repo`;
    // A common word with no provider around is the app's own, so it costs no check.
    return ambiguous || matcher.kind === 'field'
      ? { quiet: true, reason }
      : { matchClass: 'unclear', reason, version };
  }
  if (ambiguous && context) {
    const foreign = foreignUrlHost(hit, source.lineStarts[lineIndex], line);
    if (foreign) return { quiet: true, reason: `a URL on another host: ${foreign}` };
    // A common word in a file with no sign of the provider is the app's own, as with no provider at all.
    // A picker's option isn't a common word, and what's picked often reaches the provider in another file.
    // Nor is a field a GraphQL query asks for, and the client it goes through is often in another file.
    const asked = span !== undefined && isGraphqlText(source, span);
    if (matcher.kind !== 'url' && !picker && !asked && !fileNamesProvider(repo, source, context)) {
      return { quiet: true, reason: `a common word in a file that never names ${entry.provider}` };
    }
  }
  const otherHost = otherHostReason(hit, repo, line, fed !== undefined);
  // The AI check rules a list row out unless it's told users pick from it.
  if (otherHost) {
    const reason = fed ? `${otherHost}; ${fed}` : otherHost;
    return { matchClass: 'unclear', reason, version };
  }
  if (gate.state === 'unknown') return { matchClass: 'unclear', reason: gate.reason };
  const passed = gate.state === 'at-or-after' ? `; ${gate.reason}` : '';
  if (table) return { matchClass: 'unclear', reason: `${table}${passed}`, version };
  // A row users pick isn't the common word the list marks a name ambiguous for.
  if (ambiguous && !fed && !(matcher.kind === 'url' && hostOnLineOrBaseUrl(hit, line))) {
    return {
      matchClass: 'unclear',
      reason: `the list marks this name ambiguous${passed}`,
      version,
    };
  }
  if (hit.read) {
    const bindings = bindingsFor(repo, source, entry.provider);
    const namesIt = !context || fileNamesProvider(repo, source, context);
    const evidence = readEvidence(hit.read, bindings, namesIt);
    if (!evidence.strong)
      return { matchClass: 'unclear', reason: `${evidence.why}${passed}`, version };
    const webhook =
      hit.read.binding?.from === 'webhook'
        ? '; a webhook object may have either shape, so read both'
        : '';
    return {
      matchClass: 'live',
      reason: `read off the provider's object: ${evidence.why}${webhook}${passed}`,
      version,
    };
  }
  return {
    matchClass: 'live',
    reason: `${picker ?? `${matcher.kind} match in code`}${passed}`,
    version,
  };
}

/** The verdict from where a match sits, then whether the value can reach the API from there at all. */
function judge(hit: Hit, repo: Repo): Verdict {
  const verdict = classify(hit, repo);
  if ('quiet' in verdict || (verdict.matchClass !== 'live' && verdict.matchClass !== 'unclear')) {
    return verdict;
  }
  const { source, offset, entry } = hit;
  const span = spanAt(source.spans, offset);
  const place = placeOf(hit, span, repo);
  const reach = reachOf(repo.readers, {
    source,
    offset,
    span,
    bareValue: hit.matcher.kind === 'regex',
    picker: place !== undefined && 'kind' in place && place.kind === 'picker',
    fileNamesProvider: !entry.context || fileNamesProvider(repo, source, entry.context),
    packages: entry.context?.packages ?? [],
  });
  if (reach) {
    return {
      ...verdict,
      matchClass: reach.kind,
      reason: `${reach.reason} (scan: ${verdict.reason})`,
      ...(reach.reads ? { reads: reach.reads } : {}),
      ...(reach.unclearIfAlone ? { unclearIfAlone: true } : {}),
    };
  }
  if (verdict.matchClass !== 'unclear') return verdict;
  if (isUnsubscribedWebhookVersion(hit)) {
    return {
      ...verdict,
      reason: `${verdict.reason}; this file declares no [[webhooks.subscriptions]], and the code subscribes on its own`,
      reads: webhookRegistrations(repo.readers).slice(0, MAX_REGISTRATIONS_SHOWN),
    };
  }
  const reads = holderReads(repo.readers, source, offset);
  return reads.length > 0 ? { ...verdict, reads } : verdict;
}

// Redacted before the cut, since a key cut short no longer looks like a key.
const lineTextOf = (line: string) => redactSecrets(line.trim()).slice(0, MAX_TEXT_CHARS);

function manifestDetails(repo: Repo, entries: DeadApiEntry[]): FindingDetail[] {
  const details: FindingDetail[] = [];
  for (const entry of entries) {
    for (const matcher of entry.matchers) {
      if (matcher.kind !== 'package') continue;
      for (const manifest of repo.manifests) {
        const wanted = matcher.ecosystem === undefined || matcher.ecosystem === manifest.ecosystem;
        const found = wanted && manifest.dependencies.find((one) => one.name === matcher.value);
        if (!found) continue;
        const dotFolder = dotFolderOf(manifest.file);
        const test = isTestPath(manifest.file);
        details.push({
          entryId: entry.id,
          provider: entry.provider,
          what: entry.what,
          file: manifest.file,
          line: found.line,
          matchClass: dotFolder ? 'catalog' : test ? 'test' : 'live',
          reason: dotFolder
            ? `in ${dotFolder}, a dot folder holding a vendored tool`
            : test
              ? 'a test, fixture, example or docs path'
              : `${matcher.value} is a dependency in this manifest`,
          text: `${found.name} ${found.version}`.trim(),
          withFix: false,
          ...(dotFolder ? { vendored: true } : {}),
        });
      }
    }
  }
  return details;
}

/** A hit that's only catalog beside another open one: with none, it's the check's to read, not clean. */
function keepVisible(details: FindingDetail[], ifAlone: Set<FindingDetail>): FindingDetail[] {
  const open = new Set(
    details
      .filter((one) => one.matchClass === 'live' || one.matchClass === 'unclear')
      .map((one) => one.entryId),
  );
  return details.map((detail) =>
    ifAlone.has(detail) && !open.has(detail.entryId)
      ? {
          ...detail,
          matchClass: 'unclear',
          reason: `${detail.reason}; it's the only open hit on this entry, so it may be the real use`,
        }
      : detail,
  );
}

/** The result fields that follow from the details: what goes with a fix, the findings and `clean`. */
export function settle(
  details: FindingDetail[],
): Pick<ScanResult, 'findings' | 'clean'> & { details: FindingDetail[] } {
  const liveProviders = new Set(
    details.filter((one) => one.matchClass === 'live').map((one) => one.provider),
  );
  const settled = details.map((detail) => ({
    ...detail,
    withFix:
      detail.matchClass === 'live' ||
      (detail.matchClass === 'catalog' &&
        !detail.vendored &&
        !detail.ruledOut &&
        liveProviders.has(detail.provider)),
  }));
  return {
    details: settled,
    findings: settled.map(({ entryId, file, line, matchClass, version }) => ({
      entryId,
      file,
      line,
      matchClass,
      ...(version ? { version } : {}),
    })),
    clean: !settled.some((one) => one.matchClass === 'live' || one.matchClass === 'unclear'),
  };
}

function catalogHints(provider: string): ProviderHints {
  const entry = catalogEntry(provider);
  if (!entry) return {};
  const packages = [...(entry.npm ?? []), ...(entry.python?.packages ?? [])];
  return {
    ...(packages.length ? { packages } : {}),
    ...(entry.hosts ? { hosts: entry.hosts } : {}),
    ...(entry.docsUrls ? { docsUrls: entry.docsUrls } : {}),
  };
}

type Unlisted = { providers: string[]; hostsOf: Map<string, string[]> };

async function unlistedProviders(
  repoDir: string,
  repo: string,
  manifests: Manifest[],
  sources: Source[],
  dataDir: string,
): Promise<Unlisted> {
  const { usages } = await scanRepo(repoDir, repo);
  const dependencies = manifests.flatMap((manifest) =>
    manifest.dependencies.flatMap((one) => {
      const provider = dependencyProvider(manifest.ecosystem, one.name)?.provider;
      return provider ? [provider] : [];
    }),
  );
  const files = readProviderFiles(dataDir);
  const listed = new Set(files.map((file) => providerId(file.provider)));
  const callers = sources.filter(
    (source) =>
      !source.generated &&
      !isIgnoredForFacts(source.file) &&
      (CODE_MODES.has(source.mode) || source.mode === 'notebook'),
  );
  const hostsOf = calledProviders(callers, files, listed);
  const found = new Set([
    ...usages.map((usage) => providerId(usage.provider)),
    ...dependencies.map(providerId),
    ...hostsOf.keys(),
    ...namedProviders(sources.filter((source) => !isIgnoredForFacts(source.file))),
  ]);
  return {
    providers: [...found].filter((provider) => provider && !listed.has(provider)).sort(),
    hostsOf,
  };
}

/**
 * Scans a repo against what's dead today. Only the entries in force count, so nothing still alive is
 * flagged, and a future shutdown starts flagging on its date with nobody editing the list.
 */
export async function scanDeadApis(
  repoDir: string,
  repo: string,
  options: DeadScanOptions = {},
): Promise<DeadScanReport> {
  const startedAt = performance.now();
  const dataDir = options.dataDir ?? DATA_DIR;
  const today = options.today ?? utcDay(new Date());
  const list = options.list ?? loadDeadApis(dataDir);
  const entries = entriesInForce(list, today);

  const { sources, skipped } = await readSources(repoDir);
  const allManifests = (await listManifests(repoDir)).manifests;
  const manifests = allManifests.filter((manifest) => !isIgnoredForFacts(manifest.file));
  const written = sources.filter((source) => !source.generated);
  const versions = await loadVersionFacts(repoDir, written, manifests, entries, isIgnoredForFacts);
  const facts: Repo = {
    sources,
    entries,
    readers: {
      sources: written.filter(
        (source) => source.mode !== 'prose' && !isIgnoredForFacts(source.file),
      ),
      manifests,
      reads: new Map(),
      uses: new Map(),
    },
    manifests,
    versions,
    presence: new Map(),
    fileNames: new Map(),
    bindings: new Map(),
    published: publishedFolders(sources),
  };

  const best = new Map<string, FindingDetail>();
  const quiet = new Map<string, QuietHit>();
  const unclearIfAlone = new Set<FindingDetail>();
  const add = (detail: FindingDetail) => {
    const key = `${detail.entryId}|${detail.file}|${detail.line}`;
    const held = best.get(key);
    if (!held || CLASS_RANK[detail.matchClass] > CLASS_RANK[held.matchClass]) best.set(key, detail);
  };
  for (const source of sources) {
    for (const hit of hitsIn(facts, source, entries)) {
      const verdict = judge(hit, facts);
      const lineIndex = lineIndexAt(source, hit.offset);
      const place = {
        entryId: hit.entry.id,
        provider: hit.entry.provider,
        file: source.file,
        line: reportedLine(source, lineIndex),
      };
      if ('quiet' in verdict) {
        const { reason, version } = verdict;
        quiet.set(`${place.entryId}|${place.file}|${place.line}`, {
          ...place,
          reason,
          ...(version ? { version } : {}),
        });
      } else {
        const detail: FindingDetail = {
          ...place,
          what: hit.entry.what,
          matchClass: verdict.matchClass,
          reason: verdict.reason,
          text: lineTextOf(source.lines[lineIndex]),
          withFix: false,
          lookFor: hit.entry.lookFor,
          ...(verdict.version ? { version: verdict.version } : {}),
          ...(verdict.vendored ? { vendored: true } : {}),
          ...(verdict.ruledOut ? { ruledOut: true } : {}),
          ...(verdict.reads ? { reads: verdict.reads } : {}),
        };
        if (verdict.unclearIfAlone) unclearIfAlone.add(detail);
        add(detail);
      }
    }
  }
  for (const detail of manifestDetails({ ...facts, manifests: allManifests }, entries)) add(detail);

  const details = keepVisible(
    [...best.values()].sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.line - b.line || a.entryId.localeCompare(b.entryId),
    ),
    unclearIfAlone,
  );
  const { providers: unlisted, hostsOf } = await unlistedProviders(
    repoDir,
    repo,
    manifests,
    written,
    dataDir,
  );
  if (options.storeDir && unlisted.length > 0) {
    const hints = Object.fromEntries(
      unlisted.map((provider) => {
        const hosts = catalogHints(provider).hosts ?? hostsOf.get(provider);
        return [provider, { ...catalogHints(provider), ...(hosts ? { hosts } : {}) }];
      }),
    );
    await enqueueUnlisted(options.storeDir, repo, unlisted, hints);
  }
  return {
    repo,
    today,
    listVersion: list.version,
    ...settle(details),
    unlistedProviders: unlisted,
    quiet: [...quiet.values()].filter((one) => !best.has(`${one.entryId}|${one.file}|${one.line}`)),
    skipped,
    filesRead: sources.length,
    seconds: (performance.now() - startedAt) / 1000,
  };
}

/**
 * The scan as the shared contract names it, for the harness's rescan and the orchestrator. Unlisted
 * providers reach the same queue the refresh reads, so they never count as nothing to do.
 */
export const scanRepoForDeadApis: ScanRepo = (repoDir, repo) =>
  scanDeadApis(repoDir, repo, { storeDir: PROPOSED_DIR });
