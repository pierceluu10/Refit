// Checks that the numbers Refit publishes trace to committed data. docs/benchmarks/claims.json
// quotes each sentence or table row with numbers, and for each number either a query over
// committed results that recomputes it or the reason it cannot be checked. See
// docs/BENCHMARK-CLAIMS.md.
//
//   node scripts/benchmark-claims.mjs [--root <checkout>] [--claims <file>] [--json]
//
// It fails when a recomputed value differs from what the document says, when a quote is no
// longer in its document, or when a number in a covered section belongs to no claim.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- Documents --------------------------------------------------------------------------------

// Whitespace runs count as one space, so padded tables can be quoted compactly.
const normalize = (text) => text.replace(/\s+/g, ' ').trim();

// The lines of the sections in scope: every line, or those under the named `## ` headings. Code
// fences and headings hold no claims.
export function scopedLines(markdown, headings) {
  const lines = [];
  let inScope = !headings;
  let fenced = false;
  for (const [index, line] of markdown.split('\n').entries()) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^## /.test(line) && headings) inScope = headings.includes(line.slice(3).trim());
    if (/^#{1,6} /.test(line) || !inScope || !line.trim()) continue;
    lines.push({ number: index + 1, text: normalize(line) });
  }
  return lines;
}

// Inline code, link targets and image sources are names, not claims; they are blanked out with
// the same length so positions still line up.
function masked(text) {
  return text
    .replace(/`[^`]*`/g, (match) => ' '.repeat(match.length))
    .replace(/\]\([^)]*\)/g, (match) => ` ${' '.repeat(match.length - 1)}`)
    .replace(/https?:\/\/\S+/g, (match) => ' '.repeat(match.length));
}

const MONTH =
  'January|February|March|April|May|June|July|August|September|October|November|December';
// Numbers that are dates, versions, references or ordinals in names, never claims.
const NOT_A_CLAIM = new RegExp(
  [
    String.raw`\b\d{4}-\d{2}(?:-\d{2})?\b`, // dates and Shopify versions
    String.raw`\b(?:${MONTH}) \d{1,2}\b`, // October 16
    String.raw`\bv?\d+\.\d+\.\d+\b`, // x.y.z versions
    String.raw`\bv\d+\.\d+\b`, // Graph API versions
    String.raw`#\d+\b`, // pull requests and issues
    String.raw`\b(?:19|20)\d{2}(?:[–-](?:19|20)\d{2})?\b(?![,.]?\d)`, // years and year ranges
  ].join('|'),
  'g',
);
// Money, ranges, fractions, percentages and plain numbers, longest form first.
// A number with optional thousands separators and decimals.
const N = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const NUMBER = new RegExp(String.raw`\$${N}(?:[–-]${N})?|${N}[–-]${N}%?|${N}\/${N}|${N}%?`, 'g');

// The numeric tokens of a normalized line, with their positions.
export function numericTokens(text) {
  const blank = masked(text).replace(NOT_A_CLAIM, (match) => ' '.repeat(match.length));
  return [...blank.matchAll(NUMBER)]
    .filter((match) => !/[A-Za-z_]$/.test(blank.slice(0, match.index)))
    .map((match) => ({ token: match[0], start: match.index, end: match.index + match[0].length }));
}

// --- Queries ------------------------------------------------------------------------------------

// A dotted path into a row; the empty path is the row itself, for lists of plain values.
const get = (value, path) =>
  path
    ? path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), value)
    : value;
const pointer = (value, path) =>
  path
    .split('/')
    .slice(1)
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((current, key) => (current == null ? undefined : current[key]), value);

function matches(row, condition) {
  if (condition.any) return condition.any.some((option) => matches(row, option));
  if (condition.not) return !matches(row, condition.not);
  const value = get(row, condition.field);
  if ('equals' in condition) return JSON.stringify(value) === JSON.stringify(condition.equals);
  // Two fields of the same row, such as a first and a final label.
  if (condition.equalsField)
    return JSON.stringify(value) === JSON.stringify(get(row, condition.equalsField));
  if (condition.in) return condition.in.includes(value);
  if (condition.notIn) return !condition.notIn.includes(value);
  if ('exists' in condition) return (value !== undefined && value !== null) === condition.exists;
  if ('nonEmpty' in condition)
    return (Array.isArray(value) ? value.length > 0 : Boolean(value)) === condition.nonEmpty;
  if ('includes' in condition) return Array.isArray(value) && value.includes(condition.includes);
  if (condition.matches)
    return typeof value === 'string' && new RegExp(condition.matches).test(value);
  if ('gt' in condition) return typeof value === 'number' && value > condition.gt;
  if ('gte' in condition) return typeof value === 'number' && value >= condition.gte;
  if ('lte' in condition) return typeof value === 'number' && value <= condition.lte;
  if (condition.some)
    return (
      Array.isArray(value) && value.some((item) => condition.some.every((c) => matches(item, c)))
    );
  throw new Error(`Unknown condition ${JSON.stringify(condition)}.`);
}

const filter = (rows, conditions = []) =>
  rows.filter((row) => conditions.every((condition) => matches(row, condition)));

// `inQuery` is membership in the values another query's rows have at its `field`: a join, such
// as "labelled repositories with a live label". It is resolved to a plain `in` list first.
function resolveJoins(conditions, read) {
  return (conditions ?? []).map((condition) => {
    if (condition.inQuery) {
      const { field = '', ...query } = condition.inQuery;
      const values = filter(rowsOf(query, read), resolveJoins(query.where, read)).map((row) =>
        get(row, field),
      );
      return { field: condition.field, in: values };
    }
    if (condition.any) return { any: resolveJoins(condition.any, read) };
    if (condition.not) return { not: resolveJoins([condition.not], read)[0] };
    if (condition.some) return { ...condition, some: resolveJoins(condition.some, read) };
    return condition;
  });
}

// The rows a query reads: each results file's arrays at `rows` (one pointer or several; default:
// the file itself when it is an array), concatenated in order, kept only when they match `within`,
// and optionally flattened into a nested array per row.
function rowsOf(query, read) {
  return query.results
    .flatMap((file) =>
      [query.rows ?? ''].flat().flatMap((path) => {
        const rows = path ? pointer(read(file), path) : read(file);
        if (!Array.isArray(rows)) throw new Error(`${file}${path} is not an array.`);
        return rows;
      }),
    )
    .filter((row) => !query.within || filter([row], resolveJoins(query.within, read)).length)
    .flatMap((row) => (query.flatten ? (get(row, query.flatten) ?? []) : [row]));
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};

// 95% Wilson score interval, in percent, as the deadline benchmark reports it.
export function wilson(k, n, z = 1.96) {
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half) * 100, Math.min(1, centre + half) * 100];
}

// What a query computes: a number, or [part, whole] for a fraction, or [low, high] for an
// interval.
// `pick` takes one end of a pair, for prose that writes an interval's bounds apart.
export function evaluate(query, read) {
  const result = measure(query, read);
  return query.pick === undefined ? result : result[query.pick];
}

function measure(query, read) {
  // `scale` turns a stored fraction into the percentage a document writes.
  if (query.value) return pointer(read(query.results[0]), query.value) * (query.scale ?? 1);
  const rows = filter(rowsOf(query, read), resolveJoins(query.where, read));
  const field = (name) =>
    rows.map((row) => get(row, name)).filter((value) => typeof value === 'number');
  switch (query.measure ?? 'count') {
    case 'count':
      return rows.length;
    case 'sum':
      return field(query.field).reduce((total, value) => total + value, 0);
    case 'distinct':
      return new Set(rows.map((row) => JSON.stringify(get(row, query.field)))).size;
    case 'mean':
      return (
        field(query.field).reduce((total, value) => total + value, 0) / field(query.field).length
      );
    // Values of a field that more than one row has: repositories in both of two lists.
    case 'repeated': {
      const seen = new Map();
      for (const row of rows) {
        const key = JSON.stringify(get(row, query.field));
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen.values()].filter((times) => times > 1).length;
    }
    // For an even count, the mean of the two middle values.
    case 'median': {
      const sorted = field(query.field).sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    case 'max':
      return Math.max(...field(query.field));
    case 'range':
      return [Math.min(...field(query.field)), Math.max(...field(query.field))];
    // One sum over another, in percent: "traced 661 of 1,895 (35%)".
    case 'ratio':
      return (
        (field(query.field).reduce((total, value) => total + value, 0) /
          field(query.of).reduce((total, value) => total + value, 0)) *
        100
      );
    case 'percentile':
      return quantile(field(query.field), query.percentile / 100);
    case 'fraction':
    case 'rate':
    case 'interval': {
      const part = filter(rows, resolveJoins(query.part, read)).length;
      const result =
        query.measure === 'fraction'
          ? [part, rows.length]
          : query.measure === 'rate'
            ? (part / rows.length) * 100
            : wilson(part, rows.length);
      return result;
    }
    default:
      throw new Error(`Unknown measure ${query.measure}.`);
  }
}

// What a document's token says, in the form `evaluate` returns: "6,512" is 6512, "45%" is 45,
// "$0.07" is 0.07, "28/32" and "28 of 32" are [28, 32], "72–95" is [72, 95].
export function parseSays(says) {
  const number = (text) => Number(text.replace(/[$,%]/g, ''));
  const pair = /^\$?([\d.,]+)%?\s*(?:\/|of|[–-])\s*\$?([\d.,]+)%?$/.exec(says);
  if (pair) return [number(pair[1]), number(pair[2])];
  if (/^\$?[\d.,]+%?$/.test(says)) return number(says);
  throw new Error(`Cannot read the number in "${says}".`);
}

// Whether a recomputed value reproduces what the document says, at the document's precision.
export function reproduces(says, value) {
  const stated = parseSays(says);
  // Each written number is compared at its own decimal places: "86–99.5" is 86 and 99.5.
  const places = (says.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(
    (text) => /\.(\d+)/.exec(text)?.[1].length ?? 0,
  );
  const round = (number, index) => Number(number.toFixed(places[index] ?? 0));
  if (Array.isArray(stated))
    return (
      Array.isArray(value) && stated.every((part, index) => round(value[index], index) === part)
    );
  return typeof value === 'number' && round(value, 0) === stated;
}

const show = (value) =>
  Array.isArray(value)
    ? value.map((part) => Number(part.toFixed(2))).join('/')
    : typeof value === 'number'
      ? String(Number(value.toFixed(2)))
      : JSON.stringify(value);

// --- The claims file ------------------------------------------------------------------------------

export function checkClaims(claimsFile, { root = ROOT } = {}) {
  const claims = JSON.parse(readFileSync(claimsFile, 'utf8'));
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(join(root, file), 'utf8')));
    return cache.get(file);
  };
  const problems = [];
  const values = [];
  const scopes = new Map(
    claims.scope.map((entry) => [
      entry.doc,
      scopedLines(readFileSync(join(root, entry.doc), 'utf8'), entry.headings),
    ]),
  );
  // Positions each claim covers, by document and line.
  const covered = new Map();
  for (const claim of claims.claims) {
    const lines = scopes.get(claim.doc);
    const quote = normalize(claim.quote);
    const where = `${claim.doc}: "${quote.slice(0, 80)}${quote.length > 80 ? '…' : ''}"`;
    if (!lines) {
      problems.push(`${where} is outside every scope entry.`);
      continue;
    }
    const found = lines.filter((line) => line.text.includes(quote));
    if (!found.length) {
      problems.push(`${where} is not in the document any more.`);
      continue;
    }
    for (const line of found) {
      let start = line.text.indexOf(quote);
      while (start >= 0) {
        const spans = covered.get(`${claim.doc}:${line.number}`) ?? [];
        spans.push([start, start + quote.length]);
        covered.set(`${claim.doc}:${line.number}`, spans);
        start = line.text.indexOf(quote, start + 1);
      }
    }
    // Every number in the quote is accounted for: checked, not checkable, or not a claim.
    const listed = [
      ...claim.values.map((value) => value.says),
      ...(claim.ignore ?? []).map((item) => item.token),
    ].sort();
    const inQuote = numericTokens(quote)
      .map((token) => token.token)
      .sort();
    if (JSON.stringify(listed) !== JSON.stringify(inQuote))
      problems.push(
        `${where} has numbers [${inQuote.join(', ')}] but lists [${listed.join(', ')}].`,
      );
    for (const item of claim.ignore ?? [])
      if (!item.reason?.trim()) problems.push(`${where} ignores ${item.token} without a reason.`);
    for (const value of claim.values) {
      const entry = { doc: claim.doc, quote, says: value.says };
      if (value.notCheckable !== undefined) {
        if (!value.notCheckable.trim() || /\bTODO\b/.test(value.notCheckable))
          problems.push(`${where} gives no reason why ${value.says} cannot be checked.`);
        values.push({ ...entry, status: 'not-checkable', reason: value.notCheckable });
        continue;
      }
      try {
        const recomputed = evaluate(value.query, read);
        values.push({
          ...entry,
          status: reproduces(value.says, recomputed) ? 'reproduces' : 'differs',
          recomputed: show(recomputed),
          results: value.query.results,
          ...(value.note ? { note: value.note } : {}),
        });
      } catch (error) {
        problems.push(`${where}: ${value.says} cannot be computed: ${error.message}`);
      }
    }
  }
  // Every number in scope belongs to some claim.
  for (const [doc, lines] of scopes)
    for (const line of lines) {
      const spans = covered.get(`${doc}:${line.number}`) ?? [];
      const loose = numericTokens(line.text).filter(
        (token) => !spans.some(([start, end]) => token.start >= start && token.end <= end),
      );
      if (loose.length)
        problems.push(
          `${doc}:${line.number} has numbers in no claim: ${loose.map((token) => token.token).join(', ')} in "${line.text.slice(0, 100)}"`,
        );
    }
  return { values, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: options } = parseArgs({
    options: {
      // The checkout whose documents and results the claims name, by default this one.
      root: { type: 'string', default: ROOT },
      claims: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (options.help) {
    console.log(
      'Usage: node scripts/benchmark-claims.mjs [--root <checkout>] [--claims <claims.json>] [--json]',
    );
    process.exit(0);
  }
  const root = resolve(options.root);
  const { values, problems } = checkClaims(
    resolve(options.claims ?? join(root, 'docs/benchmarks/claims.json')),
    { root },
  );
  const count = (status) => values.filter((value) => value.status === status).length;
  if (options.json) console.log(JSON.stringify({ values, problems }, null, 2));
  else {
    for (const value of values.filter((item) => item.status === 'differs'))
      console.log(
        `differs  ${value.doc}: says ${value.says}, recomputed ${value.recomputed}\n         "${value.quote.slice(0, 160)}"`,
      );
    for (const problem of problems) console.log(`problem  ${problem}`);
    console.log(
      `${count('reproduces')} reproduce, ${count('differs')} differ, ${count('not-checkable')} not checkable; ${problems.length} problem(s).`,
    );
  }
  if (count('differs') || problems.length) process.exitCode = 1;
}
