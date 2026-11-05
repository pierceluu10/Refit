// shortcut: a stand-in for Pierce's scanner (P4), on his real list, so the product can be measured
// before the scanner lands. Delete it once P4 is in rebuild/integration. Evals only, never the product.
// Per line it matches each entry's matchers, keeps an entry only where its provider shows up in the
// repo, gates Stripe entries on the version the repo runs, and sorts live code from tests and comments.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { entriesInForce, loadDeadApis } from '../../dead-apis/list.ts';
import { textMatches, urlMatches } from '../../dead-apis/match.ts';
import type { DeadApiEntry, Finding, ScanResult } from '../../harness/findings.ts';

const SKIP = /^(node_modules|dist|build|\.next|out|vendor|coverage|\.git|__pycache__|venv|\.venv)$/;
const CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|json|ya?ml|toml|ipynb|vue|svelte|html)$|^\.env\.(example|sample|template)$|^requirements.*\.txt$/;
const LOCK = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|\.min\.js)$/;

type Matcher = DeadApiEntry['matchers'][number];

export const standinList = (): DeadApiEntry[] =>
  entriesInForce(loadDeadApis(), new Date().toISOString().slice(0, 10));

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function hits(matcher: Matcher, line: string): boolean {
  switch (matcher.kind) {
    case 'string': {
      const plain = !matcher.value.includes('*') && matcher.caseSensitive !== false;
      return (!plain || line.includes(matcher.value)) && textMatches(matcher, line);
    }
    case 'regex':
      return textMatches(matcher, line);
    case 'url':
      return urlMatches(matcher, line);
    case 'field':
      return (
        line.includes(matcher.value) &&
        (matcher.on ?? ['']).some((name) =>
          new RegExp(`\\b\\w*${escape(name)}\\w*\\??\\.${escape(matcher.value)}\\b`, 'i').test(
            line,
          ),
        )
      );
    case 'package':
      return new RegExp(`["'\`]${escape(matcher.value)}["'\`]`).test(line);
  }
}

const classOf = (file: string, line: string): Finding['matchClass'] => {
  if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return 'comment';
  if (/(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?)(\/|$)|\.(test|spec)\.\w+$/.test(file))
    return 'test';
  if (/(^|\/)(docs?|examples?|samples?)\/|^\./.test(file)) return 'comment';
  return 'live';
};

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.test(name)) continue;
    const full = path.join(dir, name);
    const info = statSync(full, { throwIfNoEntry: false });
    if (info?.isDirectory()) walk(root, full, out);
    else if (info?.isFile() && info.size < 500_000 && CODE.test(name) && !LOCK.test(name))
      out.push(full);
  }
  return out;
}

// The Stripe API version the repo runs: its pin, else the release its SDK major sends.
function stripeVersion(texts: string[], manifest: string): string | undefined {
  const pin = texts
    .flatMap((text) =>
      [...text.matchAll(/apiVersion:\s*["'](\d{4}-\d{2}-\d{2})/g)].map((m) => m[1] as string),
    )
    .sort()[0];
  if (pin) return pin;
  const major = /"stripe":\s*"[\^~]?(\d+)/.exec(manifest)?.[1];
  return major && Number(major) >= 18 ? '2025-03-31' : undefined;
}

export function standinScan(root: string, list: DeadApiEntry[] = standinList()): ScanResult {
  const files = walk(root).map((file) => ({
    file: path.relative(root, file),
    text: readFileSync(file, 'utf8'),
  }));
  const manifest = files.find((f) => f.file === 'package.json')?.text ?? '';
  const stripe = stripeVersion(
    files.map((f) => f.text),
    manifest,
  );
  const all = files.map((f) => f.text).join('\n');
  const inRepo = (entry: DeadApiEntry) =>
    !entry.context ||
    [...(entry.context.packages ?? []), ...(entry.context.hosts ?? [])].some((name) =>
      all.includes(name),
    );
  const since = (entry: DeadApiEntry) => entry.appliesTo?.apiVersionSince?.slice(0, 10);
  const active = list.filter((entry) => {
    const gate = entry.provider === 'stripe' ? since(entry) : undefined;
    return inRepo(entry) && (!gate || (stripe !== undefined && stripe >= gate));
  });
  const findings: Finding[] = [];
  for (const { file, text } of files) {
    text.split('\n').forEach((line, index) => {
      if (line.length > 1000) return;
      for (const entry of active) {
        const matched = entry.matchers.find((matcher) => hits(matcher, line));
        if (!matched) continue;
        const plain = classOf(file, line);
        findings.push({
          entryId: entry.id,
          file,
          line: index + 1,
          matchClass:
            plain === 'live' && 'ambiguous' in matched && matched.ambiguous ? 'unclear' : plain,
          ...(entry.provider === 'stripe' && stripe ? { version: stripe } : {}),
        });
      }
    });
  }
  // Comments never start a fix; a test that hard-codes the name goes with the live finding it pins.
  return {
    findings: findings.filter((finding) => finding.matchClass !== 'comment'),
    unlistedProviders: [],
    clean: !findings.some((finding) => finding.matchClass === 'live'),
  };
}
