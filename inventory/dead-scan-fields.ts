// A field matcher's hits: a property read off an "on" word, and whether the object is the provider's.
// shortcut: bindings are per file, not per scope, so two variables of one name count together.
// Fine for telling a provider's object from an app's own; upgrade if P5 finds a miss from it.
import { escapeRegex } from '../dead-apis/match.ts';
import type { DeadApiEntry, DeadApiMatcher } from '../shared/types.ts';
import { innerText, lineIndexAt, spanAt, type Source } from './dead-scan-lex.ts';
import { closeOf } from './dead-scan-place.ts';

export type FieldRead = {
  offset: number;
  chain: string; // event.data.object
  receiver: string; // object
  inlineType?: string; // Stripe.Invoice, from (x as Stripe.Invoice).field
  callArgument?: boolean; // a key inside client.messages.create({...})
  doubt?: string; // why the read can't be settled from the code, so it stays unclear
};

export type Binding = {
  from: 'typed' | 'call' | 'webhook' | 'other';
  shape?: string;
  note: string;
  aliasOf?: string; // `const s2 = subscription`: the name it copies
};

/** What a file binds, as far as a provider's objects go, and the names its client goes by. */
export type FileBindings = { names: Map<string, Binding[]>; clients: Set<string> };

type FieldMatcher = Extract<DeadApiMatcher, { kind: 'field' }>;

const CHAIN_CHARS = /[\w$.?!]/;
const LEADING_CHAIN = /^\s*(?:await\s+)?([\w$.?!]+)/;
const CAST_TYPE = /(?:\bas\s+|<)([A-Za-z_]\w*\.[A-Z][\w.]*)/;
const WEBHOOK_OBJECT = /\.data\.object$/;
const WEBHOOK_RAW =
  /\[\s*["']data["']\s*\]\s*\[\s*["']object["']\s*\]|\.get\(\s*["']data["'][^)]*\)\s*\.get\(\s*["']object["'][^)]*\)/;
const WEBHOOK_RAW_AHEAD = new RegExp(`(?:${WEBHOOK_RAW.source})\\s*(?:\\[\\s*|\\.get\\(\\s*)$`);
const WEBHOOK_LOOK_BACK_CHARS = 80;
// x: Stripe.Subscription, and the wrappers around one: x: Stripe.Response<Stripe.Subscription>.
const TYPED =
  /(?<![\w$])([A-Za-z_$][\w$]*)\??\s*:\s*(?:[A-Za-z_]\w*\.(?:Response|ApiList)<\s*)?([A-Za-z_]\w*\.[A-Z][\w.]*)/g;
const TYPE_ALIAS = /\btype\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*\.[A-Z][\w.]*)\s*[;\n]/g;
const ASSIGNMENT =
  /(?:\b(?:const|let|var)\s+|^[ \t]*)([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=(?![=>])\s*(?:await\s+)?([^;\n]+)/gm;
const MAX_DESTRUCTURE_CHARS = 400;
const DESTRUCTURED_BINDING = new RegExp(
  String.raw`\b(?:const|let|var)\s*\{([^{}]{0,${MAX_DESTRUCTURE_CHARS}})\}\s*(?::[^=\n]*)?=\s*(?:await\s+)?([^;\n]+)`,
  'g',
);
const DESTRUCTURED_KEY = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?::\s*\[?\s*([A-Za-z_$][\w$]*)\s*\]?)?/g;
const FOR_LOOP =
  /\bfor\s*(?:await\s*)?\(?\s*(?:const\s+|let\s+|var\s+)?([\w$]+)\s+(?:of|in)\s+(?:await\s+)?([\w$.()?!]+?)\.(\w+)\s*\(/g;
const FOR_OVER =
  /\bfor\s*(?:await\s*)?\(?\s*(?:const\s+|let\s+|var\s+)?([\w$]+)\s+(?:of|in)\s+(?:await\s+)?([\w$.?!]+)/g;
const CALLBACK =
  /([\w$.?!]+)\.(?:map|forEach|filter|find|flatMap|some|every)\(\s*(?:async\s+)?\(?\s*([\w$]+)[^)=\n]{0,80}\)?\s*=>/g;
const BARE_CHAIN = /^[\w$.?!]+(?:\[[^\]]*\])*(?:\.[\w$]+)*\s*$/;
const LIST_DATA = /\.data$/;
const LAST_SEGMENT = /\.\w+$/;
const CALL_CHAIN = /^([\w$.()?!]+?)\.(\w+)\s*\(/;
const CALL_RESULT = /^([\w$]+(?:\(\))?)\.(?:\w+\.)*?(\w+)\.(?:retrieve|create|update|get|fetch)$/;
const NOTE_CHARS = 48;
const CALL_WORD = /[./]/;
const MAX_CHAIN_WALK = 2_000;
const NESTED_WEBHOOK = /\bdata\s*:\s*\{\s*object\b/;
const GETATTR_AHEAD = /\bgetattr\(\s*([\w$.]+)\s*,\s*$/;
// A replacement written as a path into the object, and not a URL such as /v1/invoice_payments.
const REPLACEMENT_PATH = /^[A-Za-z_]\w*(?:\[[^\]]*\])?(?:\.[A-Za-z_]\w*(?:\[[^\]]*\])?)*$/;
// How near a read of the replacement must be for a dead read to be its fallback: a small helper at most.
const FALLBACK_LINES = 8;
const FUNCTION_START =
  /\bfunction\b|\bdef\s|=>\s*\{|^[ \t]*(?:(?:async|public|private|protected|static)\s+)*(?!(?:if|for|while|switch|catch)\b)[\w$]+\s*\([^)\n]*\)[^{;\n]*\{/m;
const INDEX_GAP = String.raw`(?:[?!\s]*(?:\??\.)?\[[^\]"']*\])*[?!\s]*`;
const HOLDER_NAME = '([A-Za-z_$][\\w$]*)';
// `const copy = sub as Stripe.Subscription;`, or with no cast.
const COPY_FROM = String.raw`\s*(?::[^=\n]*)?=\s*`;
const COPY_END = String.raw`\s*(?:\bas\b|[;\n])`;
// A plain assignment of the read and nothing else. It stops at the chain, since the read's offset is past it.
const HELD_BEFORE = /(?:^|[\s;{(])([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*[\w$.?\[\]]*$/;
const STATEMENT_END = /^\s*(?:;|$)/;

const normal = (word: string) => word.toLowerCase().replace(/[_$]/g, '').replace(/s$/, '');
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean);

const lastSegment = (chain: string) =>
  chain.replace(/[?!]/g, '').split('.').filter(Boolean).at(-1) ?? '';

const typeShape = (typeName: string) => typeName.split('.').at(-1) ?? '';
const typeNamespace = (typeName: string) => typeName.split('.')[0].toLowerCase();

// The expression a `.field` or `[...]` is read off, walking back from where it starts.
function chainBefore(code: string, end: number): Omit<FieldRead, 'offset'> | undefined {
  let at = end - 1;
  while (at >= 0 && /[\s!?]/.test(code[at])) at -= 1;
  while (code[at] === ']') {
    at = code.lastIndexOf('[', at) - 1;
    while (at >= 0 && /[\s!?]/.test(code[at])) at -= 1;
  }
  if (code[at] === ')') {
    let depth = 0;
    let open = at;
    const stop = Math.max(0, at - MAX_CHAIN_WALK);
    for (; open >= stop; open -= 1) {
      if (code[open] === ')') depth += 1;
      if (code[open] === '(' && --depth === 0) break;
    }
    if (open < stop) return undefined;
    const callee = /[\w$]/.test(code[open - 1] ?? '');
    if (!callee) {
      const inner = code.slice(open + 1, at);
      const chain = LEADING_CHAIN.exec(inner)?.[1];
      if (!chain) return undefined;
      return { chain, receiver: lastSegment(chain), inlineType: CAST_TYPE.exec(inner)?.[1] };
    }
    at = open - 1;
  }
  let start = at;
  while (start >= 0 && CHAIN_CHARS.test(code[start])) start -= 1;
  const chain = code.slice(start + 1, at + 1);
  return chain ? { chain, receiver: lastSegment(chain) } : undefined;
}

function dottedReads(source: Source, field: string): FieldRead[] {
  const reads: FieldRead[] = [];
  const pattern = new RegExp(`(?:\\?\\.|\\.|->)\\s*${escapeRegex(field)}(?![\\w$])`, 'g');
  for (const match of source.code.matchAll(pattern)) {
    const found = chainBefore(source.code, match.index);
    if (found) reads.push({ ...found, offset: match.index });
  }
  return reads;
}

// subscription['field'], subscription.get('field') and getattr(subscription, 'field').
function bracketReads(source: Source, field: string): FieldRead[] {
  const reads: FieldRead[] = [];
  for (const span of source.spans) {
    if (span.kind !== 'string' || innerText(source, span) !== field) continue;
    const from = Math.max(0, span.start - WEBHOOK_LOOK_BACK_CHARS);
    if (WEBHOOK_RAW_AHEAD.test(source.text.slice(from, span.start))) {
      reads.push({ offset: span.start, chain: 'event.data.object', receiver: 'object' });
      continue;
    }
    const ahead = source.code.slice(Math.max(0, span.start - MAX_CHAIN_WALK), span.start).trimEnd();
    const getattr = GETATTR_AHEAD.exec(ahead)?.[1];
    if (getattr) {
      reads.push({ offset: span.start, chain: getattr, receiver: lastSegment(getattr) });
      continue;
    }
    const end = ahead.endsWith('[')
      ? ahead.length - 1
      : ahead.endsWith('.get(')
        ? ahead.length - '.get('.length
        : undefined;
    if (end === undefined) continue;
    const found = chainBefore(ahead, end);
    if (found) reads.push({ ...found, offset: span.start });
  }
  return reads;
}

// const { field } = x, however deep, and f({ field }: Stripe.Subscription).
function destructuredReads(source: Source, field: string): FieldRead[] {
  const body = `\\{[^=;()]{0,${MAX_DESTRUCTURE_CHARS}}(?<![\\w$])${escapeRegex(field)}(?![\\w$])[^=;()]{0,${MAX_DESTRUCTURE_CHARS}}\\}`;
  const assigned = new RegExp(`${body}\\s*=\\s*(?:await\\s+)?([\\w$.?!]+)`, 'g');
  const typed = new RegExp(`${body}\\s*:\\s*([A-Za-z_]\\w*\\.[A-Z][\\w.]*)`, 'g');
  const offsetOf = (match: RegExpMatchArray) =>
    (match.index ?? 0) + match[0].search(new RegExp(`(?<![\\w$])${escapeRegex(field)}(?![\\w$])`));
  return [
    ...[...source.code.matchAll(assigned)].map((match) => {
      const chain = NESTED_WEBHOOK.test(match[0]) ? `${match[1]}.data.object` : match[1];
      return { offset: offsetOf(match), chain, receiver: lastSegment(chain) };
    }),
    ...[...source.code.matchAll(typed)].map((match) => ({
      offset: offsetOf(match),
      chain: match[1],
      receiver: typeShape(match[1]),
      inlineType: match[1],
    })),
  ];
}

function argumentRange(source: Source, word: string): [number, number][] {
  if (word.includes('/')) {
    return source.spans.flatMap((span) => {
      if (span.kind !== 'string' || !innerText(source, span).includes(word)) return [];
      const open = source.code.lastIndexOf('(', span.start);
      return open === -1 ? [] : [[open, closeOf(source.code, open)] as [number, number]];
    });
  }
  const pattern = new RegExp(`(?<![\\w$])${escapeRegex(word)}\\s*\\(`, 'g');
  return [...source.code.matchAll(pattern)].map((match) => {
    const open = match.index + match[0].length - 1;
    return [open, closeOf(source.code, open)];
  });
}

// { temperature: 0.2 } or temperature=0.2 inside a call the matcher names, as in messages.create.
function argumentReads(source: Source, matcher: FieldMatcher): FieldRead[] {
  const key = new RegExp(
    `(?<![\\w$.-])["']?${escapeRegex(matcher.value)}["']?\\s*(?::|=(?!=)|,|\\})`,
  );
  return (matcher.on ?? [])
    .filter((word) => CALL_WORD.test(word))
    .flatMap((word) =>
      argumentRange(source, word).flatMap(([open, close]) => {
        const match = key.exec(source.text.slice(open, close));
        return match
          ? [{ offset: open + match.index, chain: word, receiver: word, callArgument: true }]
          : [];
      }),
    );
}

// A read written out in a comment or prose, so it can be reported as a comment.
function commentReads(source: Source, matcher: FieldMatcher): FieldRead[] {
  const words = (matcher.on ?? []).filter((word) => !CALL_WORD.test(word)).map(escapeRegex);
  if (words.length === 0) return [];
  const pattern = new RegExp(
    `(?<![\\w$])(${words.join('|')})\\??\\.${escapeRegex(matcher.value)}(?![\\w$])`,
    'g',
  );
  const reads: FieldRead[] = [];
  for (const span of source.spans) {
    if (span.kind !== 'comment') continue;
    for (const match of source.text.slice(span.start, span.end).matchAll(pattern)) {
      reads.push({ offset: span.start + match.index, chain: match[1], receiver: match[1] });
    }
  }
  return reads;
}

function push(bindings: Map<string, Binding[]>, name: string, binding: Binding) {
  bindings.set(name, [...(bindings.get(name) ?? []), binding]);
}

// subs.data[0] and subs.data read the same objects as subs.
const baseOf = (chain: string) =>
  chain
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[?!]/g, '')
    .replace(LIST_DATA, '');

// A client reached through something, as in this.stripe.subscriptions or client.subscriptions, and not
// a table named for the provider, as in db.stripeSubscription.
function fromProvider(chain: string, provider: string, clients: Set<string>): boolean {
  const segments = chain.toLowerCase().replace(/[?!]/g, '').split('.');
  const owners = segments.length > 1 ? segments.slice(0, -1) : segments;
  return owners.some((one) => one.includes(provider) || clients.has(one));
}

function clientsOf(code: string, provider: string): Set<string> {
  const name = escapeRegex(provider);
  const assigned = new RegExp(
    `([\\w$.]+)\\s*(?::[^=\\n]*)?=\\s*(?:await\\s+)?(?:new\\s+)?[\\w$.]*${name}[\\w$]*\\s*\\(`,
    'gi',
  );
  const typed = new RegExp(`(?<![\\w$])([\\w$]+)\\??\\s*:\\s*${name}\\b(?!\\.)`, 'gi');
  return new Set(
    [...code.matchAll(assigned), ...code.matchAll(typed)].map((match) =>
      lastSegment(match[1]).toLowerCase(),
    ),
  );
}

/** What the file binds each variable to, as far as a provider's objects go. */
export function bindingsOf(source: Source, provider: string): FileBindings {
  const names = new Map<string, Binding[]>();
  const { code, text } = source;
  const clients = clientsOf(code, provider);
  const fromChain = (chain: string) => fromProvider(chain, provider, clients);
  const provided = (chain: string) =>
    names.get(baseOf(chain))?.filter((one) => one.from !== 'other') ?? [];

  const aliases = new Map(
    [...code.matchAll(TYPE_ALIAS)]
      .filter((match) => typeNamespace(match[2]) === provider)
      .map((match) => [match[1], match[2]]),
  );
  const pushTyped = (name: string, typeName: string, note: string) =>
    push(names, name, { from: 'typed', shape: typeShape(typeName), note });
  for (const match of code.matchAll(TYPED)) {
    if (typeNamespace(match[2]) === provider) pushTyped(match[1], match[2], `typed ${match[2]}`);
  }
  if (aliases.size > 0) {
    const pattern = new RegExp(
      `(?<![\\w$])([A-Za-z_$][\\w$]*)\\??\\s*:\\s*(${[...aliases.keys()].join('|')})\\b(?!\\.)`,
      'g',
    );
    for (const match of code.matchAll(pattern)) {
      pushTyped(match[1], aliases.get(match[2]) as string, `typed ${aliases.get(match[2])}`);
    }
  }

  const bind = (name: string, rhs: string, rawRhs: string) => {
    const cast = CAST_TYPE.exec(rhs)?.[1];
    if (cast && typeNamespace(cast) === provider) {
      pushTyped(name, cast, `cast to ${cast}`);
      return;
    }
    if (/\.data\.object\b/.test(rhs) || WEBHOOK_RAW.test(rawRhs)) {
      push(names, name, { from: 'webhook', note: 'event.data.object' });
      return;
    }
    const call = CALL_CHAIN.exec(rhs);
    if (call && fromChain(call[1])) {
      const note = `${call[1]}.${call[2]}()`;
      push(names, name, { from: 'call', shape: lastSegment(call[1]), note });
      return;
    }
    const bare = BARE_CHAIN.test(rhs);
    const copied = bare ? provided(rhs) : [];
    if (copied.length > 0) {
      for (const one of copied) push(names, name, one);
      return;
    }
    const note = rhs.trim().slice(0, NOTE_CHARS);
    push(names, name, {
      from: 'other',
      note,
      ...(bare ? { aliasOf: lastSegment(baseOf(rhs)) } : {}),
    });
  };

  for (const match of code.matchAll(ASSIGNMENT)) {
    const [, name, rhs] = match;
    const rawRhs = text.slice(
      match.index + match[0].indexOf(rhs, name.length),
      match.index + match[0].length,
    );
    bind(name, rhs, rawRhs);
  }
  for (const match of code.matchAll(DESTRUCTURED_BINDING)) {
    for (const key of match[1].matchAll(DESTRUCTURED_KEY)) {
      // const { object: s } = event.data reads event.data.object, and data is a provider list's own key.
      const rhs = key[1] === 'object' ? `${match[2].trim()}.object` : match[2];
      bind(key[2] ?? key[1], rhs, rhs);
    }
  }
  for (const match of code.matchAll(FOR_LOOP)) {
    if (fromChain(match[2])) {
      const note = `${match[2]}.${match[3]}()`;
      push(names, match[1], { from: 'call', shape: lastSegment(match[2]), note });
    }
  }
  for (const match of code.matchAll(FOR_OVER)) {
    for (const one of provided(match[2])) push(names, match[1], one);
  }
  for (const match of code.matchAll(CALLBACK)) {
    for (const one of provided(match[1])) push(names, match[2], one);
  }
  return { names, clients };
}

export type ReadEvidence = { strong: boolean; why: string };

const keyRead = (word: string) => {
  const key = escapeRegex(word);
  return String.raw`(?:(?:\??\.|->)\s*${key}(?![\w$])|\[\s*["']${key}["']\s*\]|\.get\(\s*["']${key}["'][^()]*(?:\([^()]*\)[^()]*)*\))`;
};
const keysRead = (words: string[]) => words.map(keyRead).join(INDEX_GAP);
const pathRead = ([first, ...rest]: string[]) => {
  const root = String.raw`(?:(?<![\w$])${escapeRegex(first)}(?![\w$])|${keyRead(first)})`;
  return rest.length > 0 ? `${root}${INDEX_GAP}${keysRead(rest)}` : root;
};

// The replacement's paths, without an "on" word, which the read's own receiver stands for. The holder
// of the new field says the same, unless it's a list, which the old shape had too.
function replacementPaths(entry: DeadApiEntry, matcher: FieldMatcher): string[][] {
  const on = (matcher.on ?? []).map(normal);
  return (entry.replacementIds ?? [])
    .filter((id) => REPLACEMENT_PATH.test(id))
    .flatMap((id) => {
      const parts = id.split('.');
      const words = parts.map((part) => part.replace(/\[.*$/, ''));
      const kept = on.includes(normal(words[0])) ? 1 : 0;
      const path = words.slice(kept);
      if (path.length < 3 || parts.at(-2)?.includes('[')) return path.length > 0 ? [path] : [];
      return [path, path.slice(0, -1)];
    });
}

// What binds a name to a holder of the path, each with what's left to read off that name.
function holderBindings(path: string[]): { binder: RegExp; rest: string }[] {
  return path.slice(1).flatMap((_, index) => {
    const holder = pathRead(path.slice(0, index + 1));
    const rest = keysRead(path.slice(index + 1));
    return [
      String.raw`(?<![\w$.])\[?\s*${HOLDER_NAME}\s*\]?\s*(?::[^=\n]*)?=\s*[^;\n]*?${holder}`,
      String.raw`\bfor\s*\(?\s*(?:const\s+|let\s+|var\s+)?${HOLDER_NAME}\s+(?:of|in)\s+[^\n]*?${holder}`,
      String.raw`${holder}${INDEX_GAP}\.(?:map|forEach|filter|find|flatMap|some|every|reduce)\(\s*(?:async\s+)?\(?\s*${HOLDER_NAME}`,
    ].map((binder) => ({ binder: new RegExp(binder, 'g'), rest }));
  });
}

// The read's own object, under the name it's read by or one it's plainly copied to or from.
function sameObject(source: Source, chain: string): string {
  const name = escapeRegex(chain);
  const copies = [
    ...source.code.matchAll(
      new RegExp(`(?<![\\w$.])${name}${COPY_FROM}([\\w$.]+)${COPY_END}`, 'g'),
    ),
    ...source.code.matchAll(new RegExp(`(?<![\\w$.])([\\w$]+)${COPY_FROM}${name}${COPY_END}`, 'g')),
  ].map((match) => escapeRegex(match[1]));
  return String.raw`(?<![\w$.])(?:${[name, ...copies].join('|')})(?![\w$])`;
}

// Where the code reads the replacement off the same object. Strings and comments only talk about it.
function replacementReads(source: Source, read: FieldRead, path: string[]): number[] {
  if (path.some((word) => !source.text.includes(word))) return [];
  const offsets = (pattern: string) =>
    [...source.text.matchAll(new RegExp(pattern, 'g'))].map((match) => match.index);
  const receiver = sameObject(source, read.chain);
  const direct = `${receiver}${INDEX_GAP}${keysRead(path)}`;
  // The holder has to come off the same object too, unless this read is itself off the holder.
  const offObject = new RegExp(receiver);
  const viaHolder = holderBindings(path).flatMap(({ binder, rest }) =>
    [...source.text.matchAll(binder)]
      .filter(
        (bound) =>
          bound[1] === read.chain ||
          offObject.test(
            source.text.slice(
              source.lineStarts[lineIndexAt(source, bound.index)],
              bound.index + bound[0].length,
            ),
          ),
      )
      .flatMap((bound) => offsets(`(?<![\\w$.])${escapeRegex(bound[1])}${INDEX_GAP}${rest}`)),
  );
  return [...offsets(direct), ...viaHolder].filter(
    (offset) => spanAt(source.spans, offset) === undefined,
  );
}

// `const end = sub.field;`, with the new shape read beside it and nothing ever falling back to `end`.
function keptAlone(source: Source, read: FieldRead, end: number): boolean {
  const line = source.lines[lineIndexAt(source, read.offset)];
  const lineStart = source.lineStarts[lineIndexAt(source, read.offset)];
  const holder = HELD_BEFORE.exec(source.code.slice(lineStart, read.offset))?.[1];
  if (!holder || !STATEMENT_END.test(source.code.slice(end, lineStart + line.length))) return false;
  const name = escapeRegex(holder);
  return !new RegExp(
    `(?<![\\w$.])${name}\\s*(?:\\?\\?|\\|\\||\\bor\\b)|(?:\\?\\?|\\|\\||\\bor\\b|\\bif\\b\\s*\\(?\\s*!?)\\s*${name}(?![\\w$])`,
  ).test(source.code);
}

/**
 * Whether a read of a dead field sits beside a read of what replaced it, in one expression or a small
 * helper, so it's written to handle both shapes and isn't a sole read. A call or a key in a request
 * isn't a read: the dead one still goes out.
 */
export function besideReplacement(
  source: Source,
  entry: DeadApiEntry,
  matcher: FieldMatcher,
  read: FieldRead,
): boolean {
  if (read.callArgument) return false;
  const end = source.text.indexOf(matcher.value, read.offset) + matcher.value.length;
  if (source.code.slice(end).trimStart().startsWith('(')) return false;
  const line = lineIndexAt(source, read.offset);
  const found = replacementPaths(entry, matcher).flatMap((path) =>
    replacementReads(source, read, path),
  );
  // This read is the new shape itself, off a name bound to its holder.
  if (found.includes(read.offset - read.chain.length)) return true;
  if (keptAlone(source, read, end)) return false;
  return found.some(
    (offset) =>
      Math.abs(lineIndexAt(source, offset) - line) <= FALLBACK_LINES &&
      !FUNCTION_START.test(
        source.code.slice(Math.min(offset, read.offset), Math.max(offset, read.offset)),
      ),
  );
}

/** The reads of one field in a file: off a name for the entry's "on" word, or a variable bound to it. */
export function fieldReads(
  source: Source,
  matcher: FieldMatcher,
  entry: DeadApiEntry,
  { names, clients }: FileBindings,
): (FieldRead & { binding?: Binding })[] {
  const on = matcher.on?.map(normal);
  const inShape = (shape?: string) =>
    Boolean(shape) && (!on || on.includes(normal(shape as string)));
  const isNamed = (receiver: string) => !on || on.includes(normal(receiver));
  // existingSubscription and stripe_invoice: not the word itself, but they say what they hold.
  const holdsWord = (receiver: string) =>
    isNamed(receiver) ||
    (matcher.ambiguous !== true && wordsOf(receiver).some((word) => isNamed(word)));
  const provider = entry.provider.toLowerCase();
  const webhookDoubt = "a webhook object whose name doesn't show which shape it is";
  const reads = [
    ...dottedReads(source, matcher.value),
    ...bracketReads(source, matcher.value),
    ...destructuredReads(source, matcher.value),
  ].flatMap((found): (FieldRead & { binding?: Binding })[] => {
    const receiver = lastSegment(baseOf(found.chain));
    const read = { ...found, receiver };
    // (await stripe.subscriptions.retrieve(id)).field reads a provider call's result directly.
    const called = CALL_RESULT.exec(read.chain);
    if (called && fromProvider(read.chain.replace(LAST_SEGMENT, ''), provider, clients)) {
      if (!inShape(called[2])) return [];
      const note = `${read.chain}()`;
      return [{ ...read, binding: { from: 'call', shape: called[2], note } }];
    }
    if (WEBHOOK_OBJECT.test(read.chain.replace(/[?!]/g, ''))) {
      return [{ ...read, doubt: webhookDoubt }];
    }
    if (read.inlineType && typeNamespace(read.inlineType) === provider) {
      if (!inShape(typeShape(read.inlineType))) return [];
      return [
        {
          ...read,
          binding: {
            from: 'typed',
            shape: typeShape(read.inlineType),
            note: `cast to ${read.inlineType}`,
          },
        },
      ];
    }
    const held = names.get(receiver) ?? [];
    const known = held.filter((one) => one.from !== 'other');
    const shaped = known.find((one) => one.from !== 'webhook' && inShape(one.shape));
    if (shaped) return [{ ...read, binding: shaped }];
    const webhook = known.find((one) => one.from === 'webhook');
    if (webhook) {
      return holdsWord(receiver)
        ? [{ ...read, binding: webhook }]
        : [{ ...read, doubt: webhookDoubt }];
    }
    // Bound to another of the provider's shapes, so this name isn't the object the entry means.
    if (known.length > 0) return [];
    const alias = held.some((one) => one.aliasOf !== undefined && holdsWord(one.aliasOf));
    return holdsWord(receiver) || alias ? [read] : [];
  });
  return [...reads, ...argumentReads(source, matcher), ...commentReads(source, matcher)];
}

/** Whether the object read is the provider's. A read with no evidence is unclear, never live. */
export function readEvidence(
  read: FieldRead & { binding?: Binding },
  { names }: FileBindings,
  namesProvider: boolean,
): ReadEvidence {
  if (read.binding) return { strong: true, why: read.binding.note };
  if (read.doubt) return { strong: false, why: read.doubt };
  if (read.callArgument) {
    return namesProvider
      ? { strong: true, why: `an argument to ${read.chain}` }
      : {
          strong: false,
          why: `an argument to ${read.chain}, in a file that doesn't name the provider`,
        };
  }
  const other = names.get(read.receiver)?.find((one) => one.from === 'other');
  return other
    ? {
        strong: false,
        why: `${read.receiver} comes from ${other.note}, which isn't a provider call`,
      }
    : { strong: false, why: `nothing shows ${read.receiver} is the provider's object` };
}
