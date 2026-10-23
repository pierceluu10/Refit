import {
  ANTHROPIC_MODEL,
  GEMINI_MODEL,
  OPENAI_MODEL,
  type DeadlineUse,
} from '../deadline-exposure.ts';
import type { DeadlineEntry, DeadlineRegistry } from '../deadline-registry.ts';
import type { ModelReplacementStop, ModelReplacementUnresolved } from '../model-retirements.ts';
import type { ModelRules } from '../python/model-reports.ts';
import {
  GO_SDKS,
  GO_TEST_PATH,
  goSdkData,
  goString,
  imports,
  isGoTextCall,
  traceGoFiles,
} from './calls.ts';
import type { TracerStop } from '../tree-sitter.ts';
import { readGoFiles, withGoTrees, type GoFile, type Node } from './syntax.ts';

const PROVIDERS = new Set(['openai', 'anthropic']);
const CATALOG_SIZE = 3;
const CHECK_CALLS = new Set(['HasPrefix', 'HasSuffix', 'Contains', 'EqualFold', 'Index']);

export interface GoModelMatch {
  file: string;
  line: number;
  version: string;
  provider: string;
  use: DeadlineUse;
  text: string;
  where?: string;
}

const named = (node: Node | null | undefined) =>
  (node?.namedChildren ?? []).filter((child): child is Node => Boolean(child));
const isModel = (value: string) =>
  OPENAI_MODEL.test(value) || ANTHROPIC_MODEL.test(value) || GEMINI_MODEL.test(value);

// The value a model literal or SDK constant reference has, if either.
function modelValue(node: Node, constants: Map<string, string>) {
  const value = goString(node);
  if (value !== undefined) return value;
  if (node.type !== 'selector_expression') return undefined;
  const operand = node.childForFieldName('operand');
  return operand?.type === 'identifier'
    ? (constants.get(`openai:${node.childForFieldName('field')!.text}`) ??
        constants.get(`anthropic:${node.childForFieldName('field')!.text}`))
    : undefined;
}

// How a model literal is used, with the TypeScript matcher's classes: comparisons and prefix checks,
// map keys and lists of three or more models are not live; neither is test code.
function use(node: Node, file: string, constants: Map<string, string>): DeadlineUse {
  const parent = node.parent;
  if (parent?.type === 'binary_expression' && /^(?:==|!=)$/.test(parent.child(1)?.text ?? ''))
    return 'check';
  if (parent?.type === 'expression_list' && parent.parent?.type === 'expression_case')
    return 'check';
  if (parent?.type === 'argument_list') {
    const callee = parent.parent?.childForFieldName('function');
    if (
      callee?.type === 'selector_expression' &&
      CHECK_CALLS.has(callee.childForFieldName('field')!.text)
    )
      return 'check';
  }
  if (GO_TEST_PATH.test(file)) return 'test';
  // `map[string]int{"gpt-4": 8192}`: a key names a table entry.
  if (
    parent?.type === 'literal_element' &&
    parent.parent?.type === 'keyed_element' &&
    named(parent.parent)[0]?.id === parent.id
  )
    return 'catalog';
  for (let current: Node | null = parent; current; current = current.parent) {
    if (current.type === 'literal_value') {
      const values = new Set(
        current
          .descendantsOfType([
            'interpreted_string_literal',
            'raw_string_literal',
            'selector_expression',
          ])
          .map((item) => (item ? modelValue(item, constants) : undefined))
          .filter((item): item is string => item !== undefined && isModel(item)),
      );
      if (values.size >= CATALOG_SIZE) return 'catalog';
    }
    if (current.type === 'function_declaration' || current.type === 'method_declaration') break;
  }
  return 'live';
}

function where(node: Node) {
  const parent = node.parent;
  const holder =
    parent?.type === 'literal_element'
      ? parent.parent
      : parent?.type === 'expression_list'
        ? parent.parent
        : parent;
  if (holder?.type === 'keyed_element')
    return `it is the \`${named(holder)[0]?.text}\` value of a struct or map literal`;
  if (
    holder?.type === 'const_spec' ||
    holder?.type === 'var_spec' ||
    holder?.type === 'short_var_declaration' ||
    holder?.type === 'assignment_statement'
  )
    return `it is assigned to \`${(holder.childForFieldName('name') ?? named(holder.childForFieldName('left'))[0])?.text}\``;
  if (holder?.type === 'argument_list')
    return `it is passed to ${holder.parent?.childForFieldName('function')?.text.slice(0, 60)}()`;
  if (holder?.type === 'return_statement') return 'it is returned from a function';
  return 'it is not where a request reads its model';
}

// Registry models a Go file names, as string literals or as openai-go and anthropic-sdk-go model
// constants, each with how it is used.
export async function goModelMatches(
  files: GoFile[],
  models: Map<string, string>,
  stops?: TracerStop[],
): Promise<GoModelMatch[]> {
  const sdkData = await goSdkData();
  const constants = new Map<string, string>();
  for (const [provider, table] of [
    ['openai', sdkData.openai],
    ['anthropic', sdkData.anthropic],
  ] as const)
    for (const release of Object.values(table))
      for (const [name, value] of Object.entries(release.constants))
        if (models.has(value)) constants.set(`${provider}:${name}`, value);
  const candidates = files.filter(
    (file) =>
      [...models.keys()].some(
        (model) => file.content.includes(`"${model}"`) || file.content.includes(`\`${model}\``),
      ) || [...constants.keys()].some((key) => file.content.includes(`.${key.split(':')[1]}`)),
  );
  if (!candidates.length) return [];
  return withGoTrees(
    candidates,
    (tree) => {
      const matches: GoModelMatch[] = [];
      for (const file of candidates) {
        const root = tree(file.path)?.rootNode;
        if (!root) continue;
        const lines = file.content.split('\n');
        // Local names of the SDK packages the file imports, aliases and subpackages such as `shared`.
        const imported = imports(root);
        for (const node of root.descendantsOfType([
          'interpreted_string_literal',
          'raw_string_literal',
          'selector_expression',
          'comment',
        ])) {
          if (!node) continue;
          if (node.type === 'comment') {
            for (const match of node.text.matchAll(/["'`]([a-z0-9][a-z0-9.-]*)["'`]/g))
              if (models.has(match[1]))
                matches.push({
                  file: file.path,
                  line: node.startPosition.row + 1,
                  version: match[1],
                  provider: models.get(match[1])!,
                  use: 'comment',
                  text: lines[node.startPosition.row].trim(),
                });
            continue;
          }
          if (
            node.type === 'selector_expression' &&
            !imported.has(node.childForFieldName('operand')?.text ?? '')
          )
            continue;
          const value = modelValue(node, constants);
          if (value === undefined || !models.has(value)) continue;
          const how = use(node, file.path, constants);
          matches.push({
            file: file.path,
            line: node.startPosition.row + 1,
            version: value,
            provider: models.get(value)!,
            use: how,
            text: lines[node.startPosition.row].trim(),
            ...(how === 'live' ? { where: where(node) } : {}),
          });
        }
      }
      return matches;
    },
    stops,
  );
}

// Go requests that send a retiring model, as stops with the TypeScript rule's reasons, and every
// other live Go match with why no traced request sends it. Go is never edited.
export async function goModelReports(
  directory: string,
  registry: DeadlineRegistry,
  rules: ModelRules,
  tracerStops?: TracerStop[],
): Promise<{ stops: ModelReplacementStop[]; unresolved: ModelReplacementUnresolved[] }> {
  const byProvider = new Map<string, Map<string, DeadlineEntry>>();
  for (const entry of registry.deadlines)
    if (entry.kind === 'model' && PROVIDERS.has(entry.provider)) {
      const models = byProvider.get(entry.provider) ?? new Map<string, DeadlineEntry>();
      byProvider.set(entry.provider, models);
      for (const version of entry.versions) models.set(version, entry);
    }
  if (!byProvider.size) return { stops: [], unresolved: [] };
  const files = await readGoFiles(directory, tracerStops);
  const stops: ModelReplacementStop[] = [];
  const covered = new Set<string>();
  for (const call of await traceGoFiles(files, tracerStops)) {
    const models = byProvider.get(call.provider);
    const model = call.arguments.model;
    if (!models || !model || GO_TEST_PATH.test(call.file)) continue;
    for (const literal of model.literals) {
      const entry = models.get(literal.value);
      const key = `${literal.file}:${literal.line}`;
      if (!entry || GO_TEST_PATH.test(literal.file) || covered.has(key)) continue;
      covered.add(key);
      const to = rules.replacement(entry, models);
      const name = `${call.resource}.${call.method}`;
      // Go field names (`TopP`) as the API's parameter names (`top_p`).
      const sensitive = to
        ? call.options
            .map((option) =>
              option.replace(/[A-Z]/g, (letter, at) => `${at ? '_' : ''}${letter.toLowerCase()}`),
            )
            .filter((option) => rules.sensitive(call.provider, to).has(option))
        : [];
      const reason = !to
        ? 'The registry names no concrete replacement model ID.'
        : !isGoTextCall(call)
          ? `\`${name}\` is not a call Refit edits; ${to} may change formats or parameters; change it by hand to ${to}.`
          : model.stop
            ? `${model.stop} Change it by hand to ${to}.`
            : literal.via !== 'literal'
              ? `The model reaches this request through ${literal.via}, which Refit reports but does not edit yet; change it by hand to ${to}.`
              : call.spread
                ? 'The request spreads other options, which may set parameters the replacement rejects.'
                : sensitive.length
                  ? `The request sets ${sensitive.join(', ')}, which ${to} may reject or treat differently.`
                  : `Refit reports Go requests but does not edit Go code yet; change it by hand to ${to}.`;
      stops.push({
        deadline: entry.id,
        provider: entry.provider,
        file: call.file,
        line: call.line,
        call: name,
        at: { file: literal.file, line: literal.line },
        model: literal.value,
        reason,
      });
    }
  }
  const all = new Map(
    [...byProvider].flatMap(([provider, models]) =>
      [...models.keys()].map((model) => [model, provider] as const),
    ),
  );
  const check = 'Check where it is used and change it by hand if it reaches the API.';
  const unresolved: ModelReplacementUnresolved[] = [];
  for (const match of await goModelMatches(files, all, tracerStops)) {
    if (match.use !== 'live' || covered.has(`${match.file}:${match.line}`)) continue;
    covered.add(`${match.file}:${match.line}`);
    const models = byProvider.get(match.provider)!;
    const entry = models.get(match.version)!;
    const sdk = GO_SDKS.find((item) => item.provider === match.provider)!;
    unresolved.push({
      deadline: entry.id,
      provider: entry.provider,
      file: match.file,
      line: match.line,
      model: match.version,
      to: rules.replacement(entry, models),
      reason: files.some((file) => file.content.includes(sdk.module))
        ? `No traced request sends it as its model; ${match.where}. ${check}`
        : `No Go file imports \`${sdk.module}\`, so the model may reach the API through another library or a wrapper (${match.where}). ${check}`,
    });
  }
  return { stops, unresolved };
}
