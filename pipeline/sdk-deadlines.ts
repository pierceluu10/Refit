// Matching for package and product deadlines in the registry: `kind: 'sdk'` versions name an npm
// package, optionally narrowed to the releases a provider stopped supporting (`@clerk/nextjs@<5`),
// and `kind: 'feature'` versions are source markers of a product that shuts down, such as an API
// hostname or an SDK option name. Nothing is installed or executed.
import ts from 'typescript-compiler';

// A range is one or more space-separated comparators that must all hold, as in `>=5 <7`. A
// comparator's version may leave out its minor and patch numbers, which then count as 0.
const COMPARATOR = /^(<=|>=|<|>|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
// A full version, with any prerelease or build suffix, as a lockfile records it.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.+-]*)?$/;
// Declared specifiers whose lowest release fixes the installed major: an exact version, a caret or
// tilde range, or an x-range such as `4.x` or `4`. Open ranges (`>=4`, `*`, `latest`, tags, URLs
// and workspace links) could resolve to any release, so they are not read.
const DECLARED = /^[\^~=]?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+][0-9A-Za-z.+-]*)?$/i;

// A marker that names a variable or option, such as `SUPABASE_ANON_KEY` or `dynamicLinkDomain`.
const NAME = /^[A-Za-z_$][\w$]*$/;

type Version = [number, number, number];

function compare(left: Version, right: Version) {
  for (let index = 0; index < 3; index += 1)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function comparators(range: string) {
  const parts = range.trim().split(/\s+/);
  const parsed = parts.map((part) => COMPARATOR.exec(part));
  if (!range.trim() || parsed.some((match) => !match)) return undefined;
  return parsed.map((match) => ({
    operator: match![1] ?? '=',
    version: [Number(match![2]), Number(match![3] ?? 0), Number(match![4] ?? 0)] as Version,
  }));
}

// The package an `sdk` deadline names and the range of its releases the deadline covers. A scoped
// package's own `@` is not a range separator.
export function sdkTarget(version: string): { name: string; range: string | null } {
  const separator = version.indexOf('@', 1);
  return separator < 0
    ? { name: version, range: null }
    : { name: version.slice(0, separator), range: version.slice(separator + 1) };
}

export function validRange(range: string) {
  return comparators(range) !== undefined;
}

// The releases a range allows, as an interval: `undefined` bounds are open. A missing range allows
// every release.
function interval(range: string | null) {
  let low: { version: Version; inclusive: boolean } | undefined;
  let high: { version: Version; inclusive: boolean } | undefined;
  for (const { operator, version } of comparators(range ?? '') ?? []) {
    if (operator === '>' || operator === '>=' || operator === '=') {
      const inclusive = operator !== '>';
      if (
        !low ||
        compare(version, low.version) > 0 ||
        (compare(version, low.version) === 0 && !inclusive)
      )
        low = { version, inclusive };
    }
    if (operator === '<' || operator === '<=' || operator === '=') {
      const inclusive = operator !== '<';
      if (
        !high ||
        compare(version, high.version) < 0 ||
        (compare(version, high.version) === 0 && !inclusive)
      )
        high = { version, inclusive };
    }
  }
  return { low, high };
}

// Whether two ranges of one package share a release, so that release would have two deadlines.
export function rangesOverlap(left: string | null, right: string | null) {
  const a = interval(left);
  const b = interval(right);
  const lows = [a.low, b.low].filter((bound) => bound !== undefined);
  const highs = [a.high, b.high].filter((bound) => bound !== undefined);
  for (const low of lows)
    for (const high of highs) {
      const order = compare(low.version, high.version);
      if (order > 0 || (order === 0 && !(low.inclusive && high.inclusive))) return false;
    }
  return true;
}

// Whether a full version is inside a range. A prerelease counts as its release.
export function satisfiesRange(version: string, range: string) {
  const match = VERSION.exec(version);
  const required = comparators(range);
  if (!match || !required) return false;
  const actual: Version = [Number(match[1]), Number(match[2]), Number(match[3])];
  return required.every(({ operator, version: bound }) => {
    const order = compare(actual, bound);
    if (operator === '<') return order < 0;
    if (operator === '<=') return order <= 0;
    if (operator === '>') return order > 0;
    if (operator === '>=') return order >= 0;
    return order === 0;
  });
}

// The release a repository installs: the locked version when a lockfile records one, otherwise the
// lowest release a bounded declared specifier allows. Null when neither says which major it is.
export function installedVersion(declared: string, locked: string | null) {
  if (locked && VERSION.test(locked)) return locked.replace(/^v/, '');
  const match = DECLARED.exec(declared.trim());
  if (!match) return null;
  const part = (value: string | undefined) => (value && /^\d+$/.test(value) ? value : '0');
  return `${match[1]}.${part(match[2])}.${part(match[3])}`;
}

// Each place a line names a feature marker, with the column where it starts so the caller can tell
// code from comments.
export function featureMatches<Provider extends string>(
  line: string,
  features: { provider: Provider; marker: string }[],
) {
  const found: { provider: Provider; marker: string; column: number }[] = [];
  for (const { provider, marker } of features)
    for (let column = line.indexOf(marker); column >= 0; column = line.indexOf(marker, column + 1))
      found.push({ provider, marker, column });
  return found;
}

// The text of the string or template piece around each offset of a source file, if any.
export function literalTextAt(path: string, content: string) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const ranges: [number, number, string][] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      ranges.push([node.getStart(source), node.end, node.text]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return (offset: number) => ranges.find(([start, end]) => offset >= start && offset < end)?.[2];
}

// A marker that names a variable is used where code reads that name: as an identifier, or as a
// string that is only a name, as in `Deno.env.get('SUPABASE_ANON_KEY')` or a list of required
// variables. Inside a longer string, such as an error message or a generated `.env` template, it
// is prose. Hostnames and package names are used inside longer strings (URLs, import paths).
export function markerInProse(marker: string, literal: string | undefined) {
  return NAME.test(marker) && literal !== undefined && !NAME.test(literal.trim());
}
