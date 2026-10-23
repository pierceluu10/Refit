import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import { PipelineInputError } from './types.ts';

// The standard path for tracers of languages other than JavaScript and TypeScript (owner decision,
// 2026-10-22; docs/ARCHITECTURE.md, "Other languages"): tree-sitter compiled to WebAssembly, one
// vendored grammar per language pinned below, and the shared SdkCallRecord. Every tracer reads and
// parses through this module, so each one gets the same checks:
// - grammar integrity: the WASM is hashed and compared with its pin before it is loaded;
// - resource limits: per-file size, parse time, node count and tree depth;
// - failure isolation: a failure becomes a named TracerStop, for one file where it can be tied to
//   one, otherwise for the language, and the rest of the scan goes on;
// - report only: these tracers never produce edits (REPORT_ONLY_LANGUAGES).
// pipeline/tracer-conformance.test.ts runs the same fixtures against every tracer in TRACERS.

export type TracerLanguage = 'python' | 'go';

// Never edited by Refit, only reported, unless a recorded owner decision changes it (AGENTS.md).
export const REPORT_ONLY_LANGUAGES: ReadonlySet<TracerLanguage> = new Set(['python', 'go']);

// A vendored grammar: the published WASM build and the generated grammar it was built from
// (`src/grammar.json`), each with its SHA-256, and where both came from. Both are copied byte for
// byte from the npm tarball; the hand-written grammar.js is pinned through the tarball's SHA-256
// and npm integrity rather than copied. The upstream tag and commit (npm `gitHead`, which the tag
// points to) were checked on checkedAt.
export interface GrammarPin {
  language: TracerLanguage;
  wasm: string;
  wasmSha256: string;
  source: string;
  sourceSha256: string;
  license: string;
  package: string;
  version: string;
  tarball: string;
  tarballSha256: string;
  integrity: string;
  repository: string;
  tag: string;
  commit: string;
  checkedAt: string;
}

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const GRAMMARS: Record<TracerLanguage, GrammarPin> = {
  python: {
    language: 'python',
    wasm: local('./python/tree-sitter-python.wasm'),
    wasmSha256: '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47',
    source: local('./grammars/tree-sitter-python/grammar.json'),
    sourceSha256: '2adc15e78f4dae293e85de1517c45bcee2f8b075fa30a083c658925b944afec4',
    license: local('./grammars/tree-sitter-python/LICENSE'),
    package: 'tree-sitter-python',
    version: '0.25.0',
    tarball: 'https://registry.npmjs.org/tree-sitter-python/-/tree-sitter-python-0.25.0.tgz',
    tarballSha256: '63b76b3fa8181fd79eaad4abcdb21e2babcb504dbfc7710a89934fa456d26096',
    integrity:
      'sha512-eCmJx6zQa35GxaCtQD+wXHOhYqBxEL+bp71W/s3fcDMu06MrtzkVXR437dRrCrbrDbyLuUDJpAgycs7ncngLXw==',
    repository: 'https://github.com/tree-sitter/tree-sitter-python',
    tag: 'v0.25.0',
    commit: '293fdc02038ee2bf0e2e206711b69c90ac0d413f',
    checkedAt: '2026-10-22',
  },
  go: {
    language: 'go',
    wasm: local('./go/tree-sitter-go.wasm'),
    wasmSha256: '9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7',
    source: local('./grammars/tree-sitter-go/grammar.json'),
    sourceSha256: '0dcc665aa521a1b73a200be13b4e376780cca037d764a165f12864babfe28000',
    license: local('./grammars/tree-sitter-go/LICENSE'),
    package: 'tree-sitter-go',
    version: '0.25.0',
    tarball: 'https://registry.npmjs.org/tree-sitter-go/-/tree-sitter-go-0.25.0.tgz',
    tarballSha256: 'f7265544d6b297797dc3675c02b76fb182c177ce29fda10ac1f36e9ab33fd90e',
    integrity:
      'sha512-APBc/Dq3xz/e35Xpkhb1blu5UgW+2E3RyGWawZSCNcbGwa7jhSQPS8KsUupuzBla8PCo8+lz9W/JDJjmfRa2tw==',
    repository: 'https://github.com/tree-sitter/tree-sitter-go',
    tag: 'v0.25.0',
    commit: '1547678a9da59885853f5f5cc8a99cc203fa2e2c',
    checkedAt: '2026-10-22',
  },
};

export interface TracerLimits {
  // Repository totals, as readRepository has for JavaScript and TypeScript.
  files: number;
  totalBytes: number;
  // Per file.
  fileBytes: number;
  parseMilliseconds: number;
  nodes: number;
  depth: number;
}

export const TRACER_LIMITS: TracerLimits = {
  files: 10_000,
  totalBytes: 50 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  parseMilliseconds: 5_000,
  nodes: 2_000_000,
  depth: 1_000,
};

export type TracerStopCode =
  | 'grammar-integrity'
  | 'grammar-load-failed'
  | 'scan-limits'
  | 'file-too-large'
  | 'parse-timeout'
  | 'parse-failed'
  | 'tree-too-large'
  | 'tree-too-deep'
  | 'tracer-failed';

// Something a tracer could not read, named so a report says what was left out and why. `file` is
// null when the stop covers the whole language.
export interface TracerStop {
  language: TracerLanguage;
  file: string | null;
  code: TracerStopCode;
  reason: string;
}

// A PipelineInputError, so a caller that does not isolate languages reports it as bad input.
export class TracerStopError extends PipelineInputError {
  override name = 'TracerStopError';
  readonly code: TracerStopCode;
  constructor(code: TracerStopCode, message: string) {
    super(message);
    this.code = code;
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// The grammar's bytes after checking them against the pin. The same bytes are then loaded, so the
// file cannot change between the check and the load.
export async function verifiedGrammar(pin: GrammarPin): Promise<Uint8Array> {
  const bytes = await readFile(pin.wasm);
  const actual = sha256(bytes);
  if (actual !== pin.wasmSha256)
    throw new TracerStopError(
      'grammar-integrity',
      `The ${pin.language} grammar ${pin.package}@${pin.version} has SHA-256 ${actual}, not the pinned ${pin.wasmSha256}; it was not loaded.`,
    );
  return bytes;
}

let runtime: Promise<void> | undefined;
const parsers = new Map<TracerLanguage, Promise<Parser>>();

// One parser per language over one shared web-tree-sitter runtime: two concurrent Parser.init()
// calls can each create a WASM module and leave the first parser on a replaced one. A grammar that
// fails its check or its load fails every later call the same way.
export function loadParser(language: TracerLanguage): Promise<Parser> {
  let loaded = parsers.get(language);
  if (!loaded) {
    loaded = (async () => {
      const bytes = await verifiedGrammar(GRAMMARS[language]);
      await (runtime ??= Parser.init());
      let grammar: Language;
      try {
        grammar = await Language.load(bytes);
      } catch (error) {
        throw new TracerStopError(
          'grammar-load-failed',
          `The ${language} grammar did not load: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const parser = new Parser();
      parser.setLanguage(grammar);
      return parser;
    })();
    parsers.set(language, loaded);
  }
  return loaded;
}

// For tests that change a pin: forget loaded parsers so the next load checks the grammar again.
export function clearLoadedParsers() {
  parsers.clear();
}

export interface SourceFile {
  path: string;
  content: string;
}

// Source files with one extension under a repository, in path order. Symbolic links and the
// excluded directories are skipped. A file over the per-file limit is left out as a named stop
// when `stops` is given, and throws otherwise; past the file-count or total-size limit the scan
// throws, as readRepository does, rather than leaving files out unreported.
export async function readSources(
  root: string,
  options: {
    language: TracerLanguage;
    extension: string;
    excluded: ReadonlySet<string>;
    stops?: TracerStop[];
    limits?: TracerLimits;
  },
): Promise<SourceFile[]> {
  const limits = options.limits ?? TRACER_LIMITS;
  const files: SourceFile[] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !options.excluded.has(entry.name)) await visit(path);
      if (!entry.isFile() || !entry.name.endsWith(options.extension)) continue;
      const file = relative(root, path).split('\\').join('/');
      const size = (await lstat(path)).size;
      if (size > limits.fileBytes) {
        const reason = `${file} is ${size} bytes, over the ${limits.fileBytes}-byte limit for one ${options.language} file; it was not read.`;
        if (!options.stops) throw new TracerStopError('file-too-large', reason);
        options.stops.push({ language: options.language, file, code: 'file-too-large', reason });
        continue;
      }
      total += size;
      if (total > limits.totalBytes || files.length >= limits.files)
        throw new TracerStopError(
          'scan-limits',
          `${options.language} sources exceed scan limits (${limits.files} files, ${limits.totalBytes} bytes in total).`,
        );
      files.push({ path: file, content: await readFile(path, 'utf8') });
    }
  };
  await visit(root);
  return files;
}

// Parses one file within the limits, or says why it could not. The tree is the caller's to free.
export function parseWithin(
  parser: Parser,
  language: TracerLanguage,
  file: SourceFile,
  limits: TracerLimits = TRACER_LIMITS,
): Tree | TracerStop {
  const stop = (code: TracerStopCode, reason: string): TracerStop => ({
    language,
    file: file.path,
    code,
    reason,
  });
  const bytes = Buffer.byteLength(file.content);
  if (bytes > limits.fileBytes)
    return stop(
      'file-too-large',
      `${file.path} is ${bytes} bytes, over the ${limits.fileBytes}-byte limit for one ${language} file; it was not parsed.`,
    );
  let tree: Tree | null;
  const deadline = performance.now() + limits.parseMilliseconds;
  try {
    // Returning true from the progress callback cancels the parse, which then returns null.
    tree = parser.parse(file.content, null, {
      progressCallback: () => performance.now() > deadline,
    });
  } catch (error) {
    parser.reset();
    return stop(
      'parse-failed',
      `${file.path} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!tree) {
    parser.reset();
    return stop(
      'parse-timeout',
      `${file.path} took longer than ${limits.parseMilliseconds} ms to parse; it was not read.`,
    );
  }
  // Tracers walk trees recursively, so a very large or deep tree stops here rather than there.
  const cursor = tree.walk();
  let nodes = 0;
  let depth = 0;
  let exceeded: TracerStop | undefined;
  walk: for (;;) {
    nodes += 1;
    if (nodes > limits.nodes || depth > limits.depth) {
      exceeded =
        nodes > limits.nodes
          ? stop(
              'tree-too-large',
              `${file.path} has more than ${limits.nodes} syntax nodes; it was not read.`,
            )
          : stop(
              'tree-too-deep',
              `${file.path} nests deeper than ${limits.depth} syntax levels; it was not read.`,
            );
      break;
    }
    if (cursor.gotoFirstChild()) {
      depth += 1;
      continue;
    }
    for (;;) {
      if (cursor.gotoNextSibling()) continue walk;
      if (!cursor.gotoParent()) break walk;
      depth -= 1;
    }
  }
  cursor.delete();
  if (exceeded) {
    tree.delete();
    return exceeded;
  }
  return tree;
}

// Hands `use` a getter that parses each file once, on first use, within the limits. A file that
// cannot be read becomes a stop in `stops` and reads as missing; without `stops` it throws. Every
// tree is freed once `use` has finished (awaited when it is async), since tree-sitter trees live
// in WebAssembly memory.
export async function withTrees<T>(
  language: TracerLanguage,
  files: SourceFile[],
  use: (tree: (path: string) => Tree | undefined) => T | Promise<T>,
  options: { stops?: TracerStop[]; limits?: TracerLimits } = {},
): Promise<T> {
  const parser = await loadParser(language);
  const contents = new Map(files.map((file) => [file.path, file]));
  const trees = new Map<string, Tree | undefined>();
  try {
    return await use((path) => {
      if (!trees.has(path)) {
        const file = contents.get(path);
        const parsed = file && parseWithin(parser, language, file, options.limits);
        if (parsed && !('rootNode' in parsed)) {
          if (!options.stops) throw new TracerStopError(parsed.code, parsed.reason);
          options.stops.push(parsed);
        }
        trees.set(path, parsed && 'rootNode' in parsed ? parsed : undefined);
      }
      return trees.get(path);
    });
  } finally {
    for (const tree of trees.values()) tree?.delete();
  }
}

// Runs one language's pass of a scan so that its failure cannot end the scan: any error becomes a
// stop for the whole language and `fallback` is returned. Without `stops` the error is rethrown.
export async function isolated<T>(
  language: TracerLanguage,
  stops: TracerStop[] | undefined,
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!stops) throw error;
    stops.push({
      language,
      file: null,
      code: error instanceof TracerStopError ? error.code : 'tracer-failed',
      reason:
        error instanceof TracerStopError
          ? error.message
          : `The ${language} tracer failed, so no ${language} file was read: ${error instanceof Error ? error.message : String(error)}`,
    });
    return fallback;
  }
}

// Stops once each, in a stable order: a file can be stopped by more than one pass over it.
export function uniqueStops(stops: TracerStop[]): TracerStop[] {
  const seen = new Map<string, TracerStop>();
  for (const stop of stops) seen.set(`${stop.language}\0${stop.file ?? ''}\0${stop.code}`, stop);
  return [...seen.values()].sort(
    (a, b) =>
      a.language.localeCompare(b.language) ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      a.code.localeCompare(b.code),
  );
}
