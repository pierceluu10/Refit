// Scanners for the platform a repo runs on: language runtimes, container images and CI. Like
// scanners.ts they return raw signals with file and 1-based line numbers and never decide what
// matters; the agent reads the lines they point to.
import path from 'node:path';
import { listFiles } from './repo-files.ts';
import { lineMatch, readLines } from './scanners.ts';
import type { VersionSignal } from './scanners.ts';

type Groups = Record<string, string | undefined>;
// `file` is tested against the file's base name. `section` limits a rule to lines under a TOML
// table or JSON object of that name.
type Rule = { file: RegExp; source: string; pattern: RegExp; section?: RegExp };
type RuntimeRule = Rule & { name?: string };
type RuleHit<R extends Rule> = { rule: R; groups: Groups; index: number };
type NameVersion = { name: string; version?: string };

const COMMENT = /(?:^|\s)#.*$/;
const SECTION_START = /^(?:\[([^\]]+)\]|"([^"]+)"\s*:\s*\{)\s*$/;
const DOCKER_PREFIX = 'docker://';

function cleanValue(raw: string): string {
  return raw
    .trim()
    .replace(/,$/, '')
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();
}

function rulesFor<R extends Rule>(rules: R[], file: string): R[] {
  const name = path.posix.basename(file);
  return rules.filter((rule) => rule.file.test(name));
}

// Applies every rule line by line. JSON keeps `#` inside strings, so only other formats lose
// trailing comments.
function matchRules<R extends Rule>(file: string, lines: string[], rules: R[]): RuleHit<R>[] {
  const isJson = file.endsWith('.json');
  const hits: RuleHit<R>[] = [];
  let section = '';
  lines.forEach((raw, index) => {
    const line = (isJson ? raw : raw.replace(COMMENT, '')).trim();
    const start = SECTION_START.exec(line);
    if (start) section = start[1] ?? start[2];
    else if (line.startsWith('}')) section = '';
    for (const rule of rules) {
      if (rule.section && !rule.section.test(section)) continue;
      const groups = rule.pattern.exec(line)?.groups;
      if (groups) hits.push({ rule, groups, index });
    }
  });
  return hits;
}

async function scanFiles(
  repoDir: string,
  files: string[],
  wanted: (file: string) => boolean,
  read: (file: string, lines: string[]) => VersionSignal[],
): Promise<VersionSignal[]> {
  const signals: VersionSignal[] = [];
  for (const file of files) {
    const lines = wanted(file) ? await readLines(repoDir, file) : undefined;
    if (lines) signals.push(...read(file, lines));
  }
  return signals;
}

// "nodejs16.x" is node 16.x and "@vercel/node@3.0.0" is @vercel/node 3.0.0; anything else stays whole.
function splitRuntime(identifier: string): NameVersion {
  const match = /^(@?[^@]+)@(.+)$/.exec(identifier) ?? /^([a-z]+)(\d[\w.]*)$/i.exec(identifier);
  return match ? { name: match[1], version: match[2] } : { name: identifier };
}

// Registry ports and tags both use a colon; only a colon after the last slash starts a tag.
function splitImage(reference: string): NameVersion {
  const digestAt = reference.indexOf('@');
  const repository = digestAt === -1 ? reference : reference.slice(0, digestAt);
  const digest = digestAt === -1 ? undefined : reference.slice(digestAt + 1);
  const tagAt = repository.lastIndexOf(':');
  const hasTag = tagAt > repository.lastIndexOf('/');
  const tag = hasTag ? repository.slice(tagAt + 1) : undefined;
  return {
    name: hasTag ? repository.slice(0, tagAt) : repository,
    version: [tag, digest].filter(Boolean).join('@') || undefined,
  };
}

// ---- Runtime versions ----

const RUNTIME_ALIASES: Record<string, string> = { nodejs: 'node' };
const WHOLE_LINE = /^(?<version>.+)$/;
const PACKAGE_JSON_TOOL = /^"(?<name>node|npm|pnpm|yarn)"\s*:\s*"(?<version>[^"]*)"/;

const RUNTIME_RULES: RuntimeRule[] = [
  { file: /^\.nvmrc$/, source: '.nvmrc', name: 'node', pattern: WHOLE_LINE },
  { file: /^\.node-version$/, source: '.node-version', name: 'node', pattern: WHOLE_LINE },
  { file: /^\.python-version$/, source: '.python-version', name: 'python', pattern: WHOLE_LINE },
  { file: /^\.ruby-version$/, source: '.ruby-version', name: 'ruby', pattern: WHOLE_LINE },
  {
    file: /^\.tool-versions$/,
    source: '.tool-versions',
    pattern: /^(?<name>\S+)\s+(?<version>.+)$/,
  },
  {
    file: /^runtime\.txt$/,
    source: 'runtime.txt',
    pattern: /^(?<name>[a-z]+)-(?<version>.+)$/i,
  },
  {
    file: /^package\.json$/,
    source: 'package.json engines',
    section: /^engines$/,
    pattern: PACKAGE_JSON_TOOL,
  },
  {
    file: /^package\.json$/,
    source: 'package.json volta',
    section: /^volta$/,
    pattern: PACKAGE_JSON_TOOL,
  },
  {
    file: /^package\.json$/,
    source: 'package.json packageManager',
    pattern: /^"packageManager"\s*:\s*"(?<name>[^@"]+)@(?<version>[^"]+)"/,
  },
  {
    file: /^pyproject\.toml$/,
    source: 'pyproject.toml requires-python',
    name: 'python',
    pattern: /^requires-python\s*=\s*(?<version>.+)$/,
  },
  {
    file: /^pyproject\.toml$/,
    source: 'pyproject.toml poetry python',
    name: 'python',
    section: /^tool\.poetry\.dependencies$/,
    pattern: /^python\s*=\s*(?<version>.+)$/,
  },
  {
    file: /^setup\.cfg$/,
    source: 'setup.cfg python_requires',
    name: 'python',
    pattern: /^python_requires\s*=\s*(?<version>.+)$/,
  },
  {
    file: /^setup\.py$/,
    source: 'setup.py python_requires',
    name: 'python',
    pattern: /\bpython_requires\s*=\s*["'](?<version>[^"']+)["']/,
  },
  {
    file: /^Pipfile$/,
    source: 'Pipfile python_version',
    name: 'python',
    pattern: /^python_(?:full_)?version\s*=\s*(?<version>.+)$/,
  },
  {
    file: /^go\.mod$/,
    source: 'go.mod',
    name: 'go',
    pattern: /^(?:go\s+|toolchain\s+go)(?<version>\d\S*)$/,
  },
  {
    file: /^serverless.*\.ya?ml$/,
    source: 'serverless.yml runtime',
    pattern: /^runtime:\s*(?<identifier>.+)$/,
  },
  {
    file: /\.(?:ya?ml|json|template)$/,
    source: 'CloudFormation Runtime',
    pattern: /^"?Runtime"?\s*:\s*(?<identifier>.+)$/,
  },
  { file: /\.tf$/, source: 'terraform runtime', pattern: /^runtime\s*=\s*(?<identifier>.+)$/ },
  {
    file: /^app\.ya?ml$/,
    source: 'app.yaml runtime',
    pattern: /^runtime:\s*(?<identifier>.+)$/,
  },
  {
    file: /^vercel\.json$/,
    source: 'vercel.json runtime',
    pattern: /"runtime"\s*:\s*"(?<identifier>[^"]*)"/,
  },
  {
    file: /^netlify\.toml$/,
    source: 'netlify.toml',
    pattern: /^(?<name>NODE|PYTHON)_VERSION\s*=\s*(?<version>.+)$/,
  },
];

function runtimeSignal(
  file: string,
  lines: string[],
  { rule, groups, index }: RuleHit<RuntimeRule>,
): VersionSignal {
  const found: NameVersion =
    groups.identifier === undefined
      ? {
          name: (groups.name ?? rule.name) as string,
          version: groups.version === undefined ? undefined : cleanValue(groups.version),
        }
      : splitRuntime(cleanValue(groups.identifier));
  const name = found.name.toLowerCase();
  return {
    ...lineMatch(file, index, lines[index]),
    name: RUNTIME_ALIASES[name] ?? name,
    version: found.version,
    source: rule.source,
  };
}

// shortcut: a one-line `"engines": { "node": "18" }` object is missed, switch to JSON.parse with
// a line lookup if hand-minified package.json files matter.
export async function findRuntimeVersions(repoDir: string): Promise<{ signals: VersionSignal[] }> {
  const signals = await scanFiles(
    repoDir,
    await listFiles(repoDir),
    (file) => rulesFor(RUNTIME_RULES, file).length > 0,
    (file, lines) =>
      matchRules(file, lines, rulesFor(RUNTIME_RULES, file)).map((hit) =>
        runtimeSignal(file, lines, hit),
      ),
  );
  return { signals };
}

// ---- Container images ----

const DOCKERFILE_NAME = /^(?:dockerfile(?:\..+)?|.+\.dockerfile|containerfile(?:\..+)?)$/i;
const ARG_DEFAULT = /^ARG\s+(\w+)=(.*)$/i;
const FROM_LINE = /^FROM\s+(?:--platform=\S+\s+)?(?<image>\S+)(?:\s+AS\s+(?<stage>\S+))?/i;
const BUILD_ARG_REFERENCE = /\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g;
const EMPTY_IMAGE = 'scratch';

const IMAGE_RULES: Rule[] = [
  {
    file: /\.ya?ml$/,
    source: 'yaml image',
    pattern: /^(?:-\s+)?image:\s*(?<reference>[\w"'$].*)$/,
  },
  {
    file: /\.ya?ml$/,
    source: 'yaml container',
    pattern: /^(?:-\s+)?container:\s*(?<reference>[\w"'$].*)$/,
  },
  {
    file: /^\.?devcontainer\.json$/,
    source: 'devcontainer.json image',
    pattern: /^(?:\{\s*)?"image"\s*:\s*"(?<reference>[^"]+)"/,
  },
];

function isDockerfile(file: string): boolean {
  return DOCKERFILE_NAME.test(path.posix.basename(file));
}

// Unknown variables stay as written so the agent sees the unresolved reference.
function resolveBuildArgs(text: string, args: Map<string, string>): string {
  return text.replace(
    BUILD_ARG_REFERENCE,
    (whole: string, braced?: string, fallback?: string, bare?: string) =>
      args.get((braced ?? bare) as string) ?? fallback ?? whole,
  );
}

function dockerfileImages(file: string, lines: string[]): VersionSignal[] {
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const signals: VersionSignal[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const arg = ARG_DEFAULT.exec(line);
    if (arg) args.set(arg[1], cleanValue(arg[2]));
    const from = FROM_LINE.exec(line)?.groups;
    if (!from) return;
    const earlierStage = stages.has(from.image.toLowerCase());
    if (from.stage) stages.add(from.stage.toLowerCase());
    if (earlierStage || from.image.toLowerCase() === EMPTY_IMAGE) return;
    signals.push({
      ...lineMatch(file, index, raw),
      ...splitImage(resolveBuildArgs(from.image, args)),
      source: 'Dockerfile FROM',
    });
  });
  return signals;
}

// shortcut: GitLab's `image:\n  name: x` form and bare `services:\n  - postgres:14` entries are
// missed, add a rule for them if GitLab repos matter.
export async function findContainerImages(repoDir: string): Promise<{ signals: VersionSignal[] }> {
  const signals = await scanFiles(
    repoDir,
    await listFiles(repoDir),
    (file) => isDockerfile(file) || rulesFor(IMAGE_RULES, file).length > 0,
    (file, lines) => [
      ...(isDockerfile(file) ? dockerfileImages(file, lines) : []),
      ...matchRules(file, lines, rulesFor(IMAGE_RULES, file)).map(({ rule, groups, index }) => ({
        ...lineMatch(file, index, lines[index]),
        ...splitImage(cleanValue(groups.reference as string)),
        source: rule.source,
      })),
    ],
  );
  return { signals };
}

// ---- CI versions ----

const CI_FILE = /^\.github\/(?:workflows\/[^/]+|actions\/(?:.+\/)?action)\.ya?ml$/;
const OTHER_CI_FILE =
  /(?:^|\/)(?:\.gitlab-ci\.ya?ml|\.travis\.ya?ml|\.drone\.ya?ml|\.woodpecker\.ya?ml|\.?appveyor\.ya?ml|azure-pipelines[^/]*\.ya?ml|bitbucket-pipelines\.ya?ml|bitrise\.ya?ml|buildspec\.ya?ml|cloudbuild\.ya?ml|codemagic\.ya?ml|Jenkinsfile[^/]*|\.circleci\/config\.ya?ml|\.buildkite\/[^/]+\.ya?ml|\.gitlab\/ci\/[^/]+\.ya?ml|\.woodpecker\/[^/]+\.ya?ml)$/;
const KEY_VALUE = /^(?<key>[\w.-]+):(?:\s+(?<value>.*))?$/;
const LIST_ITEM = /^-\s+(?<item>.*)$/;
const MAPPING_ITEM = /^[\w.-]+:(?:\s|$)/;
const VERSION_KEY = /^(?<runtime>[\w-]+)-version$/;
const FLOW_LIST = /^\[(.*)\]$/;

type Scope = { key: 'matrix' | 'with'; indent: number };
type ListTarget = { name: string; source: string };

function splitAction(reference: string): NameVersion {
  if (reference.startsWith(DOCKER_PREFIX)) return splitImage(reference);
  const at = reference.lastIndexOf('@');
  return at > 0
    ? { name: reference.slice(0, at), version: reference.slice(at + 1) }
    : { name: reference };
}

function expandValue(value: string): string[] {
  const list = FLOW_LIST.exec(value);
  return list ? list[1].split(',').map(cleanValue).filter(Boolean) : [cleanValue(value)];
}

// Reads a workflow or composite action. A key with no value on its line takes the `- item` lines
// that follow, which is how multi-line matrix lists and runs-on lists are written.
function ciSignals(file: string, lines: string[]): VersionSignal[] {
  const signals: VersionSignal[] = [];
  let scope: Scope | undefined;
  let pending: ListTarget | undefined;
  lines.forEach((raw, index) => {
    const line = raw.replace(COMMENT, '');
    if (line.trim() === '') return;
    const indent = line.search(/\S/);
    if (scope && indent <= scope.indent) scope = undefined;
    const text = line.trim();
    const item = LIST_ITEM.exec(text)?.groups?.item;
    const add = (name: string, version: string | undefined, source: string) =>
      signals.push({ ...lineMatch(file, index, raw), name, version, source });
    if (item !== undefined && pending && !MAPPING_ITEM.test(item)) {
      add(pending.name, cleanValue(item), pending.source);
      return;
    }
    pending = undefined;
    const entry = KEY_VALUE.exec(item ?? text)?.groups;
    if (!entry) return;
    const { key } = entry;
    const value = (entry.value ?? '').trim();
    if (key === 'uses' && value) {
      const action = splitAction(cleanValue(value));
      if (!action.name.startsWith('.')) add(action.name, action.version, 'workflow uses');
      return;
    }
    let target: ListTarget | undefined;
    if (scope?.key === 'matrix') {
      target = { name: key, source: 'workflow matrix' };
    } else if (scope?.key === 'with') {
      const runtime = VERSION_KEY.exec(key)?.groups?.runtime;
      if (runtime) target = { name: runtime, source: `workflow ${key}` };
    } else if (key === 'runs-on') {
      target = { name: 'runner', source: 'workflow runs-on' };
    }
    if (!value && (key === 'matrix' || key === 'with')) scope = { key, indent };
    if (!target) return;
    if (value) {
      for (const version of expandValue(value)) add(target.name, version, target.source);
    } else {
      pending = target;
    }
  });
  return signals;
}

export async function findCiVersions(
  repoDir: string,
): Promise<{ signals: VersionSignal[]; otherCiFiles: string[] }> {
  const files = await listFiles(repoDir);
  return {
    signals: await scanFiles(repoDir, files, (file) => CI_FILE.test(file), ciSignals),
    otherCiFiles: files.filter((file) => OTHER_CI_FILE.test(file)),
  };
}
