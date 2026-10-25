import ts from 'typescript-compiler';
import { componentReference, isObject } from './specifications.ts';
import { TEST_PATH } from './source-paths.ts';
import type { MappedSdkCall, ProviderOperationMapping } from './provider-operations.ts';
import type { Finding, Removal, Repository, SourceEdit } from './types.ts';

// Whether traced code reaches the part of the contract an oasdiff change touches:
// `reached` (a traced call sends it or traced code reads it), `unknown` (tracing cannot tell, so it
// still blocks), `unused` (no traced call sends it and no read of it was found, traced or not),
// `compatible` (a change no reader can observe as a break) or `handled` (a kept rule edit rewrites
// every traced use).
export type Reach = 'reached' | 'unknown' | 'unused' | 'compatible' | 'handled';
export const PASSING_REACH = new Set<unknown>(['unused', 'compatible', 'handled']);
export const RESPONSE_REMOVALS = new Set([
  'response-required-property-removed',
  'response-optional-property-removed',
]);
export interface ChangeReach {
  reach: Reach;
  reachReason: string;
}

const PATH_PARAMETER = /\{[^}]+\}/g;
const SUBSCHEMA = /^anyOf\[subschema #(\d+)(?:: [^\]]*)?\]$/;
// "the `currency` request property `format` changed …" names the property first, so that form is
// tried before "removed the request property `currency`".
const REQUEST_PROPERTY = [/the `([^`]+)` request property/, /request property `([^`]+)`/];
// https://docs.stripe.com/currencies: "use all lowercase letters when entering the three-letter ISO
// code in any payment request", which is what the new `currency` format describes.
const CURRENCY_FORMAT = /request property `format` changed from `none` to `currency`$/;
const STRIPE_CURRENCY = /^[a-z]{3}$/;
// A quoted three-letter code with no escapes, so lowercasing the source text lowercases the value.
const CURRENCY_LITERAL = /^(['"`])[A-Za-z]{3}\1$/;
export const CURRENCY_CODE_RULE = 'stripe-lowercase-currency-code';
export const CURRENCY_CODE_SOURCE = 'https://docs.stripe.com/currencies';
const REMOVED_ENUM_VALUE = /^removed the enum value `([^`]+)` of the request property `[^`]+`$/;
// Response property path and status in oasdiff 1.33 texts.
const RESPONSE_PROPERTY = [
  /^removed the (?:required|optional) property `([^`]+)` from the response with the `([^`]+)` status$/,
  /^added `[^`]+` to the `([^`]+)` response property `anyOf` list for the response status `([^`]+)`$/,
  /^the response property `([^`]+)` became (?:nullable|optional) for the status `([^`]+)`$/,
  /^the `([^`]+)` response property's maxLength was (?:unset|increased) from .* for the response status `([^`]+)`$/,
  /^the `([^`]+)` response's property `[^`]+` changed from `[^`]*` to `[^`]*` for status `([^`]+)`$/,
];
// A required request property is missing from every call that does not send it already.
const ALWAYS_REACHED = new Set([
  'new-required-request-property',
  'request-property-became-required',
]);
// A response string that may be longer is still a string: reading it cannot fail in JavaScript.
// Stored lengths are the application's own limit, which no contract states.
const COMPATIBLE: Record<string, string> = {
  'response-property-max-length-increased':
    'A response string may now be longer; reading it is unaffected.',
  'response-property-max-length-unset':
    'A response string may now be longer; reading it is unaffected.',
};

interface CallBody {
  file: string;
  // `unknown` when Refit cannot find the traced call again.
  body: ts.Expression | undefined | 'unknown';
}

// The initializer of a `const` the request names, when its declaration and this use are the only
// mentions of the name in the enclosing function or file, so nothing can change it in between.
function constantValue(identifier: ts.Identifier) {
  let scope: ts.Node = identifier;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let declaration: ts.VariableDeclaration | undefined;
  let mentions = 0;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === identifier.text) mentions += 1;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    )
      declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return mentions === 2 ? declaration?.initializer : undefined;
}

// Values a request sends at `path` (oasdiff's `a/items/b`), `unknown` when the body is not a
// literal Refit can read, or [] when it does not send it.
function sentValues(
  body: ts.Expression | undefined | 'unknown',
  path: string[],
): ts.Expression[] | 'unknown' {
  if (body === 'unknown') return 'unknown';
  if (!body) return [];
  let node = body;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  const [segment, ...rest] = path;
  if (!segment) return [node];
  if (ts.isIdentifier(node)) {
    const value = constantValue(node);
    return value ? sentValues(value, path) : 'unknown';
  }
  if (segment === 'items') {
    if (!ts.isArrayLiteralExpression(node)) return 'unknown';
    const values: ts.Expression[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) return 'unknown';
      const found = sentValues(element, rest);
      if (found === 'unknown') return 'unknown';
      values.push(...found);
    }
    return values;
  }
  if (!ts.isObjectLiteralExpression(node)) return 'unknown';
  let value: ts.Expression | undefined;
  for (const property of node.properties) {
    if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)))
      return 'unknown';
    const name =
      ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
        ? property.name.text
        : undefined;
    if (name === undefined) return 'unknown';
    if (name === segment)
      value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
  }
  return value ? sentValues(value, rest) : [];
}

function callBodies(repository: Repository, calls: MappedSdkCall[], argumentIndex: number) {
  const bodies: CallBody[] = [];
  const byFile = new Map<string, MappedSdkCall[]>();
  for (const call of calls) byFile.set(call.file, [...(byFile.get(call.file) ?? []), call]);
  for (const [path, located] of byFile) {
    const file = repository.files.find((entry) => entry.path === path);
    if (!file) {
      bodies.push({ file: path, body: 'unknown' });
      continue;
    }
    const source = ts.createSourceFile(path, file.content, ts.ScriptTarget.Latest, true);
    const wanted = new Set(located.map((call) => `${call.line}:${call.column}`));
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart());
        if (wanted.delete(`${position.line + 1}:${position.character + 1}`))
          bodies.push({ file: path, body: node.arguments[argumentIndex] });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    // A traced call Refit cannot find again sends an unknown body.
    for (const missing of wanted) bodies.push({ file: `${path}:${missing}`, body: 'unknown' });
  }
  return bodies;
}

// The component schema and property a response property path names, walking the operation's
// response in the before contract. Inline objects have no component to trace reads against.
export function responsePropertyOwner(
  change: Record<string, unknown>,
  before: Record<string, unknown>,
) {
  const match = RESPONSE_PROPERTY.map((pattern) => String(change.text).match(pattern)).find(
    Boolean,
  );
  if (!match || typeof change.path !== 'string' || typeof change.operation !== 'string')
    return undefined;
  const item = isObject(before.paths) ? before.paths[change.path] : undefined;
  const operation = isObject(item) ? item[change.operation.toLowerCase()] : undefined;
  const responses = isObject(operation) ? operation.responses : undefined;
  const response = isObject(responses) ? responses[match[2]] : undefined;
  const content = isObject(response) && isObject(response.content) ? response.content : {};
  const media = content['application/json'];
  const schemas =
    isObject(before.components) && isObject(before.components.schemas)
      ? before.components.schemas
      : {};
  let owner: string | undefined;
  const resolve = (value: unknown) => {
    const seen = new Set<string>();
    let current = value;
    owner = undefined;
    while (isObject(current) && typeof current.$ref === 'string') {
      const name = componentReference(current.$ref);
      if (!name || seen.has(name)) return undefined;
      seen.add(name);
      owner = name;
      current = schemas[name];
    }
    return isObject(current) ? current : undefined;
  };
  let node = resolve(isObject(media) ? media.schema : undefined);
  const segments = match[1].split('/');
  for (const [index, segment] of segments.entries()) {
    if (!node) return undefined;
    const subschema = segment.match(SUBSCHEMA);
    if (subschema) {
      const members = Array.isArray(node.anyOf) ? node.anyOf : [];
      node = resolve(members[Number(subschema[1]) - 1]);
      continue;
    }
    if (segment === 'items') {
      node = node.type === 'array' ? resolve(node.items) : undefined;
      continue;
    }
    // A nullable or expandable field (`anyOf: [string, $ref]`) whose path names no member reads
    // its only object member.
    if (!isObject(node.properties) && Array.isArray(node.anyOf)) {
      const objects = node.anyOf.filter((member) => isObject(member) && member.$ref);
      node = objects.length === 1 ? resolve(objects[0]) : undefined;
      if (!node) return undefined;
    }
    const properties = isObject(node.properties) ? node.properties : {};
    if (index === segments.length - 1)
      return owner && segment in properties ? { schema: owner, property: segment } : undefined;
    node = resolve(properties[segment]);
  }
  return undefined;
}

export interface ReachContext {
  repository: Repository;
  before: Record<string, unknown>;
  calls: MappedSdkCall[];
  mappings: ProviderOperationMapping[];
  // Likely SDK call sites the analyzer did not trace, as `resource.method` expressions.
  untracedCalls: () => string[];
  // Findings for removals of the given response properties, from the same analyzer that traces
  // removed-field reads: confirmed where traced code reads it, review where an untraced read of
  // the same name may.
  readFindings: (removals: Removal[]) => Finding[];
  // Removed fields Refit's own rules analyze: their findings decide whether the removal stops.
  removals: Removal[];
  // Whether a kept rule edit rewrites the source at this offset.
  edited: (file: string, offset: number) => boolean;
}

const requestProperty = (text: string) =>
  REQUEST_PROPERTY.map((pattern) => text.match(pattern)?.[1]).find(Boolean);

const changeMapping = (change: Record<string, unknown>, mappings: ProviderOperationMapping[]) =>
  mappings.find(
    (entry) =>
      entry.path === change.path && entry.httpMethod === String(change.operation).toUpperCase(),
  );

// https://docs.stripe.com/currencies: "Make sure to use all lowercase letters when entering the
// three-letter ISO code in any payment request." Where the target contract adds the `currency`
// format, an uppercase code written as a literal in a traced call's own request is lowercased.
// Constants (which may also be displayed), computed values and test files stay for review.
export function currencyCodeEdits(
  changes: Record<string, unknown>[],
  context: Pick<ReachContext, 'repository' | 'calls' | 'mappings'>,
) {
  const edits = new Map<string, SourceEdit>();
  for (const change of changes) {
    const text = String(change.text);
    const property = requestProperty(text);
    const mapping = changeMapping(change, context.mappings);
    if (!CURRENCY_FORMAT.test(text) || !property || !mapping) continue;
    const calls = context.calls.filter(
      (call) => call.operationId === mapping.operationId && !TEST_PATH.test(call.file),
    );
    const argumentIndex = String(change.path).match(PATH_PARAMETER)?.length ?? 0;
    for (const { file, body } of callBodies(context.repository, calls, argumentIndex)) {
      if (!body || body === 'unknown') continue;
      const values = sentValues(body, property.split('/'));
      if (values === 'unknown') continue;
      for (const value of values)
        // Only literals inside the call's own argument: sentValues also follows local constants.
        if (
          ts.isStringLiteralLike(value) &&
          value.getStart() >= body.getStart() &&
          value.end <= body.end &&
          CURRENCY_LITERAL.test(value.getText()) &&
          !STRIPE_CURRENCY.test(value.text)
        )
          edits.set(`${file}:${value.getStart()}`, {
            file,
            start: value.getStart(),
            end: value.end,
            replacement: value.getText().toLowerCase(),
            changeId: CURRENCY_CODE_RULE,
            rule: CURRENCY_CODE_RULE,
          });
    }
  }
  return [...edits.values()];
}

function requestReach(change: Record<string, unknown>, context: ReachContext): ChangeReach {
  const text = String(change.text);
  const property = requestProperty(text);
  if (!property)
    return {
      reach: 'unknown',
      reachReason: `Refit cannot read the request property in "${text}".`,
    };
  const mapping = changeMapping(change, context.mappings);
  const operation = mapping ? `${mapping.resource}.${mapping.method}` : String(change.path);
  // An untraced call may request the operation: one with its method name, or any at all when the
  // adapter does not map the operation to a method.
  const untraced = context
    .untracedCalls()
    .find(
      (expression) => !mapping || expression.endsWith(`.${mapping.resource}.${mapping.method}`),
    );
  if (untraced)
    return {
      reach: 'unknown',
      reachReason: `The untraced call \`${untraced}\` may request \`${operation}\` with \`${property}\`.`,
    };
  // Test files send no production request.
  const calls = mapping
    ? context.calls.filter(
        (call) => call.operationId === mapping.operationId && !TEST_PATH.test(call.file),
      )
    : [];
  if (!calls.length)
    return { reach: 'unused', reachReason: `No traced call requests \`${operation}\`.` };
  const removedValue = text.match(REMOVED_ENUM_VALUE)?.[1];
  const argumentIndex = String(change.path).match(PATH_PARAMETER)?.length ?? 0;
  // A newly required property matters to every call that sends its parent object, or every call
  // when it is top level.
  const required = ALWAYS_REACHED.has(String(change.id));
  const path = property.split('/');
  const currencyFormat = CURRENCY_FORMAT.test(text);
  let unknown: string | undefined;
  let handled: string | undefined;
  let compatible: string | undefined;
  for (const { file, body } of callBodies(context.repository, calls, argumentIndex)) {
    if (required) {
      const parents = path.length > 1 ? sentValues(body, path.slice(0, -1)) : [body];
      if (parents === 'unknown') unknown ??= file;
      else if (parents.length)
        return {
          reach: 'reached',
          reachReason: `The \`${operation}\` call in ${file} must now send \`${property}\`.`,
        };
      continue;
    }
    const values = sentValues(body, path);
    if (values === 'unknown') {
      unknown ??= file;
      continue;
    }
    for (const sent of values) {
      if (removedValue !== undefined) {
        const value = ts.isIdentifier(sent) ? constantValue(sent) : sent;
        if (!value || !ts.isStringLiteralLike(value)) {
          unknown ??= file;
          continue;
        }
        if (value.text !== removedValue) continue;
      }
      if (currencyFormat) {
        const value = ts.isIdentifier(sent) ? constantValue(sent) : sent;
        if (value && ts.isStringLiteralLike(value)) {
          if (STRIPE_CURRENCY.test(value.text)) {
            compatible ??= file;
            continue;
          }
          // The currency rule lowercases a literal written in the request (currencyCodeEdits).
          if (value === sent && context.edited(file, sent.getStart())) {
            handled ??= file;
            continue;
          }
          return {
            reach: 'reached',
            reachReason: `The \`${operation}\` call in ${file} sends \`${property}\` as \`${value.text}\`; the target contract gives it the \`currency\` format, a lowercase three-letter ISO code (https://docs.stripe.com/currencies).`,
          };
        }
      }
      // The card rule renames `payment_method_types` where it is written.
      if (ts.isPropertyAssignment(sent.parent) && context.edited(file, sent.parent.getStart())) {
        handled ??= file;
        continue;
      }
      return {
        reach: 'reached',
        reachReason: `The \`${operation}\` call in ${file} sends \`${property}\`.`,
      };
    }
  }
  return unknown
    ? {
        reach: 'unknown',
        reachReason: `The \`${operation}\` call in ${unknown} builds its request where Refit cannot read whether it sends \`${property}\`.`,
      }
    : handled
      ? {
          reach: 'handled',
          reachReason: `A kept rule edit rewrites \`${property}\` in every traced \`${operation}\` call that sends it, first in ${handled}.`,
        }
      : compatible
        ? {
            reach: 'compatible',
            reachReason: `Every traced \`${operation}\` call that sends \`${property}\` sends a lowercase three-letter ISO code, which the new \`currency\` format describes (https://docs.stripe.com/currencies), first in ${compatible}.`,
          }
        : {
            reach: 'unused',
            reachReason: `No traced \`${operation}\` call sends \`${property}\`${removedValue ? ` as \`${removedValue}\`` : ''}.`,
          };
}

// Annotates each oasdiff change with its reach. Response changes are traced like removed fields:
// the analyzer looks for reads of the changed property on the object schema that owns it.
export function annotateReach(changes: Record<string, unknown>[], context: ReachContext) {
  const owners = new Map<Record<string, unknown>, { schema: string; property: string }>();
  for (const change of changes) {
    if (change.reach || !String(change.id).startsWith('response-') || COMPATIBLE[String(change.id)])
      continue;
    if (change.usage) continue;
    const owner = responsePropertyOwner(change, context.before);
    if (owner) owners.set(change, owner);
  }
  const removals = new Map<string, Removal>();
  for (const { schema, property } of owners.values())
    removals.set(`reach:${schema}.${property}`, {
      id: `reach:${schema}.${property}`,
      schema,
      property,
      pointer: `/components/schemas/${schema}/properties/${property}`,
    });
  const findings = removals.size ? context.readFindings([...removals.values()]) : [];
  for (const change of changes) {
    if (change.reach) continue;
    let reach: ChangeReach;
    const id = String(change.id);
    if (change.usage)
      reach = {
        reach: 'reached',
        reachReason: 'The code switches over, exhaustively checks or compares this enum field.',
      };
    else if (COMPATIBLE[id]) reach = { reach: 'compatible', reachReason: COMPATIBLE[id] };
    else if (id.startsWith('request-') || ALWAYS_REACHED.has(id))
      reach = requestReach(change, context);
    else if (id.startsWith('response-')) {
      const owner = owners.get(change);
      const reads = owner
        ? findings.filter(
            (finding) =>
              finding.changeId === `reach:${owner.schema}.${owner.property}` &&
              !TEST_PATH.test(finding.file),
          )
        : [];
      const confirmed = reads.find((finding) => finding.confidence === 'confirmed');
      reach = !owner
        ? {
            reach: 'unknown',
            reachReason:
              'The changed response property is not a property of a named Stripe object.',
          }
        : RESPONSE_REMOVALS.has(id) &&
            context.removals.some(
              (removal) => removal.schema === owner.schema && removal.property === owner.property,
            )
          ? {
              reach: 'handled',
              reachReason: `Refit's removed-field analysis covers \`${owner.schema}.${owner.property}\`; its findings decide this removal.`,
            }
          : confirmed
            ? {
                reach: 'reached',
                reachReason: `${confirmed.file}:${confirmed.line} reads \`${owner.schema}.${owner.property}\`.`,
              }
            : reads.length
              ? {
                  reach: 'unknown',
                  reachReason: `${reads[0].file}:${reads[0].line} reads \`${owner.property}\` on an object Refit cannot trace.`,
                }
              : {
                  reach: 'unused',
                  reachReason: `No code reads \`${owner.schema}.${owner.property}\`.`,
                };
    } else
      reach = { reach: 'unknown', reachReason: `Refit has no reach rule for \`${id}\` changes.` };
    Object.assign(change, reach);
  }
}
