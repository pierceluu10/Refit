// The agent's tool registry. Tools return information and never block the agent.
// The only refusal is a path outside the sandbox (hard limit 1); all output is redacted (hard limit 4).
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTool } from '../shared/types.ts';
import {
  detectPackageManager,
  installCommand,
  packageManagerBinary,
  packageManagerVersion,
  runChecks,
  runChecksOnRuntime,
  type PackageManager,
} from './checks.ts';
import { renderRecipes } from './prompt.ts';
import { proofOutputPassed } from './proof/index.ts';
import { parseRuntime, runHost, runtimeImage } from './sandbox.ts';
import { redactSecrets } from './secrets.ts';
import { runPassed } from './validators.ts';
import type {
  ExecResult,
  FinishReport,
  Runtime,
  RuntimeRunner,
  Sandbox,
  ToolContext,
} from './types.ts';

type Args = Record<string, unknown>;

const MAX_OUTPUT = 20_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm-store']);
const LIST_CAP = 500;
const SEARCH_CAP = 200;
const SEARCH_MAX_FILE_BYTES = 1_000_000;

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const cut = text.length - 2 * half;
  return `${text.slice(0, half)}\n[... ${cut} characters cut ...]\n${text.slice(-half)}`;
}

function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`);
  return value;
}

function optStr(args: Args, key: string): string | undefined {
  return typeof args[key] === 'string' ? (args[key] as string) : undefined;
}

function optNum(args: Args, key: string, fallback: number): number {
  const value = Number(args[key]);
  return args[key] !== undefined && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => redactSecrets(String(item))) : [];
}

// Resolves a path inside the sandbox, following symlinks on the nearest existing ancestor.
export async function resolveInSandbox(dir: string, file = '.'): Promise<string> {
  const root = await realpath(dir);
  const target = path.resolve(dir, file);
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    const found = await lstat(existing).then(
      () => true,
      () => false,
    );
    if (found) break;
    if (path.dirname(existing) === existing) break;
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  // A dangling symlink makes realpath fail: treat it as outside rather than guessing where it points.
  const real = await realpath(existing).catch(() => undefined);
  const relative = real === undefined ? '..' : path.relative(root, path.join(real, ...rest));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('path is outside the sandbox');
  }
  return path.resolve(dir, relative);
}

function formatExec(result: ExecResult): string {
  return [
    `exit code: ${result.code}${result.timedOut ? ' (timed out)' : ''}`,
    `--- stdout ---\n${result.stdout}`,
    `--- stderr ---\n${result.stderr}`,
  ].join('\n');
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|pre|section|article|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function listTree(dir: string, depth: number, prefix: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= LIST_CAP) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const isDir = entry.isDirectory();
    out.push(
      `${prefix}${entry.name}${isDir ? '/' : entry.isSymbolicLink() ? ' -> (symlink)' : ''}`,
    );
    if (isDir && depth > 1)
      await listTree(path.join(dir, entry.name), depth - 1, `${prefix}  `, out);
  }
}

function matchesGlob(relative: string, glob: string): boolean {
  return path.matchesGlob(glob.includes('/') ? relative : path.basename(relative), glob);
}

// Single-quotes a value for sh.
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const RUNTIME_VERSION_COMMANDS: Record<string, string> = {
  node: 'node --version',
  python: 'python3 --version',
};
const RUNTIME_PROBE_TIMEOUT_MS = 5 * 60_000;

function probeResult(runtime: Runtime, result: ExecResult) {
  const out = `${result.stdout}\n${result.stderr}`.trim();
  const wanted = new RegExp(
    `(?:^v|Python )${runtime.version.replace(/\./g, '\\.')}(?:\\.|\\s|$)`,
    'm',
  );
  const ok = result.code === 0 && wanted.test(out);
  const shown = out.split('\n').slice(-3).join(' | ').slice(0, 300);
  return {
    ok,
    detail: ok
      ? `${runtime.name} ${runtime.version} available: ${shown}`
      : `${runtime.name} ${runtime.version} not available: ${shown || `exit ${result.code}`}`,
  };
}

// O3's runtime switch. Each runtime is its own official image and a command inside the run's container
// cannot change that container's image, so the checks run in a fresh container over a copy of the
// working copy, with a clean install on that runtime.
export const dockerRuntimes: RuntimeRunner = {
  async probe(_sandbox, runtime) {
    const parsed = parseRuntime(`${runtime.name} ${runtime.version}`);
    if (!parsed) return { ok: false, detail: `no official image for ${runtimeLabel(runtime)}` };
    const version = RUNTIME_VERSION_COMMANDS[parsed.name];
    const args = ['run', '--rm', runtimeImage(parsed), 'sh', '-c', version];
    return probeResult(
      parsed,
      await runHost('docker', args, { timeoutMs: RUNTIME_PROBE_TIMEOUT_MS }),
    );
  },
  async runChecks(sandbox, runtime, checks) {
    try {
      const parsed = parseRuntime(`${runtime.name} ${runtime.version}`);
      if (!parsed) throw new Error(`no official image for ${runtimeLabel(runtime)}`);
      return (await runChecksOnRuntime(sandbox.dir, parsed, { checks, mode: 'docker' })).runs;
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      return checks.map(({ name, command }) => ({
        name,
        command,
        ok: false,
        output: message,
        failures: [`could not run on ${runtimeLabel(runtime)}: ${message}`],
      }));
    }
  },
};

// Without Docker there are no images to switch to, so the switch happens inside the local sandbox.
// Node is the official nodejs.org build for that version, fetched once into /tmp; Python is a pythonX.Y
// binary the host already has. The probe reports honestly when the runtime is not there.
export function nodeRuntimeCommand(version: string, command: string): string {
  const v = version.replace(/^v/, '');
  if (!/^\d+(\.\d+){0,2}$/.test(v)) return command;
  const dist =
    v.includes('.') && v.split('.').length === 3 ? `v${v}` : `latest-v${v.split('.')[0]}.x`;
  const base = `https://nodejs.org/dist/${dist}`;
  const fetchNode = [
    'refit_os=$(uname -s | tr A-Z a-z)',
    "refit_arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')",
    `refit_file=$(curl -fsSL ${base}/SHASUMS256.txt | grep -o "node-v[0-9.]*-$refit_os-$refit_arch.tar.gz" | head -1)`,
    `mkdir -p "$refit_node" && curl -fsSL "${base}/$refit_file" | tar -xz -C "$refit_node" --strip-components=1`,
  ].join('; ');
  return `refit_node=/tmp/refit-node-${v}; if [ ! -x "$refit_node/bin/node" ]; then ${fetchNode}; fi; PATH="$refit_node/bin:$PATH" sh -c ${shellQuote(command)}`;
}

export function localRuntimeCommand(runtime: Runtime, command: string): string {
  if (runtime.name === 'node') return nodeRuntimeCommand(runtime.version, command);
  if (runtime.name === 'python') {
    const minor = runtime.version.split('.').slice(0, 2).join('.');
    return [
      `refit_py=$(command -v python${minor})`,
      'refit_bin=$(mktemp -d)',
      '[ -n "$refit_py" ] && ln -s "$refit_py" "$refit_bin/python3" && ln -s "$refit_py" "$refit_bin/python"',
      `PATH="$refit_bin:$PATH" sh -c ${shellQuote(command)}`,
    ].join('; ');
  }
  return command;
}

export const localRuntimes: RuntimeRunner = {
  async probe(sandbox, runtime) {
    const version = RUNTIME_VERSION_COMMANDS[runtime.name];
    if (!version)
      return { ok: false, detail: `no way to switch to ${runtime.name} in this sandbox` };
    return probeResult(
      runtime,
      await sandbox.exec(localRuntimeCommand(runtime, version), {
        timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
      }),
    );
  },
  runChecks: (sandbox, runtime, checks) =>
    runChecks(
      sandbox,
      checks.map(({ name, command }) => ({ name, command: localRuntimeCommand(runtime, command) })),
    ),
};

export const runtimesFor = (sandbox: Sandbox): RuntimeRunner =>
  sandbox.mode === 'docker' ? dockerRuntimes : localRuntimes;

export const runtimeLabel = (runtime: Runtime) => `${runtime.name} ${runtime.version}`;

// One place a dependency's version is set: the line and the version spec on it.
export type VersionPlace = {
  file: string;
  line: number;
  text: string;
  spec: string;
  note?: string;
};

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSION_TOKEN = /\d+(?:\.\d+)*/;

// Rewrites the version in a spec, keeping its operators and suffixes: "^18.2.0" + "22.11.0" →
// "^22.11.0", ">=18" + "22.11.0" → ">=22", "nodejs16.x" + "22" → "nodejs22.x", "v2" + "4" → "v4".
// Returns undefined when the spec has no single literal to move (a SHA, a list, a variable).
export function replaceVersion(spec: string, to: string): string | undefined {
  const target = VERSION_TOKEN.exec(to)?.[0];
  if (!target) return undefined;
  if (/^[0-9a-f]{40}$/i.test(spec) || /\$\{\{|\[/.test(spec) || spec.includes('||')) {
    return undefined;
  }
  const match = VERSION_TOKEN.exec(spec);
  if (!match) return undefined;
  const count = match[0].split('.').length;
  const parts = target.split('.');
  const next = (count < parts.length ? parts.slice(0, count) : parts).join('.');
  let out = spec.slice(0, match.index) + next + spec.slice(match.index + match[0].length);
  // An upper bound such as "<3" in ">=2,<3" moves to the next major past the target.
  out = out.replace(
    /(<=?\s*)(\d+(?:\.\d+)*)/g,
    (whole, op: string, bound: string, offset: number) => {
      if (offset <= match.index) return whole;
      const shape = bound.split('.').length;
      const major = Number(parts[0]) + 1;
      return op + [String(major), ...Array(shape - 1).fill('0')].join('.');
    },
  );
  return out;
}

type LineMatcher = { files: (file: string) => boolean; pattern: RegExp };

function versionMatchers(dependency: string): LineMatcher[] {
  const name = dependency.trim();
  const lower = name.toLowerCase();
  const image = lower.split(':')[0];
  const node = ['node', 'nodejs', 'node.js'].includes(image);
  const python = ['python', 'python3', 'cpython'].includes(image);
  const base = (file: string) => path.basename(file);
  const isYaml = (file: string) => /\.ya?ml$/i.test(file);
  const isWorkflow = (file: string) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(file);
  const any = escapeRegex(name);
  const matchers: LineMatcher[] = [
    {
      files: (f) => base(f) === 'package.json',
      pattern: new RegExp(`"${escapeRegex(node ? 'node' : name)}"\\s*:\\s*"([^"]*)"`),
    },
    {
      files: (f) => base(f) === '.tool-versions',
      pattern: new RegExp(`^(?:${node ? 'nodejs|node' : python ? 'python' : any})\\s+(\\S+)`, 'i'),
    },
    {
      files: (f) => /^dockerfile|\.dockerfile$|^containerfile/i.test(base(f)),
      pattern: new RegExp(
        `^\\s*FROM\\s+(?:--platform=\\S+\\s+)?(?:\\S+/)?${escapeRegex(image)}:(\\S+)`,
        'i',
      ),
    },
    {
      files: isYaml,
      pattern: new RegExp(
        `^\\s*-?\\s*image:\\s*["']?(?:\\S+/)?${escapeRegex(image)}:([^\\s"']+)`,
        'i',
      ),
    },
    { files: isWorkflow, pattern: new RegExp(`uses:\\s*["']?${any}@([^\\s"'#]+)`, 'i') },
    {
      files: (f) => /^(requirements|constraints)[\w.-]*\.(txt|in)$/i.test(base(f)),
      pattern: new RegExp(
        `^\\s*${any}(?:\\[[^\\]]*\\])?\\s*([<>=!~][^#;\\s]*(?:\\s*,\\s*[<>=!~][^#;\\s]*)*)`,
        'i',
      ),
    },
    {
      files: (f) => base(f) === 'pyproject.toml',
      pattern: new RegExp(`^\\s*"?${any}"?\\s*=\\s*"([^"]*)"`, 'i'),
    },
    {
      files: (f) => base(f) === 'pyproject.toml',
      pattern: new RegExp(`"${any}(?:\\[[^\\]]*\\])?\\s*([<>=!~^][^";]*)"`, 'i'),
    },
  ];
  if (node) {
    matchers.push(
      { files: (f) => ['.nvmrc', '.node-version'].includes(base(f)), pattern: /^\s*(\S+)\s*$/ },
      { files: isWorkflow, pattern: /node-version:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/ },
      { files: isYaml, pattern: /^\s*runtime:\s*(nodejs[\w.]+)/ },
    );
  }
  if (python) {
    matchers.push(
      { files: (f) => base(f) === '.python-version', pattern: /^\s*(\S+)\s*$/ },
      {
        files: (f) => base(f) === 'pyproject.toml',
        pattern: /^\s*(?:requires-python|python)\s*=\s*"([^"]*)"/,
      },
      {
        files: (f) => ['setup.py', 'setup.cfg'].includes(base(f)),
        pattern: /python_requires\s*=\s*['"]?([^'",\n]+)/,
      },
      { files: isWorkflow, pattern: /python-version:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/ },
      { files: isYaml, pattern: /^\s*runtime:\s*(python[\d.]+)/ },
    );
  }
  return matchers;
}

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'bun.lock',
  'Pipfile.lock',
]);

// Every place a dependency's version is set that these patterns know. A helper for the agent: it
// misses places it has no pattern for, so the agent searches too.
export async function findVersionPlaces(dir: string, dependency: string): Promise<VersionPlace[]> {
  const matchers = versionMatchers(dependency);
  const places: VersionPlace[] = [];
  for await (const full of walk(dir)) {
    const file = path.relative(dir, full);
    if (LOCKFILES.has(path.basename(file))) continue;
    const relevant = matchers.filter((matcher) => matcher.files(file));
    if (relevant.length === 0) continue;
    if ((await stat(full)).size > SEARCH_MAX_FILE_BYTES) continue;
    const lines = (await readFile(full, 'utf8').catch(() => '')).split('\n');
    lines.forEach((text, index) => {
      for (const matcher of relevant) {
        const spec = matcher.pattern.exec(text)?.[1];
        if (spec === undefined) continue;
        places.push({ file, line: index + 1, text: text.trim(), spec: spec.trim() });
        break;
      }
    });
  }
  return places;
}

// The command that changes one dependency with the repo's own package manager, install scripts off.
export function upgradeCommand(
  pm: PackageManager,
  version: string | undefined,
  pkg?: string,
  dev = false,
): string | undefined {
  const bin = packageManagerBinary(pm, version);
  const target = pkg ? shellQuote(pkg) : '';
  switch (pm) {
    case 'npm':
      return pkg
        ? `${bin} install ${target}${dev ? ' --save-dev' : ''} --ignore-scripts --no-audit --no-fund`
        : `${bin} install --ignore-scripts --no-audit --no-fund`;
    case 'pnpm':
      return pkg
        ? `${bin} add ${target}${dev ? ' --save-dev' : ''} --ignore-scripts`
        : `${bin} install --no-frozen-lockfile --ignore-scripts`;
    case 'yarn': {
      const classic = pkg
        ? `${bin} add ${target}${dev ? ' --dev' : ''} --ignore-scripts`
        : `${bin} install --ignore-scripts`;
      const berry = `YARN_ENABLE_SCRIPTS=false YARN_ENABLE_IMMUTABLE_INSTALLS=false ${bin} ${pkg ? `add ${target}${dev ? ' --dev' : ''}` : 'install'}`;
      if (version) return /^1(\.|$)/.test(version) ? classic : berry;
      return `if yarn --version | grep -q '^1\\.'; then ${classic}; else ${berry}; fi`;
    }
    case 'bun':
      return pkg
        ? `bun add ${target}${dev ? ' --dev' : ''} --ignore-scripts`
        : 'bun install --ignore-scripts';
    case 'pip':
      return pkg ? `python3 -m pip install --only-binary=:all: ${target}` : installCommand('pip');
    case 'poetry':
      return pkg
        ? `POETRY_INSTALLER_ONLY_BINARY=:all: PIP_ONLY_BINARY=:all: poetry add ${target}${dev ? ' --group dev' : ''}`
        : 'POETRY_INSTALLER_ONLY_BINARY=:all: PIP_ONLY_BINARY=:all: poetry lock && POETRY_INSTALLER_ONLY_BINARY=:all: PIP_ONLY_BINARY=:all: poetry install --no-root';
    case 'none':
      return undefined;
  }
}

export function buildTools(ctx: ToolContext): AgentTool[] {
  const { sandbox } = ctx;
  const inside = (file?: string) => resolveInSandbox(sandbox.dir, file);
  const display = (full: string) => path.relative(sandbox.dir, full) || '.';

  function tool(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    run: (args: Args) => Promise<string>,
  ): AgentTool {
    return {
      name,
      description,
      inputSchema: { type: 'object', properties, required },
      run: async (input) => {
        let out: string;
        try {
          const args = input && typeof input === 'object' ? (input as Args) : {};
          out = await run(args);
        } catch (error) {
          out = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        return truncate(redactSecrets(out));
      },
    };
  }

  const tools: AgentTool[] = [
    tool(
      'list_files',
      'List files and folders under a path in the repo (skips .git and node_modules).',
      {
        path: { type: 'string', description: 'Folder relative to the repo root. Default "."' },
        depth: { type: 'number', description: 'How many levels deep. Default 3' },
      },
      [],
      async (args) => {
        const root = await inside(optStr(args, 'path'));
        const out: string[] = [];
        await listTree(root, Math.max(1, optNum(args, 'depth', 3)), '', out);
        if (out.length >= LIST_CAP) out.push(`[stopped at ${LIST_CAP} entries; list a subfolder]`);
        return out.length ? out.join('\n') : `${display(root)} is empty`;
      },
    ),
    tool(
      'read_file',
      'Read a text file with line numbers. Use offset and limit for long files.',
      {
        path: { type: 'string' },
        offset: { type: 'number', description: 'First line to show, 1-based. Default 1' },
        limit: { type: 'number', description: 'Number of lines. Default 2000' },
      },
      ['path'],
      async (args) => {
        const file = await inside(str(args, 'path'));
        const text = await readFile(file, 'utf8');
        if (text.includes('\0')) return `${display(file)} looks like a binary file`;
        const lines = text.split('\n');
        const start = Math.max(1, optNum(args, 'offset', 1));
        const end = Math.min(lines.length, start - 1 + Math.max(1, optNum(args, 'limit', 2000)));
        const body = lines
          .slice(start - 1, end)
          .map((line, index) => `${start + index}\t${line}`)
          .join('\n');
        const more = end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}]` : '';
        return body + more;
      },
    ),
    tool(
      'write_file',
      'Create or overwrite a file with the given content. Creates parent folders.',
      { path: { type: 'string' }, content: { type: 'string' } },
      ['path', 'content'],
      async (args) => {
        const file = await inside(str(args, 'path'));
        const content = str(args, 'content');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
        return `wrote ${display(file)} (${Buffer.byteLength(content)} bytes)`;
      },
    ),
    tool(
      'edit_file',
      'Replace an exact string in a file. "old" must match exactly once unless replaceAll is true.',
      {
        path: { type: 'string' },
        old: { type: 'string', description: 'Exact text to replace, including whitespace' },
        new: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      ['path', 'old', 'new'],
      async (args) => {
        const file = await inside(str(args, 'path'));
        const [oldText, newText] = [str(args, 'old'), str(args, 'new')];
        if (oldText === '') return 'error: "old" is empty; use write_file to create a file';
        const text = await readFile(file, 'utf8');
        const count = text.split(oldText).length - 1;
        if (count === 0) {
          return `error: "old" was not found in ${display(file)}. Read the file again and copy the exact text, including indentation.`;
        }
        if (count > 1 && args.replaceAll !== true) {
          return `error: "old" appears ${count} times in ${display(file)}. Include more surrounding lines to make it unique, or set replaceAll.`;
        }
        const index = text.indexOf(oldText);
        const updated =
          count > 1
            ? text.split(oldText).join(newText)
            : text.slice(0, index) + newText + text.slice(index + oldText.length);
        await writeFile(file, updated);
        return `edited ${display(file)} (${count} replacement${count === 1 ? '' : 's'})`;
      },
    ),
    tool(
      'search',
      'Regex search over repo text files. Returns file:line: text. Optional glob like "**/*.ts".',
      {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'Folder or file to search. Default "."' },
        glob: { type: 'string', description: 'Only files matching this glob' },
      },
      ['pattern'],
      async (args) => {
        const regex = new RegExp(str(args, 'pattern'));
        const start = await inside(optStr(args, 'path'));
        const glob = optStr(args, 'glob');
        const files = (await stat(start)).isFile() ? [start] : walk(start);
        const hits: string[] = [];
        for await (const file of files) {
          const relative = display(file);
          if (glob && !matchesGlob(relative, glob)) continue;
          if ((await stat(file)).size > SEARCH_MAX_FILE_BYTES) continue;
          const text = await readFile(file, 'utf8').catch(() => '\0');
          if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < SEARCH_CAP; i++) {
            if (regex.test(lines[i])) hits.push(`${relative}:${i + 1}: ${lines[i].slice(0, 300)}`);
          }
          if (hits.length >= SEARCH_CAP) {
            hits.push(`[stopped at ${SEARCH_CAP} matches; narrow the pattern, path or glob]`);
            break;
          }
        }
        return hits.length ? hits.join('\n') : 'no matches';
      },
    ),
    tool(
      'shell',
      'Run a shell command in the repo working copy (inside the sandbox). Returns exit code, stdout and stderr.',
      {
        command: { type: 'string' },
        timeoutSec: { type: 'number', description: 'Default 300' },
      },
      ['command'],
      async (args) => {
        const timeoutMs = optNum(args, 'timeoutSec', 300) * 1000;
        return formatExec(await sandbox.exec(str(args, 'command'), { timeoutMs }));
      },
    ),
    tool(
      'install',
      "Install dependencies with the repo's own package manager and release, so the lockfile keeps its format (install scripts are off).",
      {},
      [],
      async () => {
        const pm = await detectPackageManager(sandbox.dir);
        if (pm === 'none') {
          return 'no lockfile or manifest found. Install what the repo needs with the shell tool.';
        }
        const command = installCommand(pm, await packageManagerVersion(sandbox.dir, pm));
        const result = await sandbox.exec(command, { timeoutMs: 15 * 60_000 });
        return `package manager: ${pm}\ncommand: ${command}\n${formatExec(result)}`;
      },
    ),
    tool(
      'run_checks',
      'Run the type check, build and tests. Shows failures for each. Use `add` to register checks the detection missed (e.g. `make test`): the harness runs them on the original code and after your edit, and they count toward proof like the detected ones.',
      {
        names: { type: 'array', items: { type: 'string' }, description: 'Only these checks' },
        add: {
          type: 'array',
          description: 'Extra checks to register, run and count toward proof',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, command: { type: 'string' } },
            required: ['name', 'command'],
          },
        },
        runtime: {
          type: 'object',
          description:
            'Run the checks on this runtime version instead of the sandbox default, e.g. {"name": "node", "version": "22"}. Use it after moving a runtime: passing on the old one proves nothing about the new one.',
          properties: { name: { type: 'string' }, version: { type: 'string' } },
          required: ['name', 'version'],
        },
      },
      [],
      async (args) => {
        const notes: string[] = [];
        const rawRuntime = (args.runtime ?? undefined) as Partial<Runtime> | undefined;
        const runtime =
          rawRuntime && typeof rawRuntime.name === 'string' && rawRuntime.version
            ? { name: rawRuntime.name.toLowerCase(), version: String(rawRuntime.version) }
            : undefined;
        for (const item of Array.isArray(args.add) ? args.add : []) {
          const { name, command } = (item ?? {}) as { name?: unknown; command?: unknown };
          if (typeof name !== 'string' || typeof command !== 'string' || !name || !command) {
            notes.push('skipped an added check without a name and command');
          } else if (ctx.checks.some((check) => check.name === name)) {
            notes.push(`a check named ${name} already exists; pick another name`);
          } else if (!ctx.addCheck) {
            notes.push(`${name} was not registered: this run cannot add checks`);
          } else {
            const baseline = await ctx.addCheck({ name, command });
            notes.push(
              `registered ${name}; on the original code it ${baseline.ok ? 'passes' : `fails (${baseline.failures.length})`}`,
            );
          }
        }
        if (ctx.checks.length === 0) {
          return [
            ...notes,
            'no checks were detected for this repo. Register its tests, build or type check with `add` so they count toward proof.',
          ].join('\n');
        }
        const names = Array.isArray(args.names) ? args.names.map(String) : [];
        const selected = names.length
          ? ctx.checks.filter((check) => names.includes(check.name))
          : ctx.checks;
        if (selected.length === 0) {
          return `no check matches ${names.join(', ')}. Available: ${ctx.checks.map((c) => c.name).join(', ')}`;
        }
        let runs;
        if (runtime) {
          const runtimes = ctx.runtimes ?? runtimesFor(sandbox);
          const probe = await runtimes.probe(sandbox, runtime);
          if (!probe.ok) {
            return [
              ...notes,
              `${probe.detail}. The checks did not run. Run them without \`runtime\` to see the sandbox default, and list the runtime as unproven if no way to provide it works.`,
            ].join('\n\n');
          }
          notes.push(`ran on ${probe.detail}`);
          ctx.onRuntime?.(runtime);
          runs = await runtimes.runChecks(sandbox, runtime, selected);
        } else {
          runs = await runChecks(sandbox, selected);
        }
        const report = runs
          .map((run) => {
            const head = `## ${run.name}: ${run.ok ? 'pass' : 'fail'}\ncommand: ${run.command}`;
            if (run.ok) return head;
            const failures = run.failures.slice(0, 30).map((failure) => `- ${failure}`);
            return `${head}\nfailures:\n${failures.join('\n')}\noutput (tail):\n${run.output.slice(-3000)}`;
          })
          .join('\n\n');
        return [...notes, report].join('\n\n');
      },
    ),
    tool(
      'diff',
      'Show your change as the PR will carry it: lines added and removed per file, or the full diff of one file. Use it to spot lockfile churn and stray edits before you finish.',
      {
        path: {
          type: 'string',
          description: 'One file to show in full. Default: every file, summarised',
        },
      },
      [],
      async (args) => {
        const sections = (await sandbox.diff()).split(/^(?=diff --git )/m).filter(Boolean);
        const file = optStr(args, 'path');
        if (file) {
          return (
            sections.find((section) => section.startsWith(`diff --git a/${file} `)) ??
            `no change to ${file}`
          );
        }
        if (sections.length === 0) return 'no changes yet';
        return sections
          .map((section) => {
            const name = /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1];
            const added = section.match(/^\+(?!\+\+ )/gm)?.length ?? 0;
            const removed = section.match(/^-(?!-- )/gm)?.length ?? 0;
            return `${name}: +${added} -${removed}`;
          })
          .join('\n');
      },
    ),
    tool(
      'fetch_url',
      'Fetch a web page or docs URL (http or https) and return it as plain text.',
      {
        url: { type: 'string' },
        maxChars: { type: 'number', description: 'Default 15000' },
      },
      ['url'],
      async (args) => {
        const url = new URL(str(args, 'url'));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return `error: only http and https URLs are supported, got ${url.protocol}`;
        }
        const response = await (ctx.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000) });
        const raw = await response.text();
        const html = /html/i.test(response.headers.get('content-type') ?? '') || /^\s*</.test(raw);
        const text = html ? htmlToText(raw) : raw;
        const max = optNum(args, 'maxChars', 15_000);
        const cut = text.length > max ? `\n[${text.length - max} characters cut]` : '';
        return `status ${response.status} ${url}\n\n${text.slice(0, max)}${cut}`;
      },
    ),
    tool(
      'retrieve_recipes',
      'Look up recipes from earlier verified migrations similar to this task.',
      {},
      [],
      async () => {
        const recipes = await ctx.retrieveRecipes(ctx.task);
        return recipes.length ? renderRecipes(recipes) : 'no recipes yet';
      },
    ),
  ];

  tools.push(
    tool(
      'bump_version',
      'Find every place a dependency version is set (package.json engines and dependencies, .nvmrc, .node-version, .python-version, .tool-versions, pyproject.toml, requirements*.txt, setup.py, Dockerfile FROM, compose and CI image lines, workflow `uses:` and `node-version`/`python-version`, serverless `runtime`). Without `apply` it only lists them; with `apply` it rewrites each listed literal to `to`, keeping operators and suffixes. It does not touch lockfiles: use `upgrade_package` after. It knows common patterns only, so search for anything else.',
      {
        dependency: {
          type: 'string',
          description: 'e.g. "node", "python", "next", "stripe", "actions/checkout"',
        },
        to: { type: 'string', description: 'Target version, e.g. "22", "3.12", "v4", "15.0.3"' },
        apply: { type: 'boolean', description: 'Rewrite the places. Default false: list only' },
        places: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these places, as "file:line" from an earlier listing',
        },
      },
      ['dependency'],
      async (args) => {
        const dependency = str(args, 'dependency');
        const to = optStr(args, 'to');
        const only = Array.isArray(args.places) ? args.places.map(String) : undefined;
        const found = (await findVersionPlaces(sandbox.dir, dependency)).filter(
          (place) => !only || only.includes(`${place.file}:${place.line}`),
        );
        if (found.length === 0) {
          return `no place setting ${dependency} matched the known patterns. Search the repo for it; it may be set somewhere these patterns do not know.`;
        }
        if (args.apply !== true || !to) {
          return [
            `${found.length} place${found.length === 1 ? '' : 's'} set ${dependency}:`,
            ...found.map((place) => {
              const next = to ? replaceVersion(place.spec, to) : undefined;
              return `- ${place.file}:${place.line}: \`${place.text}\` (version ${place.spec}${next ? ` → ${next}` : to ? ', no single literal to move; edit by hand' : ''})`;
            }),
            to ? 'Call again with apply: true to rewrite them.' : '',
          ]
            .filter(Boolean)
            .join('\n');
        }
        const out: string[] = [];
        const byFile = new Map<string, typeof found>();
        for (const place of found)
          byFile.set(place.file, [...(byFile.get(place.file) ?? []), place]);
        for (const [file, places] of byFile) {
          const full = await inside(file);
          const lines = (await readFile(full, 'utf8')).split('\n');
          for (const place of places) {
            const next = replaceVersion(place.spec, to);
            const line = lines[place.line - 1];
            if (!next || next === place.spec || !line.includes(place.spec)) {
              out.push(
                `- ${file}:${place.line}: left \`${place.text}\` (no single literal to move; edit by hand if it must change)`,
              );
              continue;
            }
            lines[place.line - 1] = line.replace(place.spec, next);
            out.push(`- ${file}:${place.line}: ${place.spec} → ${next}`);
          }
          await writeFile(full, lines.join('\n'));
        }
        out.push(
          'Lockfiles were not touched. Run `upgrade_package` (or `install`) so the package manager rewrites them, then check `diff`.',
        );
        return out.join('\n');
      },
    ),
    tool(
      'upgrade_package',
      "Change one dependency with the repo's own package manager and release, so it rewrites the lockfile (install scripts are off). With no package, re-resolves the whole lockfile after a manifest edit.",
      {
        package: {
          type: 'string',
          description:
            'With its version, as the package manager takes it: "next@15.0.3", "stripe==11.1.0"',
        },
        dev: { type: 'boolean', description: 'A dev dependency. Default false' },
      },
      [],
      async (args) => {
        const pm = await detectPackageManager(sandbox.dir);
        const command = upgradeCommand(
          pm,
          await packageManagerVersion(sandbox.dir, pm),
          optStr(args, 'package'),
          args.dev === true,
        );
        if (!command) {
          return 'no lockfile or manifest found. Change the dependency with the shell tool.';
        }
        const result = await sandbox.exec(command, { timeoutMs: 15 * 60_000 });
        const pipNote =
          pm === 'pip'
            ? '\npip installed it in the sandbox only; move the version in requirements files or pyproject.toml with `bump_version` or `edit_file`.'
            : '';
        return `package manager: ${pm}\ncommand: ${command}\n${formatExec(result)}${pipNote}`;
      },
    ),
  );

  // ToolPack and upgrade tools: every call is recorded, since a check or validate tool's result is proof.
  const recorded = (prefix: string, packTool: AgentTool, passed = runPassed): AgentTool => {
    const name = `${prefix}__${packTool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return {
      name,
      description: packTool.description,
      inputSchema: packTool.inputSchema,
      run: async (input) => {
        let out: string;
        try {
          out = String(await packTool.run(input, { repoDir: sandbox.dir }));
        } catch (error) {
          out = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        const output = truncate(redactSecrets(out));
        ctx.onToolPackCall?.({ tool: name, output, passed: passed(out) });
        return output;
      },
    };
  };
  for (const packTool of ctx.toolPack.tools) tools.push(recorded(ctx.toolPack.provider, packTool));
  const taken = new Set(tools.map((t) => t.name));
  for (const upgradeTool of ctx.upgradeTools ?? []) {
    const wrapped = recorded('upgrades', upgradeTool);
    if (taken.has(wrapped.name)) continue;
    taken.add(wrapped.name);
    tools.push(wrapped);
  }
  // "check" in the prefix makes failingCheckers count a failed or unknown proof even when the agent
  // leaves it out of finish, so it can't grade a run verified.
  for (const proofTool of ctx.proofTools ?? []) {
    tools.push(recorded('proof_check', proofTool, proofOutputPassed));
  }

  tools.push(
    tool(
      'finish',
      'Report the outcome when you are done. The harness then re-runs the checks against the baseline.',
      {
        verdict: { type: 'string', enum: ['migrated', 'not-affected'] },
        summary: { type: 'string', description: 'What changed' },
        why: { type: 'string', description: 'Why the external change forced it' },
        validators: {
          type: 'array',
          description:
            'Provider tools you called, by tool name. The harness grades them from its own record of those calls.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              passed: { type: 'boolean' },
              detail: { type: 'string' },
            },
            required: ['name', 'passed', 'detail'],
          },
        },
        unproven: { type: 'array', items: { type: 'string' } },
        behaviourChanges: { type: 'array', items: { type: 'string' } },
      },
      ['verdict', 'summary', 'why', 'validators', 'unproven', 'behaviourChanges'],
      async (args) => {
        const text = (value: unknown) => redactSecrets(value === undefined ? '' : String(value));
        const report: FinishReport = {
          verdict: args.verdict === 'not-affected' ? 'not-affected' : 'migrated',
          summary: text(args.summary),
          why: text(args.why),
          validators: (Array.isArray(args.validators) ? args.validators : []).map((item) => {
            const v = item && typeof item === 'object' ? (item as Args) : {};
            return { name: text(v.name), passed: v.passed === true, detail: text(v.detail) };
          }),
          unproven: strings(args.unproven),
          behaviourChanges: strings(args.behaviourChanges),
        };
        ctx.onFinish(report);
        return `Recorded the "${report.verdict}" report. The harness will now re-run the checks and compare them with the baseline.`;
      },
    ),
  );

  return tools;
}
