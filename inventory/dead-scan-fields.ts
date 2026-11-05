// A field matcher's hits: a property read off an "on" word, and whether the object is the provider's.
// shortcut: bindings are per file, not per scope, so two variables of one name count together.
// Fine for telling a provider's object from an app's own; upgrade if P5 finds a miss from it.
import { escapeRegex } from '../dead-apis/match.ts';
import type { DeadApiEntry, DeadApiMatcher } from '../shared/types.ts';
import { innerText, type Source } from './dead-scan-lex.ts';
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
