// Re-checks a curated dev set by hand-check data: every recorded call site (callSites) and every
// line that declares a pinned version (declaredIn) must still read the same at the repo's pinned
// commit. It reads each file from GitHub at that commit; nothing is cloned, installed or run.
//
//   node evals/sets/check-callsites.ts longtail-dev-20
//   node evals/sets/check-callsites.ts upgrade-dev-20
import { resolve } from 'node:path';
import { loadDevSet, type RepoEntry } from './index.ts';

export type CallSite = { file: string; line: number; text: string };

export type CallSiteCheck = { repo: string; file: string; line: number; problem?: string };

const callSitesOf = (entry: RepoEntry): CallSite[] =>
  [entry.callSites, entry.declaredIn].flatMap((sites) =>
    Array.isArray(sites) ? (sites as CallSite[]) : [],
  );

/** Compares each recorded line with the file at the pinned commit. */
export async function checkCallSites(
  entries: RepoEntry[],
  read: (repo: string, commit: string, file: string) => Promise<string | undefined>,
): Promise<CallSiteCheck[]> {
  const checks: CallSiteCheck[] = [];
  for (const entry of entries) {
    const files = new Map<string, Promise<string | undefined>>();
    for (const site of callSitesOf(entry)) {
      let text = files.get(site.file);
      if (!text) {
        text = read(entry.repo, entry.commit, site.file);
        files.set(site.file, text);
      }
      const content = await text;
      const found = content?.split('\n')[site.line - 1]?.replace(/\r$/, '');
      const problem =
        content === undefined
          ? 'file not found at the pinned commit'
          : found === site.text
            ? undefined
            : `line reads ${JSON.stringify(found ?? '')}`;
      checks.push({
        repo: entry.repo,
        file: site.file,
        line: site.line,
        ...(problem ? { problem } : {}),
      });
    }
  }
  return checks;
}

/** Reads a file at a commit from raw.githubusercontent.com (public repos, no token). */
export async function readFromGitHub(
  repo: string,
  commit: string,
  file: string,
): Promise<string | undefined> {
  const path = file.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${repo}@${commit} ${file}: HTTP ${response.status}`);
  return response.text();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const name = process.argv[2];
  if (!name) throw new Error('usage: node evals/sets/check-callsites.ts <dev set>');
  const set = loadDevSet(name);
  const checks = await checkCallSites(set.repos, readFromGitHub);
  const bad = checks.filter((check) => check.problem);
  for (const check of bad)
    console.log(`MISMATCH ${check.repo} ${check.file}:${check.line}: ${check.problem}`);
  console.log(
    `${set.name}: ${checks.length - bad.length} of ${checks.length} recorded lines match at their pinned commits (${set.repos.length} repos)`,
  );
  process.exitCode = bad.length === 0 ? 0 : 1;
}
