import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCommittedFile, type readCommittedRepository } from './committed-repository.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_DECLARATION_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

// The official Node.js images whose release Refit compares with a repository's declarations. The
// approved configuration chooses the image; only a root engines.node that excludes its release
// switches validation to another of these, which Refit pulls when it is not installed.
export const NODE_18_IMAGE = 'node:18-alpine';
export const NODE_20_IMAGE = 'node:20-alpine';
export const NODE_22_IMAGE = 'node:22-alpine';
export const NODE_24_IMAGE = 'node:24-alpine';
export const VALIDATION_NODE_IMAGES = [NODE_18_IMAGE, NODE_20_IMAGE, NODE_22_IMAGE, NODE_24_IMAGE];

// Source: https://nodejs.org/dist/index.json ("lts" field of each release line), read 2026-10-22.
const LTS_CODENAMES: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

export type NodeDeclarationSource =
  '.nvmrc' | '.node-version' | 'engines.node' | 'volta.node' | '.tool-versions';

export interface NodeDeclaration {
  source: NodeDeclarationSource;
  value: string;
}

type Version = [number, number, number];
interface Bound {
  version: Version;
  inclusive: boolean;
}
// One comparator set: every version between the bounds. A range is a union of sets.
interface Interval {
  lower: Bound | null;
  upper: Bound | null;
}

const compare = (left: Version, right: Version) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

function unreadable(declaration: NodeDeclaration): never {
  throw new PipelineInputError(
    `Validation cannot read ${declaration.source} ${JSON.stringify(declaration.value)} as a Node.js version or range.`,
  );
}

const PART = '(\\d+|[xX*])';
const PARTIAL = new RegExp(`^v?${PART}(?:\\.${PART})?(?:\\.${PART})?$`);

// A partial version as the versions it covers: `18` is 18.0.0 up to 19.0.0.
function partial(text: string) {
  const match = PARTIAL.exec(text);
  if (!match) return null;
  const parts: number[] = [];
  for (const part of match.slice(1)) {
    if (part === undefined || /^[xX*]$/.test(part)) break;
    parts.push(Number(part));
  }
  if (!parts.length) return { from: null, to: null, parts };
  const from: Version = [parts[0], parts[1] ?? 0, parts[2] ?? 0];
  const to: Version =
    parts.length === 3
      ? from
      : parts.length === 2
        ? [parts[0], parts[1] + 1, 0]
        : [parts[0] + 1, 0, 0];
  return { from, to, parts };
}

const atLeast = (version: Version): Bound => ({ version, inclusive: true });
const below = (version: Version): Bound => ({ version, inclusive: false });

function comparatorInterval(token: string): Interval | null {
  const match = /^(<=|>=|<|>|=|~|\^)?(.*)$/.exec(token)!;
  const operator = match[1] ?? '';
  const range = partial(match[2]);
  if (!range) return null;
  const { from, to, parts } = range;
  if (!from || !to)
    return operator === '<'
      ? { lower: null, upper: below([0, 0, 0]) }
      : {
          lower: null,
          upper: null,
        };
  const exact = parts.length === 3;
  switch (operator) {
    case '>=':
      return { lower: atLeast(from), upper: null };
    case '>':
      return { lower: exact ? { version: from, inclusive: false } : atLeast(to), upper: null };
    case '<':
      return { lower: null, upper: below(from) };
    case '<=':
      return { lower: null, upper: exact ? { version: from, inclusive: true } : below(to) };
    case '~':
      return {
        lower: atLeast(from),
        upper: below(parts.length === 1 ? [from[0] + 1, 0, 0] : [from[0], from[1] + 1, 0]),
      };
    case '^': {
      const upper: Version =
        from[0] > 0 || parts.length === 1
          ? [from[0] + 1, 0, 0]
          : from[1] > 0 || parts.length === 2
            ? [0, from[1] + 1, 0]
            : [0, 0, from[2] + 1];
      return { lower: atLeast(from), upper: below(upper) };
    }
    default:
      return exact
        ? { lower: atLeast(from), upper: { version: from, inclusive: true } }
        : { lower: atLeast(from), upper: below(to) };
  }
}

function intersect(left: Interval, right: Interval): Interval {
  const lower =
    !left.lower || !right.lower
      ? (left.lower ?? right.lower)
      : compare(left.lower.version, right.lower.version) > 0 ||
          (compare(left.lower.version, right.lower.version) === 0 && !left.lower.inclusive)
        ? left.lower
        : right.lower;
  const upper =
    !left.upper || !right.upper
      ? (left.upper ?? right.upper)
      : compare(left.upper.version, right.upper.version) < 0 ||
          (compare(left.upper.version, right.upper.version) === 0 && !left.upper.inclusive)
        ? left.upper
        : right.upper;
  return { lower, upper };
}

// npm's range grammar (node-semver) without prerelease tags: `||` unions, hyphen ranges, x-ranges,
// tilde, caret and comparators.
function npmRange(declaration: NodeDeclaration): Interval[] {
  return declaration.value.split('||').map((alternative) => {
    const text = alternative.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const from = partial(hyphen[1]);
      const to = partial(hyphen[2]);
      if (!from || !to) unreadable(declaration);
      return {
        lower: from.from ? atLeast(from.from) : null,
        upper: !to.to
          ? null
          : to.parts.length === 3
            ? { version: to.to, inclusive: true }
            : below(to.to),
      };
    }
    const tokens = text
      .replace(/(<=|>=|<|>|=|~|\^)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    let interval: Interval = { lower: null, upper: null };
    for (const token of tokens) {
      const next = comparatorInterval(token);
      if (!next) unreadable(declaration);
      interval = intersect(interval, next);
    }
    return interval;
  });
}

// Version-manager files pin one release line; Refit's images carry the newest release of each
// line, so a pinned version counts as its major (18.17.0 accepts any 18.x).
function releaseLine(declaration: NodeDeclaration): Interval[] {
  const value = declaration.value.trim().toLowerCase();
  if (['node', 'stable', 'latest', 'current', 'lts', 'lts/*', 'lts-*'].includes(value))
    return [{ lower: null, upper: null }];
  const codename = /^lts[/-]([a-z]+)$/.exec(value)?.[1];
  const major = codename
    ? LTS_CODENAMES[codename]
    : Number(/^v?(\d+)(?:\.\d+){0,2}$/.exec(value)?.[1]);
  if (!Number.isInteger(major)) unreadable(declaration);
  return [{ lower: atLeast([major, 0, 0]), upper: below([major + 1, 0, 0]) }];
}

function declarationRange(declaration: NodeDeclaration) {
  return declaration.source === 'engines.node' ? npmRange(declaration) : releaseLine(declaration);
}

function contains(interval: Interval, version: Version) {
  const lower = interval.lower && compare(version, interval.lower.version);
  const upper = interval.upper && compare(version, interval.upper.version);
  return (
    (lower === null || lower > 0 || (lower === 0 && interval.lower!.inclusive)) &&
    (upper === null || upper < 0 || (upper === 0 && interval.upper!.inclusive))
  );
}

function parseVersion(version: string): Version {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new PipelineInputError(`"${version}" is not a Node.js release version.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Whether a release version is inside an npm dependency range, read with the grammar above. A
// prerelease, or a range it cannot read (a tag, an alias, a URL), answers false.
export function satisfiesNpmRange(version: string, range: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const parsed: Version = [Number(match[1]), Number(match[2]), Number(match[3])];
  try {
    return npmRange({ source: 'engines.node', value: range }).some((interval) =>
      contains(interval, parsed),
    );
  } catch {
    return false;
  }
}

export function satisfiesNodeDeclarations(version: string, declarations: NodeDeclaration[]) {
  const parsed = parseVersion(version);
  return declarations.every((declaration) =>
    declarationRange(declaration).some((interval) => contains(interval, parsed)),
  );
}

// Reads the root files that declare a Node.js version. `read` returns a committed file's text, or
// undefined when the repository does not commit it.
export async function nodeDeclarations(read: (path: string) => Promise<string | undefined>) {
  const declarations: NodeDeclaration[] = [];
  for (const source of ['.nvmrc', '.node-version'] as const) {
    // nvm accepts comment lines; the first other line is the version.
    const value = (await read(source))
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (value) declarations.push({ source, value });
  }
  const manifestText = await read('package.json');
  if (manifestText !== undefined) {
    const manifest = parseObject(manifestText, 'package.json');
    for (const [source, section] of [
      ['engines.node', manifest.engines],
      ['volta.node', manifest.volta],
    ] as const) {
      if (!isObject(section) || section.node === undefined) continue;
      if (typeof section.node !== 'string')
        throw new PipelineInputError(`Validation cannot read a non-string ${source}.`);
      // npm treats an empty engines range as any version.
      if (section.node.trim()) declarations.push({ source, value: section.node.trim() });
    }
  }
  const line = (await read('.tool-versions'))
    ?.split(/\r?\n/)
    .map((entry) => entry.replace(/#.*$/, '').trim().split(/\s+/))
    .find(([tool]) => tool === 'nodejs' || tool === 'node');
  // asdf uses the first listed version.
  if (line?.[1]) declarations.push({ source: '.tool-versions', value: line[1] });
  for (const declaration of declarations) declarationRange(declaration);
  return declarations;
}

export function readNodeDeclarations(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
) {
  return nodeDeclarations(async (path) =>
    snapshot.entries.some((entry) => entry.slice(entry.indexOf('\t') + 1) === path)
      ? readCommittedFile(
          snapshot,
          path,
          path === 'package.json' ? MAX_MANIFEST_BYTES : MAX_DECLARATION_BYTES,
        )
      : undefined,
  );
}

// The Node.js release an official image carries, or null when the image is not installed.
async function imageNodeVersion(image: string) {
  try {
    const result = await execute(
      'docker',
      ['image', 'inspect', '--format', '{{json .Config.Env}}', image],
      { timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_DECLARATION_BYTES },
    );
    const environment: unknown = JSON.parse(result.stdout);
    const entry = Array.isArray(environment)
      ? environment.find((value) => typeof value === 'string' && value.startsWith('NODE_VERSION='))
      : undefined;
    if (typeof entry !== 'string')
      throw new PipelineInputError(`${image} does not record its Node.js version (NODE_VERSION).`);
    return entry.slice('NODE_VERSION='.length);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && /No such image/i.test(stderr)) return null;
    throw error;
  }
}

const PULL_TIMEOUT_MS = 300_000;

// The Node.js release of an allowed official image, pulled when missing; null when Docker cannot
// pull it (no network), so validation keeps the configured image.
async function pulledNodeVersion(image: string) {
  const installed = await imageNodeVersion(image);
  if (installed !== null) return installed;
  try {
    await execute('docker', ['pull', '-q', image], {
      timeout: PULL_TIMEOUT_MS,
      maxBuffer: MAX_DECLARATION_BYTES,
    });
  } catch {
    return null;
  }
  return imageNodeVersion(image);
}

const describe = (declarations: NodeDeclaration[]) =>
  declarations.map(({ source, value }) => `${source} ${JSON.stringify(value)}`).join(' and ');

export interface ValidationRuntime {
  configured: string;
  image: string;
  nodeVersion: string | null;
  declarations: NodeDeclaration[];
  reason: string;
}

// The approved configuration chooses the image. For an allowlisted image, the repository's Node.js
// declarations are read and compared with its release for the report. When the root engines.node
// excludes that release (npm's --engine-strict install then fails with EBADENGINE), validation
// moves to the newest allowed image engines.node accepts, for validation only; no other
// declaration changes the image, and none stops validation.
export async function selectValidationRuntime(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
  configured: string,
): Promise<ValidationRuntime> {
  const keep = (
    reason: string,
    declarations: NodeDeclaration[] = [],
    nodeVersion: string | null = null,
  ) => ({
    configured,
    image: configured,
    nodeVersion,
    declarations,
    reason,
  });
  if (!VALIDATION_NODE_IMAGES.includes(configured))
    return keep(
      'The configured image is not one of the Node.js images Refit compares declarations with.',
    );
  const nodeVersion = await imageNodeVersion(configured);
  let declarations: NodeDeclaration[];
  try {
    declarations = await readNodeDeclarations(snapshot);
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return keep(error.message, [], nodeVersion);
  }
  if (!declarations.length)
    return keep('The repository declares no Node.js version.', declarations, nodeVersion);
  const engines = declarations.filter((declaration) => declaration.source === 'engines.node');
  if (nodeVersion !== null && engines.length && !satisfiesNodeDeclarations(nodeVersion, engines))
    for (const image of [...VALIDATION_NODE_IMAGES].reverse()) {
      const major = Number(/^node:(\d+)-alpine$/.exec(image)![1]);
      // Pulls only an image whose release line can satisfy the range.
      if (
        image === configured ||
        ![`${major}.0.0`, `${major}.999.999`].some((version) =>
          satisfiesNodeDeclarations(version, engines),
        )
      )
        continue;
      const version = await pulledNodeVersion(image);
      if (version !== null && satisfiesNodeDeclarations(version, engines))
        return {
          configured,
          image,
          nodeVersion: version,
          declarations,
          reason: `engines.node ${JSON.stringify(engines[0].value)} excludes Node.js ${nodeVersion} on ${configured}, so Refit prepares and checks the repository on ${image} (Node.js ${version}), the newest official image it accepts, for validation only.`,
        };
    }
  return keep(
    nodeVersion !== null && satisfiesNodeDeclarations(nodeVersion, declarations)
      ? `The configured image satisfies ${describe(declarations)}.`
      : `The configured image does not satisfy ${describe(declarations)}; only the approved configuration chooses the image, so the baseline check shows whether the repository works there.`,
    declarations,
    nodeVersion,
  );
}
