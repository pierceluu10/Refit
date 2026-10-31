import { describe, expect, it } from 'vitest';
import ts from 'typescript-compiler';
import { loadAiRuleTables, rulesOf } from './ai-rules.ts';
import type { SdkRule } from './ai-sdk-majors.ts';
import {
  introducedTypeErrors,
  namedPathEdit,
  repairTypeErrors,
  typeRepairLoop,
  type TypeErrorAt,
} from './sdk-type-repair.ts';
import { typeErrors } from './type-errors.ts';

// The type checker below is TypeScript itself on an in-memory project, so every error the loop
// sees is one the compiler reports, printed as `tsc --pretty false` prints it. The SDKs are small
// stand-ins for the new majors' declarations (the shapes of openai 6 and @anthropic-ai/sdk 1 that
// the rules are about), not the packages.

const OPENAI_6: Record<string, string> = {
  'node_modules/openai/package.json': JSON.stringify({ name: 'openai', types: 'index.d.ts' }),
  'node_modules/openai/resources/files.d.ts': `export declare class Files {
  delete(fileID: string): Promise<{ id: string }>;
  list(): Promise<unknown>;
}`,
  'node_modules/openai/resources/vector-stores/files.d.ts': `export interface FileRetrieveParams { vector_store_id: string }
export interface FileUpdateParams { vector_store_id: string; attributes: Record<string, string> | null }
export declare class Files {
  retrieve(fileID: string, params: FileRetrieveParams): Promise<{ id: string }>;
  update(fileID: string, params: FileUpdateParams): Promise<{ id: string }>;
}`,
  'node_modules/openai/resources/chat/completions.d.ts': `export declare class Completions {
  create(body: { model: string }): Promise<unknown>;
  parse(body: { model: string }): Promise<unknown>;
}`,
  'node_modules/openai/core/error.d.ts':
    'export declare class APIError extends Error { status: number }',
  'node_modules/openai/index.d.ts': `import { Files } from './resources/files';
import { Files as VectorStoreFiles } from './resources/vector-stores/files';
import { Completions } from './resources/chat/completions';
declare class Chat { completions: Completions }
declare class Beta { assistants: unknown }
declare class VectorStores { files: VectorStoreFiles }
export default class OpenAI {
  constructor(options?: { apiKey?: string });
  files: Files;
  chat: Chat;
  beta: Beta;
  vectorStores: VectorStores;
}`,
};

const ANTHROPIC_1: Record<string, string> = {
  'node_modules/@anthropic-ai/sdk/package.json': JSON.stringify({
    name: '@anthropic-ai/sdk',
    types: 'index.d.ts',
  }),
  'node_modules/@anthropic-ai/sdk/index.d.ts': `export interface TextBlockParam { type: 'text'; text: string }
export interface ImageBlockParam { type: 'image'; source: string }
export type ContentBlockParam = TextBlockParam | ImageBlockParam;
export interface UserMessageParam { role: 'user'; content: string | ContentBlockParam[] }
export interface AssistantMessageParam { role: 'assistant'; content: string | ContentBlockParam[] }
export interface SystemMessageParam { role: 'system'; content: string | TextBlockParam[] }
export type MessageParam = UserMessageParam | AssistantMessageParam | SystemMessageParam;
declare namespace Anthropic { export { MessageParam, ContentBlockParam } }
export default Anthropic;`,
};

// `tsc --noEmit --pretty false` on the project: one line per error, its first message line.
function typecheck(files: Record<string, string>) {
  const root = '/repo/';
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const virtual = (name: string) =>
    name.startsWith(root) ? files[name.slice(root.length)] : undefined;
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => virtual(name) ?? (name.startsWith(root) ? undefined : readFile(name));
  host.fileExists = (name) =>
    virtual(name) !== undefined || (!name.startsWith(root) && fileExists(name));
  host.getSourceFile = (name, language) => {
    const content = virtual(name);
    return content !== undefined
      ? ts.createSourceFile(name, content, language, true)
      : getSourceFile(name, language);
  };
  host.getCurrentDirectory = () => root;
  host.directoryExists = (name) =>
    !name.startsWith(root) ||
    Object.keys(files).some((path) => `${root}${path}`.startsWith(`${name.replace(/\/$/, '')}/`));
  const program = ts.createProgram({
    rootNames: Object.keys(files)
      .filter((path) => !path.startsWith('node_modules/') && /\.tsx?$/.test(path))
      .map((path) => `${root}${path}`),
    options,
    host,
  });
  const stdout = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file && diagnostic.start !== undefined)
    .map((diagnostic) => {
      const { line, character } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!);
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').split('\n')[0];
      return `${diagnostic.file!.fileName.slice(root.length)}(${line + 1},${character + 1}): error TS${diagnostic.code}: ${message}`;
    })
    .join('\n');
  return { stdout, stderr: '' };
}

async function rules(provider: 'openai' | 'anthropic') {
  return rulesOf(await loadAiRuleTables(), provider, 'sdk-major') as SdkRule[];
}

// The loop on a project, as validation runs it: the original code's errors are the baseline, and
// each round type-checks the source with the rules' changes so far.
async function loop(
  sdk: Record<string, string>,
  source: Record<string, string>,
  table: SdkRule[],
  fromMajor: number,
  maxRounds?: number,
) {
  const baseline = { stdout: '', stderr: '' };
  const run = (changed: Map<string, string>) =>
    typecheck({ ...sdk, ...source, ...Object.fromEntries(changed) });
  return typeRepairLoop({
    errors: introducedTypeErrors(baseline, run(new Map())),
    read: async (path) => source[path],
    typecheck: async (changed) => introducedTypeErrors(baseline, run(changed)),
    rules: table,
    fromMajor,
    maxRounds,
  });
}

describe('type-error-driven SDK upgrade repairs', () => {
  it('resolves renamed methods, moved imports and named path parameters by rule (openai 4 → 6)', async () => {
    const source = {
      'src/files.ts': `import OpenAI from 'openai';
import { APIError } from 'openai/error';

export class Store {
  constructor(private readonly ai: OpenAI) {}
  // Not traced by the scan: the client is a constructor parameter.
  remove(id: string) {
    return this.ai.files.del(id);
  }
  parse() {
    return this.ai.beta.chat.completions.parse({ model: 'gpt-5.5' });
  }
  file(store: string, id: string) {
    return this.ai.vectorStores.files.retrieve(store, id);
  }
  label(store: string, id: string, attributes: Record<string, string>) {
    return this.ai.vectorStores.files.update(store, id, { attributes });
  }
  failed(error: unknown) {
    return error instanceof APIError ? error.status : 0;
  }
}
`,
    };
    const result = await loop(OPENAI_6, source, await rules('openai'), 4);
    expect(result.remaining).toEqual([]);
    expect(result.status).toBe('clean');
    expect(result.repairs.map((item) => item.rule).sort()).toEqual([
      'openai-node-v5-beta-chat-parse',
      'openai-node-v5-core-error',
      'openai-node-v5-files-del',
      'openai-node-v5-named-path-rewrite',
      'openai-node-v5-named-path-rewrite',
    ]);
    const after = result.files.get('src/files.ts')!;
    expect(after).toContain("from 'openai/core/error'");
    expect(after).toContain('this.ai.files.delete(id)');
    expect(after).toContain('this.ai.chat.completions.parse(');
    expect(after).toContain('files.retrieve(id, { vector_store_id: store })');
    expect(after).toContain('files.update(id, { vector_store_id: store, attributes })');
    expect(typecheck({ ...OPENAI_6, 'src/files.ts': after }).stdout).toBe('');
  });

  it('leaves what no rule maps open for the AI, with the rules that name it', async () => {
    const source = {
      'src/alias.ts': `import OpenAI from 'openai';
const client = new OpenAI();
const files = client.files;
export const removed = files.del('file-1');
export const listed = client.files.list({ limit: 1 });
`,
    };
    const result = await loop(OPENAI_6, source, await rules('openai'), 4);
    expect(result.status).toBe('open');
    expect(result.repairs).toEqual([]);
    const [alias, list] = result.remaining;
    // `files.del` on an alias: the old path is not on the chain, so no rule rewrites it.
    expect(alias).toMatchObject({ file: 'src/alias.ts', line: 4, code: 'TS2339' });
    expect(alias.text).toBe("export const removed = files.del('file-1');");
    expect(alias.rules.map((rule) => rule.rule)).toContain('openai-node-v5-files-del');
    expect(list).toMatchObject({ line: 5, code: 'TS2554' });
    expect(list.reason).toBe('No mapping in the SDK-major table matches this error.');
  });

  it('rewrites an interface over the new message union and guards a role-blind rebuild (@anthropic-ai/sdk 0 → 1)', async () => {
    const source = {
      'src/messages.ts': `import Anthropic from '@anthropic-ai/sdk';

export interface StoredMessage extends Anthropic.MessageParam {
  id: string;
}

export function redact(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const blocks: Anthropic.ContentBlockParam[] = message.content.map((block) =>
      block.type === 'image' ? { type: 'text', text: '[image]' } : block,
    );
    return { ...message, content: blocks };
  });
}
`,
    };
    const before = typeErrors(typecheck({ ...ANTHROPIC_1, ...source }));
    expect(before.map((error) => error.code)).toEqual(['TS2312', 'TS2322']);
    const result = await loop(ANTHROPIC_1, source, await rules('anthropic'), 0);
    expect(result.status).toBe('clean');
    expect(result.repairs.map((item) => item.rule)).toEqual([
      'anthropic-ts-message-param-interface-alias',
      'anthropic-ts-message-param-role-guard',
    ]);
    const after = result.files.get('src/messages.ts')!;
    expect(after).toContain(
      'export type StoredMessage = Anthropic.MessageParam & {\n  id: string;\n};',
    );
    expect(after).toContain(
      'return message.role === "system" ? message : { ...message, content: blocks };',
    );
  });

  it('stops at the round limit and reports what is still new', async () => {
    const table = await rules('openai');
    let rounds = 0;
    const error = (line: number): TypeErrorAt => ({
      file: 'src/a.ts',
      line,
      column: 31,
      code: 'TS2339',
      message: "Property 'del' does not exist on type 'Files'.",
      key: `src/a.ts TS2339 Property 'del' does not exist on type 'Files'.`,
    });
    const content = Array.from({ length: 5 }, () => 'export const x = client.files.del(id);').join(
      '\n',
    );
    const result = await typeRepairLoop({
      errors: [error(1)],
      read: async () => content,
      // A checker that reports one more renamed call each round, to reach the limit.
      typecheck: async () => [error(++rounds + 1)],
      rules: table,
      fromMajor: 4,
      maxRounds: 2,
    });
    expect(result.status).toBe('round-limit');
    expect(result.rounds.map((round) => round.repaired)).toEqual([1, 1, 0]);
    expect(rounds).toBe(2);
  });

  it('applies only auto rules for the installed major, one edit per site', async () => {
    const table = await rules('openai');
    const content =
      "import OpenAI from 'openai';\nexport const f = (c: OpenAI) => c.files.del('a');\n";
    const error: TypeErrorAt = {
      file: 'src/a.ts',
      line: 2,
      column: 41,
      code: 'TS2551',
      message: "Property 'del' does not exist on type 'Files'. Did you mean 'delete'?",
      key: 'k',
    };
    const files = new Map([['src/a.ts', content]]);
    // v5 already renamed `del`; a repository on v5 never gets the v4 rule.
    expect(repairTypeErrors([error], files, table, 5).edits).toEqual([]);
    const { edits } = repairTypeErrors([error, { ...error }], files, table, 4);
    expect(edits.map((item) => item.rule)).toEqual(['openai-node-v5-files-del']);
    const review = table.map((rule) =>
      rule.rule === 'openai-node-v5-files-del' ? { ...rule, status: 'review' as const } : rule,
    );
    expect(repairTypeErrors([error], files, review, 4).edits).toEqual([]);
  });
});

describe('namedPathEdit', () => {
  const call = (text: string) => {
    const source = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true);
    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node) => {
      if (!found && ts.isCallExpression(node)) found = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    return { source, node: found! };
  };
  const rewrite = (text: string, parents: string[]) => {
    const { source, node } = call(text);
    const edit = namedPathEdit(node, parents, source);
    return edit && text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  };

  it('moves the leading ids into the params object, keeping a body and request options', () => {
    expect(rewrite('c.runs.steps.retrieve(t, r, s)', ['thread_id', 'run_id'])).toBe(
      'c.runs.steps.retrieve(s, { thread_id: t, run_id: r })',
    );
    expect(rewrite('c.files.update(vector_store_id, f, body, opts)', ['vector_store_id'])).toBe(
      'c.files.update(f, { vector_store_id, ...body }, opts)',
    );
    expect(rewrite('c.files.retrieve(s, f, undefined, opts)', ['vector_store_id'])).toBe(
      'c.files.retrieve(f, { vector_store_id: s }, opts)',
    );
  });

  it('refuses a call that is not in the old positional form', () => {
    expect(
      rewrite('c.files.retrieve(f, { vector_store_id: s })', ['vector_store_id']),
    ).toBeUndefined();
    expect(rewrite('c.files.retrieve(...ids)', ['vector_store_id'])).toBeUndefined();
    expect(rewrite('c.files.retrieve(f)', ['vector_store_id'])).toBeUndefined();
  });
});
