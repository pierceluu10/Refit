// The agent's tool registry. Tools return information and never block the agent.
// The only refusal is a path outside the sandbox (hard limit 1); all output is redacted (hard limit 4).
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTool } from '../shared/types.ts';
import {
  detectPackageManager,
  installCommand,
  packageManagerVersion,
  runChecks,
} from './checks.ts';
import { renderRecipes } from './prompt.ts';
import { redactSecrets } from './secrets.ts';
import { runPassed } from './validators.ts';
import type { ExecResult, FinishReport, ToolContext } from './types.ts';

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
      },
      [],
      async (args) => {
        const notes: string[] = [];
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
        const runs = await runChecks(sandbox, selected);
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

  for (const packTool of ctx.toolPack.tools) {
    const name = `${ctx.toolPack.provider}__${packTool.name}`
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 64);
    tools.push({
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
        ctx.onToolPackCall?.({ tool: name, output, passed: runPassed(out) });
        return output;
      },
    });
  }

  tools.push(
    tool(
      'finish',
      'Report the outcome when you are done. The harness then re-runs the checks against the baseline.',
      {
        verdict: { type: 'string', enum: ['migrated', 'not-affected'] },
        summary: { type: 'string', description: 'What changed' },
        why: { type: 'string', description: 'Why the API change forced it' },
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
