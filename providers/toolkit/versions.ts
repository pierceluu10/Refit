// Loose version parsing for npm (semver) and PyPI (PEP 440) versions and the ranges repos pin.
// It only orders versions and finds majors for the tools' reports; it never decides support.

export type Version = { major: number; minor: number; patch: number; pre: string; raw: string };

const PRE_PEP440 = /^(a|b|c|rc|alpha|beta|pre|preview|dev)\.?\d*/i;

/** Parse "1.2.3", "v1.2.3-beta.1", "^4.2.0", "~=1.2", "==2.0.1rc1", "1.2.3.post1" and the like. */
export function parseVersion(raw: string): Version | undefined {
  const text = raw.trim().replace(/^[\w@./-]*@(?=[\^~=<>v]?\d)/, '');
  const match =
    /^(?:\d+!)?[=v^~><!\s]*v?(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:\.\d+)*([-+._]?[0-9A-Za-z][0-9A-Za-z.-]*)?/.exec(
      text,
    );
  if (!match) return undefined;
  const num = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : 0);
  const suffix = (match[4] ?? '').replace(/^[-_.]/, '');
  const build = suffix.startsWith('+') || /^post\d*/i.test(suffix);
  return {
    major: Number(match[1]),
    minor: num(match[2]),
    patch: num(match[3]),
    pre: build ? '' : suffix.replace(/^\+.*/, ''),
    raw,
  };
}

export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return parsed.pre !== '' && (/^[0-9A-Za-z]/.test(parsed.pre) || PRE_PEP440.test(parsed.pre));
}

/** Negative when a < b. Pre-releases sort before their release; unparseable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

/** The major a pinned version or range starts from: "^14.2.0" -> 14, ">=2,<3" -> 2. */
export function majorOf(range: string | undefined): number | undefined {
  if (!range) return undefined;
  return parseVersion(range)?.major;
}

/** Pull a version out of a release tag such as "v4.2.0", "stripe-v19.0.0" or "@scope/pkg@1.2.3". */
export function versionFromTag(tag: string): string | undefined {
  const match = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+(?:\.\d+)?(?:[-.]?[0-9A-Za-z.]+)?)$/.exec(tag.trim());
  return match?.[1];
}
