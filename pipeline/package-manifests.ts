import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseToml, TomlError, type TomlTable, type TomlValue } from './package-manifests-toml.ts';

// Package inventory for non-JavaScript ecosystems, read from manifests and lockfiles only. Nothing
// is installed, resolved against a registry or executed: a version Refit cannot read literally
// stays null, and a file it cannot parse becomes a named stop rather than an error.

export type Ecosystem = 'pypi' | 'go' | 'rubygems' | 'packagist' | 'maven' | 'nuget' | 'cargo';
export const ECOSYSTEMS: Ecosystem[] = [
  'pypi',
  'go',
  'rubygems',
  'packagist',
  'maven',
  'nuget',
  'cargo',
];

export interface ManifestDependency {
  ecosystem: Ecosystem;
  // The registry name: PEP 503-normalised for PyPI, `group:artifact` for Maven, the module path
  // for Go, lower-cased `vendor/package` for Packagist, as written for RubyGems, NuGet and Cargo.
  name: string;
  // The range or requirement the manifest declares, as written; null when it declares none.
  declared: string | null;
  // The exact version a lockfile next to the manifest (or in an ancestor directory) pins.
  locked: string | null;
  file: string;
  line: number;
  // False for packages only a lockfile lists, or that go.mod marks `// indirect`.
  direct: boolean;
}

export type ManifestStopReason =
  | 'unparseable-toml'
  | 'unparseable-json'
  | 'unparseable-xml'
  | 'unparseable-manifest'
  | 'version-not-literal'
  | 'include-missing'
  | 'include-outside-repository'
  | 'manifest-too-large';

export interface ManifestStop {
  file: string;
  line: number | null;
  reason: ManifestStopReason;
  detail: string;
}

export interface PackageInventory {
  manifests: { file: string; ecosystem: Ecosystem; kind: 'manifest' | 'lockfile' }[];
  dependencies: ManifestDependency[];
  stops: ManifestStop[];
}

export interface ParsedManifest {
  dependencies: Omit<ManifestDependency, 'locked'>[];
  // Exact versions a lockfile pins, by registry name.
  locks: { name: string; version: string; line: number }[];
  stops: ManifestStop[];
  // Requirements files named by -r/--requirement, relative to the repository root.
  includes: { file: string; line: number }[];
}

interface ManifestKind {
  ecosystem: Ecosystem;
  kind: 'manifest' | 'lockfile';
  parse: (content: string, file: string) => ParsedManifest;
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
// Directories that hold installed or generated packages, never the repository's own manifests.
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
  '.tox',
  '.mypy_cache',
  'target',
  '.gradle',
  'bin',
  'obj',
  'Pods',
  '.bundle',
]);

function empty(): ParsedManifest {
  return { dependencies: [], locks: [], stops: [], includes: [] };
}

function stop(
  file: string,
  reason: ManifestStopReason,
  detail: string,
  line: number | null = null,
): ManifestStop {
  return { file, line, reason, detail };
}

// The 1-based line of the first match of `pattern` at or after `from`, or 1.
function lineOf(content: string, pattern: string | RegExp, from = 0) {
  let index: number;
  if (typeof pattern === 'string') index = content.indexOf(pattern, from);
  else {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const search = new RegExp(pattern.source, flags);
    search.lastIndex = from;
    index = search.exec(content)?.index ?? -1;
  }
  if (index < 0) return 1;
  let line = 1;
  for (let position = content.indexOf('\n'); position >= 0 && position < index;)
    ((line += 1), (position = content.indexOf('\n', position + 1)));
  return line;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Python -------------------------------------------------------------------------------------

export function normalizePythonName(name: string) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

// A PEP 508 requirement: name, optional extras, version specifiers or URL, optional marker.
const PEP_508 =
  /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*(\(?\s*[<>=!~][^;@]*?\)?|@\s*\S+)?\s*(?:;.*)?$/;

function pep508(requirement: string) {
  const match = PEP_508.exec(requirement);
  if (!match) return undefined;
  const specifier = match[2]?.trim().replace(/^\(\s*|\s*\)$/g, '') || null;
  return { name: normalizePythonName(match[1]), declared: specifier };
}

export function parseRequirements(content: string, file: string): ParsedManifest {
  const result = empty();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let text = lines[index];
    // Backslash continuations join physical lines.
    while (text.endsWith('\\') && index + 1 < lines.length)
      text = text.slice(0, -1) + lines[++index];
    text = text.replace(/(^|\s)#.*$/, '').trim();
    if (!text) continue;
    const include = /^(?:-r|--requirement)(?:\s*=?\s*)(\S+)/.exec(text);
    if (include) {
      result.includes.push({ file: posix.join(posix.dirname(file), include[1]), line: lineNumber });
      continue;
    }
    // Constraints files, indexes, hashes and other options name no dependency of their own.
    if (text.startsWith('-') && !/^(?:-e|--editable)\s/.test(text)) continue;
    const editable = /^(?:-e|--editable)\s+(\S+)/.exec(text);
    if (editable) {
      const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(editable[1]);
      if (egg)
        result.dependencies.push({
          ecosystem: 'pypi',
          name: normalizePythonName(egg[1]),
          declared: editable[1],
          file,
          line: lineNumber,
          direct: true,
        });
      continue;
    }
    // A bare URL or path with #egg= names its package; other bare paths and URLs do not.
    if (/^(?:[a-z+]+:\/\/|\.{0,2}\/)/.test(text)) {
      const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(text);
      if (egg)
        result.dependencies.push({
          ecosystem: 'pypi',
          name: normalizePythonName(egg[1]),
          declared: text.split('#')[0],
          file,
          line: lineNumber,
          direct: true,
        });
      continue;
    }
    const requirement = pep508(text.replace(/\s--hash[= ]\S+/g, ''));
    if (!requirement) {
      result.stops.push(
        stop(file, 'unparseable-manifest', `Not a requirement: ${text.slice(0, 80)}`, lineNumber),
      );
      continue;
    }
    result.dependencies.push({
      ecosystem: 'pypi',
      ...requirement,
      file,
      line: lineNumber,
      direct: true,
    });
  }
  return result;
}

function tomlDocument(content: string, file: string, result: ParsedManifest) {
  try {
    return parseToml(content);
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    result.stops.push(stop(file, 'unparseable-toml', error.message, error.line));
    return undefined;
  }
}

function table(value: TomlValue | undefined): TomlTable | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function strings(value: TomlValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// Poetry and Pipfile declare `name = "^1.2"` or `name = { version = "^1.2", ... }`.
function tableDeclaration(value: TomlValue): string | null {
  if (typeof value === 'string') return value === '*' ? '*' : value;
  const entry = table(value);
  if (!entry) return null;
  if (typeof entry.version === 'string') return entry.version;
  for (const source of ['git', 'path', 'url'])
    if (typeof entry[source] === 'string') return `${source}:${entry[source] as string}`;
  return null;
}

function pythonLine(content: string, name: string) {
  const pattern = name.replace(/-/g, '[-_.]+');
  return lineOf(content, new RegExp(`^\\s*["']?${pattern}(?![A-Za-z0-9])`, 'im'));
}

export function parsePyproject(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = tomlDocument(content, file, result);
  if (!document) return result;
  const add = (requirement: string) => {
    const parsed = pep508(requirement);
    if (!parsed) {
      result.stops.push(
        stop(file, 'unparseable-manifest', `Not a requirement: ${requirement.slice(0, 80)}`),
      );
      return;
    }
    result.dependencies.push({
      ecosystem: 'pypi',
      ...parsed,
      file,
      line: lineOf(content, requirement),
      direct: true,
    });
  };
  const project = table(document.project);
  for (const requirement of strings(project?.dependencies)) add(requirement);
  for (const group of Object.values(table(project?.['optional-dependencies']) ?? {}))
    for (const requirement of strings(group)) add(requirement);
  for (const group of Object.values(table(document['dependency-groups']) ?? {}))
    for (const requirement of strings(group)) add(requirement);
  const poetry = table(table(document.tool)?.poetry);
  const poetryTables = [
    table(poetry?.dependencies),
    table(poetry?.['dev-dependencies']),
    ...Object.values(table(poetry?.group) ?? {}).map((group) => table(table(group)?.dependencies)),
  ];
  for (const dependencies of poetryTables)
    for (const [name, value] of Object.entries(dependencies ?? {})) {
      if (name.toLowerCase() === 'python') continue;
      const normalized = normalizePythonName(name);
      result.dependencies.push({
        ecosystem: 'pypi',
        name: normalized,
        declared: tableDeclaration(value),
        file,
        line: pythonLine(content, normalized),
        direct: true,
      });
    }
  return result;
}

export function parsePipfile(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = tomlDocument(content, file, result);
  if (!document) return result;
  for (const section of ['packages', 'dev-packages'])
    for (const [name, value] of Object.entries(table(document[section]) ?? {})) {
      const normalized = normalizePythonName(name);
      result.dependencies.push({
        ecosystem: 'pypi',
        name: normalized,
        declared: tableDeclaration(value),
        file,
        line: pythonLine(content, normalized),
        direct: true,
      });
    }
  return result;
}

// uv.lock, poetry.lock and Cargo.lock share the `[[package]] name/version` shape.
function packageArrayLock(
  content: string,
  file: string,
  normalize: (name: string) => string,
): ParsedManifest {
  const result = empty();
  const document = tomlDocument(content, file, result);
  if (!document) return result;
  const packages = Array.isArray(document.package) ? document.package : [];
  let from = 0;
  for (const entry of packages) {
    const item = table(entry);
    if (typeof item?.name !== 'string' || typeof item.version !== 'string') continue;
    const index = content.indexOf(`name = "${item.name}"`, from);
    if (index >= 0) from = index;
    result.locks.push({
      name: normalize(item.name),
      version: item.version,
      line: lineOf(content, `name = "${item.name}"`, index >= 0 ? index : 0),
    });
  }
  return result;
}

export function parsePipfileLock(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = jsonDocument(content, file, result);
  if (!document) return result;
  for (const section of ['default', 'develop']) {
    const entries = document[section];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
      const version = (value as { version?: unknown })?.version;
      if (typeof version !== 'string') continue;
      result.locks.push({
        name: normalizePythonName(name),
        version: version.replace(/^==/, ''),
        line: lineOf(content, `"${name}"`),
      });
    }
  }
  return result;
}

// --- Go -----------------------------------------------------------------------------------------

export function parseGoMod(content: string, file: string): ParsedManifest {
  const result = empty();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let block: string | undefined;
  for (const [index, raw] of lines.entries()) {
    const indirect = /\/\/\s*indirect\b/.test(raw);
    const text = raw.replace(/\/\/.*$/, '').trim();
    if (!text) continue;
    if (block) {
      if (text === ')') block = undefined;
      else if (block === 'require') requirement(text, index + 1, indirect);
      continue;
    }
    const opened = /^(require|replace|exclude|retract|tool|godebug)\s*\($/.exec(text);
    if (opened) {
      block = opened[1];
      continue;
    }
    const single = /^require\s+(.+)$/.exec(text);
    if (single) requirement(single[1], index + 1, indirect);
    else if (!/^(?:module|go|toolchain|replace|exclude|retract|tool|godebug)\b/.test(text))
      result.stops.push(
        stop(
          file,
          'unparseable-manifest',
          `Unknown go.mod directive: ${text.slice(0, 80)}`,
          index + 1,
        ),
      );
  }
  if (block)
    result.stops.push(
      stop(file, 'unparseable-manifest', `Unterminated ${block} block`, lines.length),
    );
  return result;

  function requirement(text: string, line: number, indirect: boolean) {
    const match = /^("?)([^\s"]+)\1\s+(v\S+)$/.exec(text);
    if (!match) {
      result.stops.push(
        stop(file, 'unparseable-manifest', `Not a requirement: ${text.slice(0, 80)}`, line),
      );
      return;
    }
    result.dependencies.push({
      ecosystem: 'go',
      name: match[2],
      declared: match[3],
      file,
      line,
      direct: !indirect,
    });
  }
}

export function parseGoSum(content: string): ParsedManifest {
  const result = empty();
  for (const [index, line] of content.split('\n').entries()) {
    const match = /^(\S+)\s+(v[^\s/]+)(?:\/go\.mod)?\s+h1:/.exec(line);
    if (match) result.locks.push({ name: match[1], version: match[2], line: index + 1 });
  }
  return result;
}

// --- Ruby ---------------------------------------------------------------------------------------

export function parseGemfile(content: string, file: string): ParsedManifest {
  const result = empty();
  for (const [index, raw] of content.replace(/\r\n/g, '\n').split('\n').entries()) {
    const text = raw.replace(/(^|\s)#.*$/, '').trim();
    const match = /^gem\s*\(?\s*(['"])([^'"]+)\1(.*)$/.exec(text);
    if (!match) continue;
    // Requirements are the leading string arguments; options such as require: or git: follow.
    const requirements: string[] = [];
    for (const argument of match[3].matchAll(
      /,\s*(?:(['"])([^'"]*)\1|([A-Za-z_]+\s*:|:\w+\s*=>))/g,
    )) {
      if (argument[3]) break;
      requirements.push(argument[2]);
    }
    const nonLiteral =
      requirements.length === 0 && /,\s*[A-Z_a-z][\w.]*\s*(?:,|\)|$)/.test(match[3]);
    if (nonLiteral)
      result.stops.push(
        stop(file, 'version-not-literal', `${match[2]} has a computed requirement`, index + 1),
      );
    result.dependencies.push({
      ecosystem: 'rubygems',
      name: match[2],
      declared: requirements.length ? requirements.join(', ') : null,
      file,
      line: index + 1,
      direct: true,
    });
  }
  return result;
}

export function parseGemfileLock(content: string): ParsedManifest {
  const result = empty();
  let section = '';
  for (const [index, line] of content.replace(/\r\n/g, '\n').split('\n').entries()) {
    if (/^\S/.test(line)) section = line.trim();
    // Resolved specs sit four spaces deep under GEM, GIT or PATH `specs:`; their own
    // dependencies sit six deep.
    const spec = /^ {4}([^\s(]+) \(([^)]+)\)$/.exec(line);
    if (spec && ['GEM', 'GIT', 'PATH'].includes(section))
      result.locks.push({
        name: spec[1],
        version: spec[2].replace(/-(?:x86|arm|aarch|java|universal|x64).*$/, ''),
        line: index + 1,
      });
  }
  return result;
}

// --- PHP ----------------------------------------------------------------------------------------

function jsonDocument(content: string, file: string, result: ParsedManifest) {
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
    result.stops.push(stop(file, 'unparseable-json', 'Expected a JSON object'));
  } catch (error) {
    result.stops.push(stop(file, 'unparseable-json', (error as Error).message));
  }
  return undefined;
}

// Platform requirements (php, ext-*, lib-*, composer-*) are not packages.
const COMPOSER_PLATFORM =
  /^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|ext-.+|lib-.+|composer(?:-.+)?)$/;

export function parseComposerJson(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = jsonDocument(content, file, result);
  if (!document) return result;
  for (const section of ['require', 'require-dev']) {
    const entries = document[section];
    if (!entries || typeof entries !== 'object') continue;
    for (const [name, constraint] of Object.entries(entries as Record<string, unknown>)) {
      if (COMPOSER_PLATFORM.test(name.toLowerCase())) continue;
      result.dependencies.push({
        ecosystem: 'packagist',
        name: name.toLowerCase(),
        declared: typeof constraint === 'string' ? constraint : null,
        file,
        line: lineOf(content, `"${name}"`),
        direct: true,
      });
    }
  }
  return result;
}

export function parseComposerLock(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = jsonDocument(content, file, result);
  if (!document) return result;
  for (const section of ['packages', 'packages-dev']) {
    const entries = document[section];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as { name?: unknown; version?: unknown }[]) {
      if (typeof entry?.name !== 'string' || typeof entry.version !== 'string') continue;
      result.locks.push({
        name: entry.name.toLowerCase(),
        version: entry.version.replace(/^v(?=\d)/, ''),
        line: lineOf(content, `"name": "${entry.name}"`),
      });
    }
  }
  return result;
}

// --- Java and Kotlin ----------------------------------------------------------------------------

function xmlDocument(content: string, file: string, result: ParsedManifest) {
  const valid = XMLValidator.validate(content);
  if (valid !== true) {
    result.stops.push(stop(file, 'unparseable-xml', valid.err.msg, valid.err.line));
    return undefined;
  }
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    processEntities: false,
    isArray: (name) =>
      ['dependency', 'PackageReference', 'PackageVersion', 'ItemGroup'].includes(name),
  }).parse(content) as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

export function parsePom(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = xmlDocument(content, file, result);
  const project = document?.project as Record<string, unknown> | undefined;
  if (!project) {
    if (document) result.stops.push(stop(file, 'unparseable-xml', 'No <project> element'));
    return result;
  }
  // Properties defined literally in this POM resolve ${name}; parent POMs are not fetched.
  const properties = new Map<string, string>();
  for (const [name, value] of Object.entries((project.properties ?? {}) as Record<string, unknown>))
    if (text(value) !== undefined) properties.set(name, text(value)!);
  const projectVersion = text(project.version);
  if (projectVersion) properties.set('project.version', projectVersion);
  const dependencies = ((project.dependencies as Record<string, unknown> | undefined)?.dependency ??
    []) as Record<string, unknown>[];
  let from = 0;
  for (const dependency of dependencies) {
    const group = text(dependency.groupId);
    const artifact = text(dependency.artifactId);
    if (!group || !artifact) continue;
    const index = content.indexOf(`<artifactId>${artifact}</artifactId>`, from);
    if (index >= 0) from = index + 1;
    const line = lineOf(content, `<artifactId>${artifact}</artifactId>`, Math.max(index, 0));
    const raw = text(dependency.version);
    let declared: string | null = raw ?? null;
    if (raw?.includes('${')) {
      const resolved = raw.replace(
        /\$\{([^}]+)\}/g,
        (whole, name: string) => properties.get(name) ?? whole,
      );
      declared = resolved.includes('${') ? null : resolved;
      if (declared === null)
        result.stops.push(
          stop(file, 'version-not-literal', `${group}:${artifact} uses ${raw}`, line),
        );
    }
    result.dependencies.push({
      ecosystem: 'maven',
      name: `${group}:${artifact}`,
      declared,
      file,
      line,
      direct: true,
    });
  }
  return result;
}

const GRADLE_CONFIGURATION =
  '(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testCompileOnly|testRuntimeOnly|androidTestImplementation|debugImplementation|releaseImplementation|kapt|ksp|annotationProcessor|compile|testCompile|runtime)';

export function parseGradle(content: string, file: string): ParsedManifest {
  const result = empty();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const coordinate = new RegExp(
    `^\\s*${GRADLE_CONFIGURATION}\\s*\\(?\\s*(?:platform\\s*\\(\\s*)?(["'])([^"':\\s]+):([^"':\\s]+)(?::([^"'\\s]+))?\\1`,
  );
  const named = new RegExp(
    `^\\s*${GRADLE_CONFIGURATION}\\s*\\(?\\s*group\\s*[:=]\\s*(["'])([^"']+)\\1\\s*,\\s*name\\s*[:=]\\s*(["'])([^"']+)\\3(?:\\s*,\\s*version\\s*[:=]\\s*(["'])([^"']+)\\5)?`,
  );
  for (const [index, line] of lines.entries()) {
    const match = coordinate.exec(line);
    const map = match ? undefined : named.exec(line);
    if (!match && !map) continue;
    const group = match ? match[2] : map![2];
    const artifact = match ? match[3] : map![4];
    const version = (match ? match[4] : map![6]) ?? null;
    const literal = version === null || !/[$]/.test(version);
    if (!literal)
      result.stops.push(
        stop(file, 'version-not-literal', `${group}:${artifact} uses ${version}`, index + 1),
      );
    result.dependencies.push({
      ecosystem: 'maven',
      name: `${group}:${artifact}`,
      declared: literal ? version : null,
      file,
      line: index + 1,
      direct: true,
    });
  }
  return result;
}

// gradle/libs.versions.toml: a Gradle version catalog, whose [libraries] become dependencies of
// whichever build file references them. Refit reports them from the catalog file.
export function parseVersionCatalog(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = tomlDocument(content, file, result);
  if (!document) return result;
  const versions = table(document.versions) ?? {};
  for (const [alias, value] of Object.entries(table(document.libraries) ?? {})) {
    let module: string | undefined;
    let version: string | null = null;
    let reference: string | undefined;
    if (typeof value === 'string') {
      const [group, artifact, literal] = value.split(':');
      if (group && artifact) module = `${group}:${artifact}`;
      version = literal ?? null;
    } else {
      const entry = table(value);
      if (typeof entry?.module === 'string') module = entry.module;
      else if (typeof entry?.group === 'string' && typeof entry.name === 'string')
        module = `${entry.group}:${entry.name}`;
      const declared = entry?.version;
      if (typeof declared === 'string') version = declared;
      else if (typeof table(declared)?.ref === 'string') reference = table(declared)!.ref as string;
      else if (typeof table(declared)?.strictly === 'string')
        version = table(declared)!.strictly as string;
      else if (typeof table(declared)?.require === 'string')
        version = table(declared)!.require as string;
    }
    if (!module) continue;
    if (reference !== undefined) {
      const referenced = versions[reference];
      version = typeof referenced === 'string' ? referenced : null;
    }
    result.dependencies.push({
      ecosystem: 'maven',
      name: module,
      declared: version,
      file,
      line: lineOf(content, new RegExp(`^\\s*${escapeRegExp(alias)}\\s*=`, 'm')),
      direct: true,
    });
  }
  return result;
}

// --- .NET ---------------------------------------------------------------------------------------

function itemGroups(document: Record<string, unknown> | undefined) {
  const project = document?.Project as Record<string, unknown> | undefined;
  return (project?.ItemGroup ?? []) as Record<string, unknown>[];
}

export function parseCsproj(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = xmlDocument(content, file, result);
  if (document && !document.Project)
    result.stops.push(stop(file, 'unparseable-xml', 'No <Project> element'));
  let from = 0;
  for (const group of itemGroups(document))
    for (const reference of (group.PackageReference ?? []) as Record<string, unknown>[]) {
      const name = text(reference['@_Include']);
      if (!name) continue;
      const version = text(reference['@_Version']) ?? text(reference.Version) ?? null;
      const index = content.indexOf(`"${name}"`, from);
      if (index >= 0) from = index + 1;
      const line = lineOf(content, `"${name}"`, Math.max(index, 0));
      const literal = version === null || !version.includes('$(');
      if (!literal)
        result.stops.push(stop(file, 'version-not-literal', `${name} uses ${version}`, line));
      result.dependencies.push({
        ecosystem: 'nuget',
        name,
        declared: literal ? version : null,
        file,
        line,
        direct: true,
      });
    }
  return result;
}

// Directory.Packages.props: central package versions for the projects beneath it.
export function parsePackagesProps(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = xmlDocument(content, file, result);
  for (const group of itemGroups(document))
    for (const entry of (group.PackageVersion ?? []) as Record<string, unknown>[]) {
      const name = text(entry['@_Include']);
      const version = text(entry['@_Version']);
      if (name && version && !version.includes('$('))
        result.locks.push({
          name: name.toLowerCase(),
          version,
          line: lineOf(content, `"${name}"`),
        });
    }
  return result;
}

export function parseNugetLock(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = jsonDocument(content, file, result);
  const frameworks = (document?.dependencies ?? {}) as Record<string, Record<string, unknown>>;
  const seen = new Set<string>();
  for (const packages of Object.values(frameworks))
    for (const [name, entry] of Object.entries(packages ?? {})) {
      const resolved = (entry as { resolved?: unknown })?.resolved;
      if (typeof resolved !== 'string' || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      result.locks.push({
        name: name.toLowerCase(),
        version: resolved,
        line: lineOf(content, `"${name}"`),
      });
    }
  return result;
}

// --- Rust ---------------------------------------------------------------------------------------

export function parseCargoToml(content: string, file: string): ParsedManifest {
  const result = empty();
  const document = tomlDocument(content, file, result);
  if (!document) return result;
  const sections: TomlTable[] = [];
  const collect = (owner: TomlTable | undefined) => {
    for (const name of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      const section = table(owner?.[name]);
      if (section) sections.push(section);
    }
  };
  collect(document);
  collect(table(document.workspace));
  for (const target of Object.values(table(document.target) ?? {})) collect(table(target));
  for (const section of sections)
    for (const [key, value] of Object.entries(section)) {
      const entry = table(value);
      // `package = "..."` renames a dependency; the registry name is the package.
      const name = typeof entry?.package === 'string' ? entry.package : key;
      const declared =
        typeof value === 'string'
          ? value
          : typeof entry?.version === 'string'
            ? entry.version
            : entry?.workspace === true
              ? 'workspace'
              : typeof entry?.git === 'string'
                ? `git:${entry.git}`
                : typeof entry?.path === 'string'
                  ? `path:${entry.path}`
                  : null;
      result.dependencies.push({
        ecosystem: 'cargo',
        name,
        declared,
        file,
        line: lineOf(
          content,
          new RegExp(
            `^\\s*(?:${escapeRegExp(key)}\\s*=|\\[[\\w.'"-]*dependencies\\.${escapeRegExp(key)}\\])`,
            'm',
          ),
        ),
        direct: true,
      });
    }
  return result;
}

// --- Discovery and merging ----------------------------------------------------------------------

const REQUIREMENTS = /^requirements[\w.-]*\.(?:txt|in)$/i;

export function manifestKind(name: string): ManifestKind | undefined {
  if (REQUIREMENTS.test(name))
    return { ecosystem: 'pypi', kind: 'manifest', parse: parseRequirements };
  if (name.endsWith('.csproj') || name.endsWith('.fsproj') || name.endsWith('.vbproj'))
    return { ecosystem: 'nuget', kind: 'manifest', parse: parseCsproj };
  switch (name) {
    case 'pyproject.toml':
      return { ecosystem: 'pypi', kind: 'manifest', parse: parsePyproject };
    case 'Pipfile':
      return { ecosystem: 'pypi', kind: 'manifest', parse: parsePipfile };
    case 'Pipfile.lock':
      return { ecosystem: 'pypi', kind: 'lockfile', parse: parsePipfileLock };
    case 'uv.lock':
    case 'poetry.lock':
      return {
        ecosystem: 'pypi',
        kind: 'lockfile',
        parse: (content, file) => packageArrayLock(content, file, normalizePythonName),
      };
    case 'go.mod':
      return { ecosystem: 'go', kind: 'manifest', parse: parseGoMod };
    case 'go.sum':
      return { ecosystem: 'go', kind: 'lockfile', parse: parseGoSum };
    case 'Gemfile':
    case 'gems.rb':
      return { ecosystem: 'rubygems', kind: 'manifest', parse: parseGemfile };
    case 'Gemfile.lock':
    case 'gems.locked':
      return { ecosystem: 'rubygems', kind: 'lockfile', parse: parseGemfileLock };
    case 'composer.json':
      return { ecosystem: 'packagist', kind: 'manifest', parse: parseComposerJson };
    case 'composer.lock':
      return { ecosystem: 'packagist', kind: 'lockfile', parse: parseComposerLock };
    case 'pom.xml':
      return { ecosystem: 'maven', kind: 'manifest', parse: parsePom };
    case 'build.gradle':
    case 'build.gradle.kts':
      return { ecosystem: 'maven', kind: 'manifest', parse: parseGradle };
    case 'libs.versions.toml':
      return { ecosystem: 'maven', kind: 'manifest', parse: parseVersionCatalog };
    case 'Directory.Packages.props':
      return { ecosystem: 'nuget', kind: 'lockfile', parse: parsePackagesProps };
    case 'packages.lock.json':
      return { ecosystem: 'nuget', kind: 'lockfile', parse: parseNugetLock };
    case 'Cargo.toml':
      return { ecosystem: 'cargo', kind: 'manifest', parse: parseCargoToml };
    case 'Cargo.lock':
      return {
        ecosystem: 'cargo',
        kind: 'lockfile',
        parse: (content, file) => packageArrayLock(content, file, (name) => name),
      };
  }
  return undefined;
}

// The key a dependency is matched to its lock entry by: registry names that compare
// case-insensitively (NuGet, Packagist) are lower-cased.
function lockKey(ecosystem: Ecosystem, name: string) {
  return ecosystem === 'nuget' || ecosystem === 'packagist' ? name.toLowerCase() : name;
}

// Lists every manifest and lockfile under `directory` (skipping installed and build output), parses
// them, and gives each declared dependency the version the nearest lockfile of its ecosystem pins:
// one in the manifest's directory or, for workspaces, an ancestor directory.
export async function readPackageManifests(directory: string): Promise<PackageInventory> {
  const root = await realpath(directory);
  const found: { file: string; kind: ManifestKind }[] = [];
  let entries = 0;
  async function visit(path: string): Promise<void> {
    const children = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const child of children) {
      if ((entries += 1) > MAX_ENTRIES) return;
      if (child.isSymbolicLink()) continue;
      const childPath = join(path, child.name);
      if (child.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(child.name)) await visit(childPath);
        continue;
      }
      const kind = child.isFile() ? manifestKind(child.name) : undefined;
      if (kind) found.push({ file: relative(root, childPath).split('\\').join('/'), kind });
    }
  }
  await visit(root);
  const inventory: PackageInventory = { manifests: [], dependencies: [], stops: [] };
  const parsed = new Map<string, ParsedManifest>();
  const read = async (file: string, kind: ManifestKind) => {
    const path = join(root, file);
    if ((await stat(path)).size > MAX_MANIFEST_BYTES) {
      inventory.stops.push(stop(file, 'manifest-too-large', 'Larger than 4 MiB; not read'));
      return empty();
    }
    // A UTF-8 byte-order mark (common in .csproj files) is not part of the document.
    return kind.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''), file);
  };
  for (const { file, kind } of found) {
    inventory.manifests.push({ file, ecosystem: kind.ecosystem, kind: kind.kind });
    parsed.set(file, await read(file, kind));
  }
  // Follow -r includes, which may name files outside the requirements*.txt pattern (base.txt).
  const pending = [...parsed].flatMap(([from, result]) =>
    result.includes.map((include) => ({ ...include, from })),
  );
  while (pending.length) {
    const include = pending.shift()!;
    if (parsed.has(include.file)) continue;
    if (include.file.startsWith('../') || posix.isAbsolute(include.file)) {
      inventory.stops.push(
        stop(include.from, 'include-outside-repository', `-r ${include.file}`, include.line),
      );
      continue;
    }
    const path = join(root, include.file);
    if (!(await stat(path).catch(() => undefined))?.isFile()) {
      inventory.stops.push(
        stop(include.from, 'include-missing', `-r ${include.file}`, include.line),
      );
      continue;
    }
    const kind = manifestKind('requirements.txt')!;
    inventory.manifests.push({ file: include.file, ecosystem: 'pypi', kind: 'manifest' });
    const result = await read(include.file, kind);
    parsed.set(include.file, result);
    for (const next of result.includes) pending.push({ ...next, from: include.file });
  }
  // Pinned versions by source, ecosystem and directory. Directory.Packages.props declares central
  // NuGet versions for the projects beneath it rather than locking them.
  const pins = new Map<string, Map<string, string[]>>();
  for (const [file, result] of parsed) {
    const kind = manifestKind(posix.basename(file)) ?? manifestKind('requirements.txt')!;
    if (kind.kind !== 'lockfile') continue;
    const source = posix.basename(file) === 'Directory.Packages.props' ? 'central' : 'lock';
    const key = `${source}\0${kind.ecosystem}\0${posix.dirname(file)}`;
    const versions = pins.get(key) ?? new Map<string, string[]>();
    for (const lock of result.locks) {
      const name = lockKey(kind.ecosystem, lock.name);
      const listed = versions.get(name) ?? [];
      if (!listed.includes(lock.version)) listed.push(lock.version);
      versions.set(name, listed);
    }
    pins.set(key, versions);
  }
  // The nearest pin in the manifest's directory or an ancestor (workspaces lock at their root).
  // go.sum lists every version the module graph visited, so it confirms go.mod's version only.
  const nearest = (source: string, dependency: Omit<ManifestDependency, 'locked'>) => {
    for (let folder = posix.dirname(dependency.file); ; folder = posix.dirname(folder)) {
      const versions = pins
        .get(`${source}\0${dependency.ecosystem}\0${folder}`)
        ?.get(lockKey(dependency.ecosystem, dependency.name));
      if (versions && dependency.ecosystem === 'go')
        return dependency.declared && versions.includes(dependency.declared)
          ? dependency.declared
          : null;
      if (versions) return versions[0];
      if (folder === '.' || folder === '/') return null;
    }
  };
  for (const result of parsed.values()) {
    inventory.stops.push(...result.stops);
    for (const dependency of result.dependencies)
      inventory.dependencies.push({
        ...dependency,
        declared: dependency.declared ?? nearest('central', dependency),
        locked: nearest('lock', dependency),
      });
  }
  return inventory;
}

// Whether a dependency is one of a catalog entry's packages in that ecosystem. Go modules match at
// any major version suffix (github.com/stripe/stripe-go matches github.com/stripe/stripe-go/v82).
export function matchesPackage(dependency: ManifestDependency, name: string) {
  switch (dependency.ecosystem) {
    case 'pypi':
      return dependency.name === normalizePythonName(name);
    case 'nuget':
    case 'packagist':
      return dependency.name.toLowerCase() === name.toLowerCase();
    case 'go':
      return (
        dependency.name === name ||
        new RegExp(`^${escapeRegExp(name)}/v\\d+$`).test(dependency.name)
      );
    default:
      return dependency.name === name;
  }
}
