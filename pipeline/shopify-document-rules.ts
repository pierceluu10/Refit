import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  getNamedType,
  GraphQLError,
  NoUnusedFragmentsRule,
  parse,
  print,
  specifiedRules,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type ArgumentNode,
  type GraphQLSchema,
} from 'graphql';
import { isObject } from './specifications.ts';

// Shopify GraphQL migration rules (data/rules/shopify/<api>-<version>.json, written by the rules
// lane, pipeline/shopify-rules.ts) applied to one document. Only `auto` Admin rules of the
// `graphql-rename` and `graphql-argument-drop` families edit documents; every other entry is ignored
// here. Each edit sits where graphql-js proves the parent type on the before schema, and a
// rewritten document counts only when it validates on the after schema with no errors.

// One schema coordinate a table rule names, expanded into the edit it makes in a document. A
// `Type.member` coordinate becomes a field, input field and enum value rename at once: a type name
// is only one of those kinds, so only the matching visitor ever fires.
export interface ShopifyDocumentRule {
  rule: string;
  family:
    | 'graphql-field-rename'
    | 'graphql-argument-rename'
    | 'graphql-enum-value-rename'
    | 'graphql-input-field-rename'
    | 'graphql-argument-drop';
  // The output type (fields and arguments), enum or input object.
  type: string;
  // The field, input field or enum value.
  member: string;
  argument?: string;
  // graphql-argument-drop: the literal value (as GraphQL prints it) the dropped argument must have.
  value?: string;
  replacement: string;
  source: string;
}

const NAME = '[_A-Za-z][_0-9A-Za-z]*';
const COORDINATE = new RegExp(`^(${NAME})\\.(${NAME})(?:\\((${NAME}):\\))?$`);
const RULES = specifiedRules.filter((rule) => rule !== NoUnusedFragmentsRule);

// The rules a table entry makes, or none when it is not an `auto` rename or drop Refit can make in
// place. A replacement on another type (`Shop.draftOrders` to `QueryRoot.draftOrders`) moves the
// selection and is not made here.
function expand(entry: unknown): ShopifyDocumentRule[] {
  if (
    !isObject(entry) ||
    entry.status !== 'auto' ||
    typeof entry.rule !== 'string' ||
    typeof entry.source !== 'string' ||
    typeof entry.coordinate !== 'string'
  )
    return [];
  const [, type, member, argument] = COORDINATE.exec(entry.coordinate) ?? [];
  if (!type) return [];
  const base = { rule: entry.rule, source: entry.source, type, member };
  if (entry.family === 'graphql-argument-drop')
    return argument && typeof entry.value === 'string'
      ? [
          {
            ...base,
            family: 'graphql-argument-drop',
            argument,
            value: entry.value,
            replacement: '',
          },
        ]
      : [];
  if (entry.family !== 'graphql-rename' || typeof entry.replacement !== 'string') return [];
  const target = COORDINATE.exec(entry.replacement);
  const replacement = target
    ? target[1] === type && Boolean(target[3]) === Boolean(argument)
      ? (target[3] ?? target[2])
      : undefined
    : new RegExp(`^${NAME}$`).test(entry.replacement)
      ? entry.replacement
      : undefined;
  if (!replacement) return [];
  if (argument) return [{ ...base, family: 'graphql-argument-rename', argument, replacement }];
  return (
    ['graphql-field-rename', 'graphql-input-field-rename', 'graphql-enum-value-rename'] as const
  ).map((family) => ({ ...base, family, replacement }));
}

// Every rule of every Admin table whose version is at most the target version.
export function loadShopifyDocumentRules(
  target: string,
  directory = new URL('../data/rules/shopify/', import.meta.url),
): ShopifyDocumentRule[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const table: unknown = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
      if (
        !isObject(table) ||
        !Array.isArray(table.rules) ||
        (table.api !== undefined && table.api !== 'admin') ||
        String(table.version) > target
      )
        return [];
      return table.rules.flatMap(expand);
    });
}

export interface DocumentEdit {
  start: number;
  end: number;
  replacement: string;
  rule: ShopifyDocumentRule;
}

export type DocumentRewrite =
  { text: string; edits: DocumentEdit[] } | { refusal: string; edits: DocumentEdit[] };

function applyEdits(text: string, edits: DocumentEdit[]) {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.replacement + result.slice(edit.end),
      text,
    );
}

// The rules' edits to a document, and the rewritten text when it validates on the after schema.
// A renamed field is aliased to its old name, so the response keeps its keys and code reading the
// payload needs no change; a rename whose type differs between the two fields is refused.
export function rewriteDocument(
  text: string,
  before: GraphQLSchema,
  after: GraphQLSchema,
  rules: ShopifyDocumentRule[],
): DocumentRewrite | undefined {
  if (!rules.length) return undefined;
  const ast = parse(text);
  const info = new TypeInfo(before);
  const edits: DocumentEdit[] = [];
  const refusals: string[] = [];
  const rename = (
    node: { loc?: { start: number; end: number } },
    value: string,
    rule: ShopifyDocumentRule,
  ) => {
    if (node.loc)
      edits.push({ start: node.loc.start, end: node.loc.end, replacement: value, rule });
  };
  // Arguments dropped only when the document sends exactly the value the rule names; a field left
  // with no arguments loses its parentheses too.
  const dropped = new Map<ArgumentNode, ShopifyDocumentRule>();
  visit(
    ast,
    visitWithTypeInfo(info, {
      Field: {
        leave(node) {
          const gone = (node.arguments ?? []).filter((argument) => dropped.has(argument));
          if (!gone.length) return;
          const all = gone.length === node.arguments!.length;
          if (all && node.name.loc && gone.at(-1)!.loc) {
            const close = text.indexOf(')', gone.at(-1)!.loc!.end);
            edits.push({
              start: node.name.loc.end,
              end: close + 1,
              replacement: '',
              rule: dropped.get(gone[0])!,
            });
          } else for (const argument of gone) rename(argument, '', dropped.get(argument)!);
        },
        enter(node) {
          const parent = info.getParentType();
          for (const rule of rules) {
            if (
              rule.family !== 'graphql-field-rename' ||
              parent?.name !== rule.type ||
              node.name.value !== rule.member
            )
              continue;
            const was = info.getFieldDef()?.type;
            const target = after.getType(rule.type);
            const now =
              target && 'getFields' in target
                ? target.getFields()[rule.replacement]?.type
                : undefined;
            if (
              !was ||
              !now ||
              (String(was) !== String(now) && `${String(was)}!` !== String(now))
            ) {
              refusals.push(
                `${rule.rule}: ${rule.type}.${rule.member} is ${String(was)} but ${rule.type}.${rule.replacement} is ${String(now)} on the target, so the payload would change shape.`,
              );
              continue;
            }
            rename(
              node.name,
              node.alias ? rule.replacement : `${rule.member}: ${rule.replacement}`,
              rule,
            );
          }
        },
      },
      Argument(node) {
        const parent = info.getParentType();
        const field = info.getFieldDef();
        for (const rule of rules) {
          if (
            parent?.name !== rule.type ||
            field?.name !== rule.member ||
            node.name.value !== rule.argument
          )
            continue;
          if (rule.family === 'graphql-argument-rename') rename(node.name, rule.replacement, rule);
          if (rule.family === 'graphql-argument-drop' && print(node.value) === rule.value)
            dropped.set(node, rule);
        }
      },
      EnumValue(node) {
        const type = info.getInputType();
        const named = type ? getNamedType(type) : undefined;
        for (const rule of rules)
          if (
            rule.family === 'graphql-enum-value-rename' &&
            named?.name === rule.type &&
            node.value === rule.member
          )
            rename(node, rule.replacement, rule);
      },
      ObjectField(node) {
        const parent = info.getParentInputType();
        const named = parent ? getNamedType(parent) : undefined;
        for (const rule of rules)
          if (
            rule.family === 'graphql-input-field-rename' &&
            named?.name === rule.type &&
            node.name.value === rule.member
          )
            rename(node.name, rule.replacement, rule);
      },
    }),
  );
  if (!edits.length && !refusals.length) return undefined;
  if (refusals.length) return { refusal: refusals.join(' '), edits };
  const rewritten = applyEdits(text, edits);
  let errors: readonly GraphQLError[];
  try {
    errors = validate(after, parse(rewritten), RULES);
  } catch (error) {
    if (!(error instanceof GraphQLError)) throw error;
    errors = [error];
  }
  return errors.length
    ? {
        refusal: `After the rules' edits the document still fails on the target schema: ${errors[0].message}`,
        edits,
      }
    : { text: rewritten, edits };
}
