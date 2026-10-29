import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript-compiler';
import {
  AI_RULE_KINDS,
  type AiRuleKind,
  type AiRuleProvider,
  type AiRuleTable,
} from './ai-rules.ts';
import { readRepository } from './repository.ts';
import { TEST_PATH } from './source-paths.ts';

// API surface migrations (item 3), response-format changes (item 5) and beta features (item 6):
// where no provider page gives a one-to-one mapping, Refit finds the sites and explains what
// changes, and never edits them. Each finding names its rule, quote and page. Python and Gemini
// sites are report only (AGENTS.md).

// What a rule matches, from its `data.match`:
// - `calls`: SDK call paths, matched on the end of a call chain (`beta.threads.runs.create`), with a
//   trailing `*` for a whole namespace (`beta.assistants.*`), in files that import `packages`.
// - `strings`: exact string literal values (beta names, header values, model IDs).
// - `imports`: module specifiers imported or required.
// - `identifiers`: identifiers used in files that import `packages`.
// - `python`: regular expressions over Python source lines (report only).
export interface ReviewMatch {
  packages?: string[];
  calls?: string[];
  // Call paths that end like one of `calls` but are another API (`chat.completions.create`).
  notCalls?: string[];
  strings?: string[];
  imports?: string[];
  identifiers?: string[];
  python?: string[];
}

export interface ReviewFinding {
  provider: AiRuleProvider;
  kind: AiRuleKind;
  rule: string;
  status: 'review' | 'report';
  // The site fails today or after the change (an endpoint, model or beta that is gone); otherwise
  // it is a cleanup the provider allows.
  breaking: boolean;
  file: string;
  line: number;
  text: string;
  summary: string;
  source: { url: string; capturedAt: string; quote: string };
  // The same call matched rules of two providers: the file imports both SDKs and Refit could not
  // tell which client the call is on.
  ambiguous?: true;
  // A test, fixture or example path: listed, but a test asserting an old name is not a live call.
  test?: true;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const PYTHON = /\.py$/;
const MAX_TEXT = 160;

function scriptKind(path: string) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

const imports = (content: string, name: string) =>
  [`'${name}'`, `"${name}"`, `'${name}/`, `"${name}/`].some((needle) => content.includes(needle));

// `client.beta.threads.runs.create` matches `beta.threads.runs.create` and `beta.threads.*`.
export function callMatches(chain: string, pattern: string) {
  const parts = chain.split('.');
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2).split('.');
    for (let start = 0; start + prefix.length < parts.length; start++)
      if (prefix.every((part, index) => parts[start + index] === part)) return true;
    return false;
  }
  return chain === pattern || chain.endsWith(`.${pattern}`);
}

function chainText(expression: ts.Expression, source: ts.SourceFile) {
  return expression.getText(source).replace(/\s+/g, '').replace(/\?\./g, '.').replace(/!/g, '');
}

const short = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
};

export async function findReviewSites(
  directory: string,
  tables: AiRuleTable[],
  kinds: readonly AiRuleKind[] = AI_RULE_KINDS,
): Promise<ReviewFinding[]> {
  const rules = tables
    .filter((table) => kinds.includes(table.kind))
    .flatMap((table) =>
      table.rules
        .filter((rule) => rule.status !== 'auto' && rule.data.match)
        .map((rule) => ({ table, rule, match: rule.data.match as ReviewMatch })),
    );
  if (!rules.length) return [];
  const repository = await readRepository(directory, 'openai');
  const python = await pythonFiles(directory);
  const findings: ReviewFinding[] = [];
  const add = (
    entry: (typeof rules)[number],
    file: string,
    line: number,
    text: string,
    status: 'review' | 'report' = entry.rule.status === 'report' ? 'report' : 'review',
  ) => {
    const { table, rule } = entry;
    if (
      findings.some((item) => item.rule === rule.rule && item.file === file && item.line === line)
    )
      return;
    const page = table.pages[rule.page];
    findings.push({
      provider: table.provider,
      kind: table.kind,
      rule: rule.rule,
      status,
      breaking: rule.data.breaking !== false,
      file,
      line,
      text: short(text),
      summary: rule.summary,
      source: { url: page.url, capturedAt: page.capturedAt, quote: rule.quote },
      ...(TEST_PATH.test(file) ? { test: true as const } : {}),
    });
  };
  for (const file of repository.files) {
    if (!SOURCE.test(file.path) || DECLARATION.test(file.path)) continue;
    const relevant = rules.filter(
      ({ match }) =>
        (match.strings ?? []).some((value) => file.content.includes(value)) ||
        (match.imports ?? []).some((name) => imports(file.content, name)) ||
        ((match.calls?.length || match.identifiers?.length) &&
          (!match.packages || match.packages.some((name) => imports(file.content, name)))),
    );
    if (!relevant.length) continue;
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file.path),
    );
    const lineOf = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const visit = (node: ts.Node) => {
      for (const entry of relevant) {
        const { match } = entry;
        const packaged =
          !match.packages || match.packages.some((name) => imports(file.content, name));
        if (ts.isCallExpression(node) && match.calls && packaged) {
          const chain = chainText(node.expression, source);
          if (
            match.calls.some((pattern) => callMatches(chain, pattern)) &&
            !(match.notCalls ?? []).some((pattern) => callMatches(chain, pattern))
          )
            add(entry, file.path, lineOf(node), node.expression.getText(source));
        }
        if (ts.isStringLiteralLike(node) && match.strings?.includes(node.text))
          add(entry, file.path, lineOf(node), node.getText(source));
        if (
          ts.isStringLiteralLike(node) &&
          match.imports?.includes(node.text) &&
          (ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            (ts.isCallExpression(node.parent) && node.parent.arguments[0] === node))
        )
          add(entry, file.path, lineOf(node), node.parent.getText(source));
        if (ts.isIdentifier(node) && packaged && match.identifiers?.includes(node.text))
          add(entry, file.path, lineOf(node), node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [path, content] of python) {
    const lines = content.split('\n');
    for (const entry of rules) {
      const patterns = (entry.match.python ?? []).map((pattern) => new RegExp(pattern));
      // A beta name or header value is the same string in Python; Python sites are report only.
      const strings = (entry.match.strings ?? []).flatMap((value) => [
        `"${value}`,
        `'${value}`,
        `,${value}`,
        ` ${value}`,
      ]);
      if (!patterns.length && !strings.length) continue;
      lines.forEach((text, index) => {
        if (/^\s*#/.test(text)) return;
        if (
          patterns.some((pattern) => pattern.test(text)) ||
          (/["']/.test(text) && strings.some((value) => text.includes(value)))
        )
          add(entry, path, index + 1, text, 'report');
      });
    }
  }
  for (const item of findings)
    if (
      findings.some(
        (other) =>
          other !== item &&
          other.file === item.file &&
          other.line === item.line &&
          other.provider !== item.provider &&
          other.text === item.text,
      )
    )
      item.ambiguous = true;
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

// readRepository reads JavaScript and TypeScript only; Python files are walked here, skipping
// dependencies, build output and hidden directories, up to 2,000 files of at most 1 MiB.
async function pythonFiles(root: string) {
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.venv',
    'venv',
    '__pycache__',
    'site-packages',
  ]);
  const out: [string, string][] = [];
  const walk = async (relative: string) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name) && !entry.name.startsWith('.')) await walk(path);
      } else if (PYTHON.test(entry.name) && out.length < 2000) {
        const content = await readFile(join(root, path), 'utf8').catch(() => '');
        if (content.length <= 1024 * 1024) out.push([path, content]);
      }
    }
  };
  await walk('');
  return out;
}
