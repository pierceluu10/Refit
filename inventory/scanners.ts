// Fast scanners the inventory agent may call. They return raw signals with file and 1-based line
// numbers; they never decide what counts as an external API. Known-SDK names only annotate results.
import { builtinModules } from 'node:module';
import path from 'node:path';
import { grepLines, listFiles, readText } from './repo-files.ts';
import type { LineMatch } from './repo-files.ts';

export type Dependency = {
  name: string;
  version: string;
  line: number;
  dev?: boolean;
  hint?: string;
};
export type Manifest = {
  file: string;
  ecosystem: 'npm' | 'python' | 'go' | 'ruby' | 'php' | 'rust' | 'jvm' | 'dotnet' | 'other';
  dependencies: Dependency[];
};

const DEFAULT_MAX_RESULTS = 200;
const EXAMPLES_PER_GROUP = 3;
// Same cap grepLines applies to LineMatch.text.
const MAX_LINE_TEXT = 240;
const MAX_DOCUMENT_TEXT = 4000;
const DEFAULT_MAP_DEPTH = 2;
const MAX_MAP_CHILDREN = 10;
const MAX_MAP_TREE_LINES = 90;
const MAX_MAP_EXTENSIONS = 12;
const MAX_MAP_PATHS = 20;
const NO_EXTENSION = '(none)';

// Provider names for well-known SDKs. Annotation only: unknown packages are always returned too.
const KNOWN_SDK_HINTS: [RegExp, string][] = (
  [
    ['stripe', 'Stripe'],
    ['shopify', 'Shopify'],
    ['openai', 'OpenAI'],
    ['anthropic', 'Anthropic'],
    ['twilio', 'Twilio'],
    ['sendgrid', 'SendGrid'],
    ['aws-sdk|awssdk|boto3|botocore', 'AWS'],
    ['googleapis|google-cloud|googlemaps|google-maps', 'Google'],
    ['firebase|firebase-admin', 'Firebase'],
    ['supabase', 'Supabase'],
    ['octokit', 'GitHub'],
    ['slack', 'Slack'],
    ['discord', 'Discord'],
    ['algolia|algoliasearch', 'Algolia'],
    ['sentry', 'Sentry'],
    ['posthog', 'PostHog'],
    ['mixpanel', 'Mixpanel'],
    ['segment', 'Segment'],
    ['resend', 'Resend'],
    ['postmark', 'Postmark'],
    ['mailgun', 'Mailgun'],
    ['mailchimp', 'Mailchimp'],
    ['plaid', 'Plaid'],
    ['braintree', 'Braintree'],
    ['paypal', 'PayPal'],
    ['square', 'Square'],
    ['contentful', 'Contentful'],
    ['sanity', 'Sanity'],
    ['auth0', 'Auth0'],
    ['clerk', 'Clerk'],
    ['pusher', 'Pusher'],
    ['ably', 'Ably'],
    ['mapbox', 'Mapbox'],
    ['cloudinary', 'Cloudinary'],
    ['replicate', 'Replicate'],
    ['cohere', 'Cohere'],
    ['mistral|mistralai', 'Mistral'],
    ['groq', 'Groq'],
    ['langchain', 'LangChain'],
    ['hubspot', 'HubSpot'],
    ['intercom', 'Intercom'],
    ['zendesk', 'Zendesk'],
    ['airtable', 'Airtable'],
    ['notionhq', 'Notion'],
    ['launchdarkly', 'LaunchDarkly'],
  ] as const
).map(([word, provider]) => [
  new RegExp(String.raw`(?:^|[/@.:\\])(?:${word})(?:$|[/.:\\_-])`, 'i'),
  provider,
]);

function withHint<T extends object>(value: T, name: string): T & { hint?: string } {
  const hint = KNOWN_SDK_HINTS.find(([pattern]) => pattern.test(name))?.[1];
  return hint ? { ...value, hint } : value;
}

async function readLines(repoDir: string, file: string): Promise<string[] | undefined> {
  return (await readText(repoDir, file))?.split(/\r?\n/);
}

function lineMatch(file: string, index: number, line: string): LineMatch {
  return { file, line: index + 1, text: line.trim().slice(0, MAX_LINE_TEXT) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function dependency(name: string, version: string, index: number, dev: boolean): Dependency {
  return { name, version, line: index + 1, ...(dev ? { dev: true } : {}) };
}

// ---- Manifests ----

const JSON_ENTRY = /"([^"]+)"\s*:\s*"([^"]*)"/g;

// Reads `"section": { "name": "version" }` objects; `sections` maps each section to its dev flag.
function parseJsonSections(lines: string[], sections: Record<string, boolean>): Dependency[] {
  const dependencies: Dependency[] = [];
  let dev: boolean | undefined;
  const collect = (text: string, index: number) => {
    for (const match of text.matchAll(JSON_ENTRY)) {
      dependencies.push(dependency(match[1], match[2], index, dev === true));
    }
  };
  lines.forEach((line, index) => {
    if (dev === undefined) {
      const opening = /^\s*"([^"]+)"\s*:\s*\{(.*)$/.exec(line);
      if (!opening || !Object.hasOwn(sections, opening[1])) return;
      dev = sections[opening[1]];
      collect(opening[2], index);
      if (opening[2].includes('}')) dev = undefined;
    } else if (/^\s*\}/.test(line)) {
      dev = undefined;
    } else {
      collect(line, index);
    }
  });
  return dependencies;
}

const PEP_508_REQUIREMENT =
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:@\s*(\S+)|([^;#]*))/;

function addRequirement(dependencies: Dependency[], spec: string, index: number, dev: boolean) {
  const match = PEP_508_REQUIREMENT.exec(spec);
  if (match) dependencies.push(dependency(match[1], (match[2] ?? match[3]).trim(), index, dev));
}

function parseRequirementsFile(lines: string[], name: string): Dependency[] {
  const dev = /dev|test/i.test(name);
  const dependencies: Dependency[] = [];
  lines.forEach((line, index) => {
    if (/^\s*(#|-|$)/.test(line) || /^\s*\w+:\/\//.test(line)) return;
    addRequirement(dependencies, line, index, dev);
  });
  return dependencies;
}

const STRING_LITERAL = /"([^"]*)"|'([^']*)'/g;

// Walks a bracketed list of string literals that opens mid-line; returns the closing line's index.
function collectStrings(
  lines: string[],
  start: number,
  rest: string,
  found: (value: string, index: number) => void,
): number {
  for (let index = start; index < lines.length; index += 1) {
    const text = index === start ? rest : lines[index];
    for (const match of text.matchAll(STRING_LITERAL)) found(match[1] ?? match[2], index);
    if (text.replace(STRING_LITERAL, '').includes(']')) return index;
  }
  return lines.length - 1;
}

// `arrays` set: entries are PEP 508 string arrays under matching keys; otherwise `name = version`.
type TomlRule = { table: RegExp; dev: boolean; arrays?: RegExp };

const PYPROJECT_RULES: TomlRule[] = [
  { table: /^project$/, dev: false, arrays: /^dependencies$/ },
  { table: /^project\.optional-dependencies$/, dev: false, arrays: /./ },
  { table: /^dependency-groups$/, dev: true, arrays: /./ },
  { table: /^tool\.poetry\.dependencies$/, dev: false },
  { table: /^tool\.poetry\.(dev-dependencies|group\.[^.]+\.dependencies)$/, dev: true },
];
const PIPFILE_RULES: TomlRule[] = [
  { table: /^packages$/, dev: false },
  { table: /^dev-packages$/, dev: true },
];
const CARGO_RULES: TomlRule[] = [
  { table: /^(workspace\.|target\..+\.)?dependencies$/, dev: false },
  { table: /^(target\..+\.)?(dev|build)-dependencies$/, dev: true },
];

const TOML_HEADER = /^\s*\[\[?([^\]]+)\]/;
const TOML_KEY_VALUE = /^\s*("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/;

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function tomlVersion(value: string): string {
  const quoted = /^\s*["']([^"']*)["']/.exec(value);
  if (quoted) return quoted[1];
  return /\bversion\s*=\s*["']([^"']*)["']/.exec(value)?.[1] ?? '';
}

function parseToml(lines: string[], rules: TomlRule[]): Dependency[] {
  const dependencies: Dependency[] = [];
  let rule: TomlRule | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const header = TOML_HEADER.exec(lines[index]);
    if (header) {
      const table = header[1].replace(/["'\s]/g, '');
      rule = rules.find((candidate) => candidate.table.test(table));
      continue;
    }
    const entry = rule && TOML_KEY_VALUE.exec(lines[index]);
    if (!rule || !entry) continue;
    const { arrays, dev } = rule;
    if (!arrays) {
      dependencies.push(dependency(unquote(entry[1]), tomlVersion(entry[2]), index, dev));
    } else if (arrays.test(unquote(entry[1])) && entry[2].startsWith('[')) {
      index = collectStrings(lines, index, entry[2].slice(1), (value, line) =>
        addRequirement(dependencies, value, line, dev),
      );
    }
  }
  return dependencies;
}

function parseSetupPy(lines: string[]): Dependency[] {
  const dependencies: Dependency[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /\binstall_requires\s*=\s*\[(.*)$/.exec(lines[index]);
    if (!opening) continue;
    index = collectStrings(lines, index, opening[1], (value, line) =>
      addRequirement(dependencies, value, line, false),
    );
  }
  return dependencies;
}

function parseGoMod(lines: string[]): Dependency[] {
  const dependencies: Dependency[] = [];
  let inBlock = false;
  lines.forEach((line, index) => {
    if (/^\s*require\s*\(\s*$/.test(line)) {
      inBlock = true;
      return;
    }
    if (inBlock && /^\s*\)/.test(line)) {
      inBlock = false;
      return;
    }
    const match = (inBlock ? /^\s*([^\s/]\S*)\s+(v\S+)/ : /^\s*require\s+(\S+)\s+(v\S+)/).exec(
      line,
    );
    if (match) dependencies.push(dependency(match[1], match[2], index, false));
  });
  return dependencies;
}

function parseGemfile(lines: string[]): Dependency[] {
  const dependencies: Dependency[] = [];
  const devBlocks: boolean[] = [];
  lines.forEach((line, index) => {
    const group = /^\s*group\s+(.+?)\s+do\b/.exec(line);
    if (group) {
      devBlocks.push(/:(development|test)\b/.test(group[1]));
      return;
    }
    if (/\bdo\s*(\|[^|]*\|)?\s*$/.test(line)) {
      devBlocks.push(false);
      return;
    }
    if (/^\s*end\b/.test(line)) {
      devBlocks.pop();
      return;
    }
    const gem = /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/.exec(line);
    if (!gem) return;
    const dev = devBlocks.includes(true) || /group:\s*\[?\s*:(development|test)\b/.test(line);
    dependencies.push(dependency(gem[1], gem[2] ?? '', index, dev));
  });
  return dependencies;
}

function parsePom(lines: string[]): Dependency[] {
  const dependencies: Dependency[] = [];
  type Draft = { groupId?: string; artifactId?: string; version?: string; scope?: string };
  let draft: Draft | undefined;
  let artifactIndex = 0;
  let inExclusions = false;
  lines.forEach((line, index) => {
    if (/<dependency>/.test(line)) draft = {};
    if (!draft) return;
    if (/<exclusions>/.test(line)) inExclusions = true;
    if (!inExclusions) {
      for (const tag of line.matchAll(/<(groupId|artifactId|version|scope)>\s*([^<]*?)\s*<\//g)) {
        draft[tag[1] as keyof Draft] = tag[2];
        if (tag[1] === 'artifactId') artifactIndex = index;
      }
    }
    if (/<\/exclusions>/.test(line)) inExclusions = false;
    if (!/<\/dependency>/.test(line) || inExclusions) return;
    if (draft.artifactId) {
      const name = draft.groupId ? `${draft.groupId}:${draft.artifactId}` : draft.artifactId;
      const dev = draft.scope === 'test';
      dependencies.push(dependency(name, draft.version ?? '', artifactIndex, dev));
    }
    draft = undefined;
  });
  return dependencies;
}

const GRADLE_DEPENDENCY =
  /^\s*(\w*(?:[Ii]mplementation|[Aa]pi|[Cc]ompileOnly|[Rr]untimeOnly|[Aa]nnotationProcessor|kapt|ksp))\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']/;

function parseGradle(lines: string[]): Dependency[] {
  return lines.flatMap((line, index) => {
    const match = GRADLE_DEPENDENCY.exec(line);
    if (!match) return [];
    const dev = /^(test|androidTest)/.test(match[1]);
    return [dependency(`${match[2]}:${match[3]}`, match[4] ?? '', index, dev)];
  });
}

function parseCsproj(lines: string[]): Dependency[] {
  return lines.flatMap((line, index) => {
    if (!/<PackageReference\b/.test(line)) return [];
    const name = /\bInclude="([^"]+)"/.exec(line)?.[1];
    if (!name) return [];
    return [dependency(name, /\bVersion="([^"]*)"/.exec(line)?.[1] ?? '', index, false)];
  });
}

const MANIFEST_PARSERS: {
  name: RegExp;
  ecosystem: Manifest['ecosystem'];
  parse: (lines: string[], name: string) => Dependency[];
}[] = [
  {
    name: /^package\.json$/,
    ecosystem: 'npm',
    parse: (lines) =>
      parseJsonSections(lines, {
        dependencies: false,
        devDependencies: true,
        peerDependencies: false,
        optionalDependencies: false,
      }),
  },
  {
    name: /^composer\.json$/,
    ecosystem: 'php',
    parse: (lines) => parseJsonSections(lines, { require: false, 'require-dev': true }),
  },
  { name: /^requirements.*\.txt$/, ecosystem: 'python', parse: parseRequirementsFile },
  { name: /^pyproject\.toml$/, ecosystem: 'python', parse: (l) => parseToml(l, PYPROJECT_RULES) },
  { name: /^Pipfile$/, ecosystem: 'python', parse: (lines) => parseToml(lines, PIPFILE_RULES) },
  { name: /^setup\.py$/, ecosystem: 'python', parse: parseSetupPy },
  { name: /^go\.mod$/, ecosystem: 'go', parse: parseGoMod },
  { name: /^Gemfile$/, ecosystem: 'ruby', parse: parseGemfile },
  { name: /^Cargo\.toml$/, ecosystem: 'rust', parse: (lines) => parseToml(lines, CARGO_RULES) },
  { name: /^pom\.xml$/, ecosystem: 'jvm', parse: parsePom },
  { name: /^build\.gradle(\.kts)?$/, ecosystem: 'jvm', parse: parseGradle },
  { name: /\.csproj$/, ecosystem: 'dotnet', parse: parseCsproj },
];

function manifestParser(file: string) {
  const name = path.posix.basename(file);
  return MANIFEST_PARSERS.find((parser) => parser.name.test(name));
}

export async function listManifests(
  repoDir: string,
): Promise<{ manifests: Manifest[]; lockfiles: string[] }> {
  const files = await listFiles(repoDir);
  const manifests: Manifest[] = [];
  for (const file of files) {
    const parser = manifestParser(file);
    const lines = parser && (await readLines(repoDir, file));
    if (!parser || !lines) continue;
    const dependencies = parser
      .parse(lines, path.posix.basename(file))
      .map((entry) => withHint(entry, entry.name));
    manifests.push({ file, ecosystem: parser.ecosystem, dependencies });
  }
  return { manifests, lockfiles: files.filter(isLockfile) };
}

// ---- Lockfiles ----

type LockedEntry = { version: string; line: number };
type LockReader = (lines: string[], name: string) => LockedEntry[];

function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

// Finds the first `"<versionKey>": "x"` among a JSON object's direct children starting at `start`.
function jsonChildVersion(
  lines: string[],
  start: number,
  childIndent: number,
  versionKey: string,
): LockedEntry | undefined {
  const pattern = new RegExp(String.raw`^\s*"${versionKey}"\s*:\s*"([^"]+)"`);
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*\}/.test(lines[index]) && indentOf(lines[index]) < childIndent) return undefined;
    const version = pattern.exec(lines[index]);
    if (version && indentOf(lines[index]) === childIndent) {
      return { version: version[1], line: index + 1 };
    }
  }
  return undefined;
}

function jsonBlockVersions(lines: string[], key: RegExp, versionKey: string): LockedEntry[] {
  return lines.flatMap((line, index) => {
    if (!key.test(line) || index + 1 >= lines.length) return [];
    const found = jsonChildVersion(lines, index + 1, indentOf(lines[index + 1]), versionKey);
    return found ? [found] : [];
  });
}

const readNpmLock: LockReader = (lines, name) =>
  jsonBlockVersions(
    lines,
    new RegExp(String.raw`^\s*"(?:[^"]*node_modules/)?${escapeRegExp(name)}"\s*:\s*\{`),
    'version',
  );

const readYarnLock: LockReader = (lines, name) =>
  lines.flatMap((line, index) => {
    if (/^\s|^#/.test(line) || !line.trimEnd().endsWith(':')) return [];
    const specs = line
      .trimEnd()
      .slice(0, -1)
      .split(/,\s*/)
      .map((spec) => unquote(spec.trim()));
    if (!specs.some((spec) => spec.startsWith(`${name}@`))) return [];
    for (let next = index + 1; next < lines.length && /^\s/.test(lines[next]); next += 1) {
      const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(lines[next]);
      if (version) return [{ version: version[1], line: next + 1 }];
    }
    return [];
  });

const readPnpmLock: LockReader = (lines, name) => {
  const key = new RegExp(String.raw`^\s+['"]?/?${escapeRegExp(name)}[@/](\d[^:('"\s]*)`);
  return lines.flatMap((line, index) => {
    const match = key.exec(line);
    return match ? [{ version: match[1], line: index + 1 }] : [];
  });
};

const readBunLock: LockReader = (lines, name) => {
  const escaped = escapeRegExp(name);
  const key = new RegExp(String.raw`"${escaped}"\s*:\s*\[\s*"${escaped}@([^"]+)"`);
  return lines.flatMap((line, index) => {
    const match = key.exec(line);
    return match ? [{ version: match[1], line: index + 1 }] : [];
  });
};

// poetry.lock, uv.lock and Cargo.lock: [[package]] tables with name and version keys.
const readPackageTables: LockReader = (lines, name) => {
  const target = normalizePackageName(name);
  const found: LockedEntry[] = [];
  let matched = false;
  lines.forEach((line, index) => {
    if (/^\s*\[/.test(line)) {
      matched = false;
      return;
    }
    const packageName = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (packageName) {
      matched = normalizePackageName(packageName[1]) === target;
      return;
    }
    const version = matched && /^version\s*=\s*"([^"]+)"/.exec(line);
    if (version) {
      found.push({ version: version[1], line: index + 1 });
      matched = false;
    }
  });
  return found;
};

const readPipfileLock: LockReader = (lines, name) =>
  jsonBlockVersions(
    lines,
    new RegExp(String.raw`^\s*"${escapeRegExp(normalizePackageName(name))}"\s*:\s*\{`, 'i'),
    'version',
  ).map((entry) => ({ ...entry, version: entry.version.replace(/^==/, '') }));

const readNugetLock: LockReader = (lines, name) =>
  jsonBlockVersions(
    lines,
    new RegExp(String.raw`^\s*"${escapeRegExp(name)}"\s*:\s*\{`, 'i'),
    'resolved',
  );

const readComposerLock: LockReader = (lines, name) => {
  const key = new RegExp(String.raw`^\s*"name"\s*:\s*"${escapeRegExp(name)}"`, 'i');
  return lines.flatMap((line, index) => {
    if (!key.test(line)) return [];
    const found = jsonChildVersion(lines, index + 1, indentOf(line), 'version');
    return found ? [found] : [];
  });
};

const readGemfileLock: LockReader = (lines, name) => {
  const spec = new RegExp(String.raw`^ {4}${escapeRegExp(name)} \(([^)]+)\)`);
  return lines.flatMap((line, index) => {
    const match = spec.exec(line);
    return match ? [{ version: match[1], line: index + 1 }] : [];
  });
};

const readGoSum: LockReader = (lines, name) => {
  const entry = new RegExp(String.raw`^${escapeRegExp(name)} (v[^\s/]+)`);
  return lines.flatMap((line, index) => {
    const match = entry.exec(line);
    return match ? [{ version: match[1], line: index + 1 }] : [];
  });
};

const readGradleLock: LockReader = (lines, name) => {
  const entry = new RegExp(String.raw`^${escapeRegExp(name)}:([^=]+)=`);
  return lines.flatMap((line, index) => {
    const match = entry.exec(line);
    return match ? [{ version: match[1], line: index + 1 }] : [];
  });
};

const LOCK_READERS: Record<string, LockReader> = {
  'package-lock.json': readNpmLock,
  'npm-shrinkwrap.json': readNpmLock,
  'yarn.lock': readYarnLock,
  'pnpm-lock.yaml': readPnpmLock,
  'bun.lock': readBunLock,
  'poetry.lock': readPackageTables,
  'uv.lock': readPackageTables,
  'Cargo.lock': readPackageTables,
  'Pipfile.lock': readPipfileLock,
  'Gemfile.lock': readGemfileLock,
  'go.sum': readGoSum,
  'composer.lock': readComposerLock,
  'gradle.lockfile': readGradleLock,
  'packages.lock.json': readNugetLock,
};

function isLockfile(file: string): boolean {
  return Object.hasOwn(LOCK_READERS, path.posix.basename(file));
}

export async function lockedVersions(
  repoDir: string,
  packageName: string,
): Promise<{ lockfile: string; version: string; line: number }[]> {
  const results: { lockfile: string; version: string; line: number }[] = [];
  for (const lockfile of (await listFiles(repoDir)).filter(isLockfile)) {
    const lines = await readLines(repoDir, lockfile);
    if (!lines) continue;
    // Lockfiles repeat one resolution in several sections (npm v2, pnpm v9, go.sum).
    const seen = new Set<string>();
    for (const entry of LOCK_READERS[path.posix.basename(lockfile)](lines, packageName)) {
      if (seen.has(entry.version)) continue;
      seen.add(entry.version);
      results.push({ lockfile, ...entry });
    }
  }
  return results;
}

// ---- Imports ----

type FoundImport = { module: string; index: number };
type ImportReader = (lines: string[]) => FoundImport[];

const NODE_BUILTINS = new Set(builtinModules);
const PYTHON_STDLIB = new Set(
  (
    '__future__ abc argparse array asyncio base64 bisect calendar codecs collections concurrent ' +
    'contextlib copy csv dataclasses datetime decimal email enum fnmatch functools getpass glob ' +
    'gzip hashlib heapq hmac html http importlib inspect io itertools json locale logging math ' +
    'multiprocessing operator os pathlib pickle platform pprint queue random re secrets shutil ' +
    'signal socket sqlite3 ssl statistics string struct subprocess sys tarfile tempfile textwrap ' +
    'threading time traceback types typing unittest urllib uuid warnings weakref xml zipfile zlib'
  ).split(' '),
);
const JVM_STDLIB_ROOTS = new Set(['java', 'javax', 'jdk', 'kotlin', 'scala', 'sun']);

function lineImports(pattern: RegExp, toModules: (specifier: string) => string[]): ImportReader {
  return (lines) =>
    lines.flatMap((line, index) =>
      [...line.matchAll(pattern)].flatMap((match) => {
        const specifier = match.slice(1).find((group) => group !== undefined);
        return specifier ? toModules(specifier).map((module) => ({ module, index })) : [];
      }),
    );
}

const readJsImports = lineImports(
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  (specifier) => {
    // Relative paths, path aliases and Node built-ins are not packages.
    if (/^(?:[./~#]|@\/|node:)/.test(specifier)) return [];
    const segments = specifier.split('/');
    if (NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(segments[0])) return [];
    return [specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]];
  },
);

const readPythonImports = lineImports(
  /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.,\s]+?)\s*(?:#|$))/g,
  (specifier) =>
    specifier
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0].split('.')[0])
      .filter((root) => root && !PYTHON_STDLIB.has(root)),
);

function goModuleRoot(specifier: string): string[] {
  const segments = specifier.split('/');
  // Standard-library import paths have no dot in their first segment.
  return segments[0].includes('.') ? [segments.slice(0, 3).join('/')] : [];
}

const readGoImports: ImportReader = (lines) => {
  let inBlock = false;
  return lines.flatMap((line, index) => {
    if (/^\s*import\s*\(\s*$/.test(line)) {
      inBlock = true;
      return [];
    }
    if (inBlock && /^\s*\)/.test(line)) {
      inBlock = false;
      return [];
    }
    const pattern = inBlock
      ? /^\s*(?:[\w.]+\s+)?"([^"]+)"/
      : /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/;
    const match = pattern.exec(line);
    return match ? goModuleRoot(match[1]).map((module) => ({ module, index })) : [];
  });
};

const readRubyImports = lineImports(/^\s*require\s*\(?\s*['"]([^'"]+)['"]/g, (specifier) => [
  specifier.split('/')[0],
]);

const readPhpImports = lineImports(
  /^\s*use\s+(?:function\s+|const\s+)?\\?([A-Za-z_][\w\\]*)/g,
  (specifier) => [specifier.split('\\')[0]],
);

const readJvmImports = lineImports(/^\s*import\s+(?:static\s+)?([\w.]+)/g, (specifier) => {
  const segments = specifier.split('.');
  return JVM_STDLIB_ROOTS.has(segments[0]) ? [] : [segments.slice(0, 2).join('.')];
});

const readCsharpImports = lineImports(
  /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/g,
  (specifier) => {
    const segments = specifier.split('.');
    return segments[0] === 'System' ? [] : [segments.slice(0, 2).join('.')];
  },
);

const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const IMPORT_READERS = new Map<string, ImportReader>([
  ...[...JS_EXTENSIONS, '.vue', '.svelte', '.astro'].map(
    (extension) => [extension, readJsImports] as const,
  ),
  ['.py', readPythonImports],
  ['.go', readGoImports],
  ['.rb', readRubyImports],
  ['.php', readPhpImports],
  ['.java', readJvmImports],
  ['.kt', readJvmImports],
  ['.kts', readJvmImports],
  ['.scala', readJvmImports],
  ['.cs', readCsharpImports],
]);

export async function findImports(
  repoDir: string,
  options: { module?: string; maxResults?: number } = {},
): Promise<{
  modules: {
    module: string;
    files: number;
    occurrences: number;
    first: LineMatch[];
    hint?: string;
  }[];
  truncated: boolean;
}> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const exampleLimit = options.module === undefined ? EXAMPLES_PER_GROUP : maxResults;
  const groups = new Map<string, { files: Set<string>; occurrences: number; first: LineMatch[] }>();
  let truncated = false;
  for (const file of await listFiles(repoDir)) {
    const reader = IMPORT_READERS.get(path.posix.extname(file));
    const lines = reader && (await readLines(repoDir, file));
    if (!reader || !lines) continue;
    for (const { module, index } of reader(lines)) {
      if (options.module !== undefined && module !== options.module) continue;
      const group = groups.get(module) ?? { files: new Set(), occurrences: 0, first: [] };
      groups.set(module, group);
      group.files.add(file);
      group.occurrences += 1;
      if (group.first.length < exampleLimit) group.first.push(lineMatch(file, index, lines[index]));
      else if (options.module !== undefined) truncated = true;
    }
  }
  const modules = [...groups]
    .map(([module, group]) =>
      withHint(
        { module, files: group.files.size, occurrences: group.occurrences, first: group.first },
        module,
      ),
    )
    .sort(
      (a, b) =>
        b.files - a.files || b.occurrences - a.occurrences || a.module.localeCompare(b.module),
    );
  if (modules.length > maxResults) truncated = true;
  return { modules: modules.slice(0, maxResults), truncated };
}

// ---- HTTP, GraphQL and webhook signals ----

const CODE_EXTENSIONS = new Set([
  ...IMPORT_READERS.keys(),
  '.rs',
  '.swift',
  '.dart',
  '.ex',
  '.exs',
  '.sh',
]);
const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.xml',
  '.graphql',
  '.gql',
]);

function isEnvFile(name: string): boolean {
  return /^\.env(\.|$)|\.env$/.test(name);
}

function isEnvTemplate(name: string): boolean {
  return /example|sample|template/i.test(name);
}

// Real env files are excluded: line text from them would carry secret values.
function isSourceOrConfig(file: string): boolean {
  const name = path.posix.basename(file);
  if (isLockfile(file)) return false;
  if (isEnvFile(name)) return isEnvTemplate(name);
  const extension = path.posix.extname(name);
  return CODE_EXTENSIONS.has(extension) || CONFIG_EXTENSIONS.has(extension);
}

async function sourceAndConfigFiles(repoDir: string): Promise<string[]> {
  return (await listFiles(repoDir)).filter(isSourceOrConfig);
}

const URL_HOST = /\bhttps?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)/gi;
// Sorted last, never dropped.
const LOW_SIGNAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  'example.com',
  'example.org',
  'example.net',
  'www.w3.org',
]);

const HTTP_CLIENT_CALL = new RegExp(
  [
    String.raw`\bfetch\s*\(|\bofetch\b|\baxios\b|\bgot(?:\.\w+)?\s*\(|\bky(?:\.\w+)?\s*\(`,
    String.raw`\bsuperagent\b|\brequest\s*\(|\bundici\b|\bhttps?\.(?:request|get)\s*\(|XMLHttpRequest`,
    String.raw`\brequests\.\w+\s*\(|\bhttpx\.|\baiohttp\b|\burllib\b|\burlopen\s*\(`,
    String.raw`\bhttp\.(?:Get|Post|PostForm|Head|NewRequest|NewRequestWithContext)\s*\(|\.Do\(\s*req`,
    String.raw`Net::HTTP|\bFaraday\b|\bHTTParty\b|\bRestClient\b|GuzzleHttp|\bcurl_(?:init|exec|setopt)\b`,
    String.raw`\bHttpClient\b|\bOkHttpClient\b|\bRestTemplate\b|\bWebClient\b|\bHttpRequest\b`,
    String.raw`base_?ur[il]|api_?(?:url|base|host|root|endpoint)|endpoint`,
  ].join('|'),
  'i',
);

export async function findHttpCalls(
  repoDir: string,
  options: { maxResults?: number } = {},
): Promise<{
  hosts: { host: string; occurrences: number; examples: LineMatch[] }[];
  clientCalls: LineMatch[];
  truncated: boolean;
}> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const files = await sourceAndConfigFiles(repoDir);
  const hosts = new Map<string, { occurrences: number; examples: LineMatch[] }>();
  for (const file of files) {
    const lines = await readLines(repoDir, file);
    lines?.forEach((line, index) => {
      for (const match of line.matchAll(URL_HOST)) {
        const host = match[1].toLowerCase().replace(/[.-]+$/, '');
        const entry = hosts.get(host) ?? { occurrences: 0, examples: [] };
        hosts.set(host, entry);
        entry.occurrences += 1;
        if (entry.examples.length < EXAMPLES_PER_GROUP) {
          entry.examples.push(lineMatch(file, index, line));
        }
      }
    });
  }
  const sorted = [...hosts]
    .map(([host, entry]) => ({ host, ...entry }))
    .sort(
      (a, b) =>
        Number(LOW_SIGNAL_HOSTS.has(a.host)) - Number(LOW_SIGNAL_HOSTS.has(b.host)) ||
        b.occurrences - a.occurrences ||
        a.host.localeCompare(b.host),
    );
  const clientCalls = await grepLines(repoDir, HTTP_CLIENT_CALL, { files, maxResults });
  return {
    hosts: sorted.slice(0, maxResults),
    clientCalls: clientCalls.matches,
    truncated: sorted.length > maxResults || clientCalls.truncated,
  };
}

type GraphqlDocument = {
  file: string;
  line: number;
  kind: 'query' | 'mutation' | 'subscription' | 'fragment' | 'unknown';
  name?: string;
  text: string;
};

const GRAPHQL_EXTENSIONS = new Set(['.graphql', '.gql']);
const OPERATION_HEADER =
  /^[ \t]*(query|mutation|subscription|fragment)\b[ \t]*([A-Za-z_]\w*)?(?=[ \t]*(?:[({@]|on\b|$))/gm;
const GRAPHQL_TAG = /(?:\b(?:gql|graphql)\s*\(?\s*|\/\*\s*GraphQL\s*\*\/\s*)`([^`]*)`/g;
const GRAPHQL_STRING =
  /(?<=(["'`])\s*)(?:query|mutation|subscription|fragment)\s+[A-Za-z_]\w*\s*(?:[({]|on\b)/g;

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

// Splits a GraphQL body (starting at `start` in `source`) into one document per operation header.
function readOperations(
  file: string,
  source: string,
  start: number,
  body: string,
): GraphqlDocument[] {
  const headers = [...body.matchAll(OPERATION_HEADER)];
  if (headers.length === 0) {
    const text = body.trim();
    if (!text) return [];
    const offset = start + body.length - body.trimStart().length;
    // A bare selection set is the shorthand form of a query.
    const kind = text.startsWith('{') ? 'query' : 'unknown';
    return [{ file, line: lineAt(source, offset), kind, text: text.slice(0, MAX_DOCUMENT_TEXT) }];
  }
  return headers.map((header, position) => {
    const end = headers[position + 1]?.index ?? body.length;
    const text = body.slice(header.index, end).trim().slice(0, MAX_DOCUMENT_TEXT);
    const kind = header[1] as GraphqlDocument['kind'];
    const line = lineAt(source, start + header.index);
    return { file, line, kind, ...(header[2] ? { name: header[2] } : {}), text };
  });
}

export async function findGraphqlDocuments(
  repoDir: string,
  options: { maxResults?: number } = {},
): Promise<{ documents: GraphqlDocument[]; truncated: boolean }> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const documents: GraphqlDocument[] = [];
  for (const file of await listFiles(repoDir)) {
    const extension = path.posix.extname(file);
    const isGraphqlFile = GRAPHQL_EXTENSIONS.has(extension);
    if (!isGraphqlFile && !CODE_EXTENSIONS.has(extension)) continue;
    const source = await readText(repoDir, file);
    if (source === undefined) continue;
    if (isGraphqlFile) {
      documents.push(...readOperations(file, source, 0, source));
      continue;
    }
    const tagged: [number, number][] = [];
    for (const match of source.matchAll(GRAPHQL_TAG)) {
      tagged.push([match.index, match.index + match[0].length]);
      const start = match.index + match[0].length - match[1].length - 1;
      documents.push(...readOperations(file, source, start, match[1]));
    }
    for (const match of source.matchAll(GRAPHQL_STRING)) {
      if (tagged.some(([from, to]) => match.index >= from && match.index < to)) continue;
      const end = source.indexOf(match[1], match.index);
      const body = source.slice(match.index, end === -1 ? undefined : end);
      documents.push(...readOperations(file, source, match.index, body));
    }
  }
  return { documents: documents.slice(0, maxResults), truncated: documents.length > maxResults };
}

const WEBHOOK_SIGNAL = new RegExp(
  [
    String.raw`constructEvent|stripe-signature|x-hub-signature|x-shopify-hmac|x-twilio-signature`,
    String.raw`x-slack-signature|x-signature|webhook-signature|svix|validateRequest`,
    String.raw`verify_?signature|verify_?webhook|createHmac|hmac\.new|compare_digest|timingSafeEqual`,
    String.raw`hash_hmac|hash_equals|OpenSSL::HMAC|HMACSHA256|secure_compare|ConstantTimeCompare`,
    String.raw`webhook|event\.type\b|event\[['"]type['"]\]|\bcase\s+['"][\w-]+\.[\w.-]+['"]`,
  ].join('|'),
  'i',
);

export async function findWebhookSignals(
  repoDir: string,
  options: { maxResults?: number } = {},
): Promise<{ matches: LineMatch[]; truncated: boolean }> {
  return grepLines(repoDir, WEBHOOK_SIGNAL, {
    files: await sourceAndConfigFiles(repoDir),
    maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
  });
}

// ---- Environment variable names ----

const ENV_READ = new RegExp(
  [
    String.raw`process\.env\.([A-Za-z_]\w*)`,
    String.raw`process\.env\[\s*['"]([^'"]+)['"]\s*\]`,
    String.raw`import\.meta\.env\.([A-Za-z_]\w*)`,
    String.raw`os\.environ\[\s*['"]([^'"]+)['"]\s*\]`,
    String.raw`os\.environ\.get\(\s*['"]([^'"]+)['"]`,
    String.raw`(?:\bos\.|(?<![.\w]))getenv\(\s*['"]([^'"]+)['"]`,
    String.raw`\bENV\[\s*['"]([^'"]+)['"]\s*\]`,
    String.raw`\bENV\.fetch\(\s*['"]([^'"]+)['"]`,
    String.raw`\bos\.(?:Getenv|LookupEnv)\(\s*"([^"]+)"`,
    String.raw`System\.getenv\(\s*"([^"]+)"`,
    String.raw`Environment\.GetEnvironmentVariable\(\s*"([^"]+)"`,
    String.raw`\$_ENV\[\s*['"]([^'"]+)['"]`,
  ].join('|'),
  'g',
);
const ENV_FILE_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const CONFIG_ENV_KEY = /^\s*(?:-\s*)?([A-Z_][A-Z0-9_]*)\s*(?:[:=]|$)/;

// Keys under `environment:` / `env:` blocks in YAML (docker-compose, CI workflows).
function yamlEnvKeys(lines: string[]): FoundName[] {
  const found: FoundName[] = [];
  let blockIndent: number | undefined;
  lines.forEach((line, index) => {
    if (blockIndent !== undefined && line.trim() !== '') {
      const indent = indentOf(line);
      const inside = indent > blockIndent || (indent === blockIndent && /^\s*-/.test(line));
      if (inside) {
        const key = CONFIG_ENV_KEY.exec(line);
        if (key) found.push({ name: key[1], index });
        return;
      }
      blockIndent = undefined;
    }
    if (/^\s*-?\s*(?:environment|env):\s*$/.test(line)) blockIndent = indentOf(line);
  });
  return found;
}

// Keys under `[env]`-style tables in TOML (fly.toml, netlify.toml).
function tomlEnvKeys(lines: string[]): FoundName[] {
  const found: FoundName[] = [];
  let inEnvTable = false;
  lines.forEach((line, index) => {
    const header = TOML_HEADER.exec(line);
    if (header) {
      inEnvTable = /(^|\.)(env|environment)$/.test(header[1].trim());
      return;
    }
    const key = inEnvTable && CONFIG_ENV_KEY.exec(line);
    if (key) found.push({ name: key[1], index });
  });
  return found;
}

type FoundName = { name: string; index: number };

function envNamesIn(file: string, lines: string[]): FoundName[] {
  const name = path.posix.basename(file);
  // Env files yield key names only; their values are never read into results.
  if (isEnvFile(name)) {
    return lines.flatMap((line, index) => {
      const key = ENV_FILE_KEY.exec(line);
      return key ? [{ name: key[1], index }] : [];
    });
  }
  const found = lines.flatMap((line, index) =>
    [...line.matchAll(ENV_READ)].map((match) => ({
      name: match.slice(1).find((group) => group !== undefined) as string,
      index,
    })),
  );
  const extension = path.posix.extname(name);
  if (extension === '.yml' || extension === '.yaml') found.push(...yamlEnvKeys(lines));
  if (extension === '.toml') found.push(...tomlEnvKeys(lines));
  return found;
}

export async function findEnvNames(
  repoDir: string,
): Promise<{ name: string; occurrences: number; locations: { file: string; line: number }[] }[]> {
  const locations = new Map<string, { file: string; line: number }[]>();
  for (const file of await listFiles(repoDir)) {
    if (!isSourceOrConfig(file) && !isEnvFile(path.posix.basename(file))) continue;
    const lines = await readLines(repoDir, file);
    if (!lines) continue;
    for (const { name, index } of envNamesIn(file, lines)) {
      const list = locations.get(name) ?? [];
      locations.set(name, list);
      list.push({ file, line: index + 1 });
    }
  }
  return [...locations]
    .map(([name, list]) => ({ name, occurrences: list.length, locations: list }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Repository map ----

type DirectoryNode = { files: number; children: Map<string, DirectoryNode> };

function cappedList(heading: string, paths: string[]): string[] {
  if (paths.length === 0) return [`${heading}: none`];
  const shown = paths.slice(0, MAX_MAP_PATHS).map((entry) => `  ${entry}`);
  const hidden = paths.length - shown.length;
  return [`${heading}:`, ...shown, ...(hidden > 0 ? [`  …${hidden} more`] : [])];
}

export async function repoMap(repoDir: string, depth = DEFAULT_MAP_DEPTH): Promise<string> {
  const files = await listFiles(repoDir);
  const root: DirectoryNode = { files: 0, children: new Map() };
  const extensions = new Map<string, number>();
  for (const file of files) {
    root.files += 1;
    let node = root;
    for (const directory of file.split('/').slice(0, -1).slice(0, depth)) {
      const child = node.children.get(directory) ?? { files: 0, children: new Map() };
      node.children.set(directory, child);
      child.files += 1;
      node = child;
    }
    const extension = path.posix.extname(file) || NO_EXTENSION;
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
  }

  const lines = [`${path.basename(path.resolve(repoDir))}/ (${root.files} files)`];
  const render = (node: DirectoryNode, level: number) => {
    const indent = '  '.repeat(level);
    const children = [...node.children].sort(
      (a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]),
    );
    let shown = 0;
    for (const [name, child] of children.slice(0, MAX_MAP_CHILDREN)) {
      if (lines.length >= MAX_MAP_TREE_LINES) break;
      lines.push(`${indent}${name}/ (${child.files} files)`);
      shown += 1;
      render(child, level + 1);
    }
    if (children.length > shown) lines.push(`${indent}…${children.length - shown} more`);
  };
  render(root, 1);

  const topExtensions = [...extensions]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_MAP_EXTENSIONS)
    .map(([extension, count]) => `${extension} ${count}`);
  lines.push(
    '',
    `Total files: ${root.files}`,
    `Extensions: ${topExtensions.join(', ')}`,
    ...cappedList(
      'Manifests',
      files.filter((file) => manifestParser(file)),
    ),
    ...cappedList('Lockfiles', files.filter(isLockfile)),
  );
  return lines.join('\n');
}
