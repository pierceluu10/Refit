import { join } from 'node:path';
import { InvalidRepoError } from './git.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';
import { REPO_PATTERN } from './types.ts';
import type { FixEvidence, RepoHabitEvidence } from './types.ts';

// What the app has seen of one Aptitude PR. Every field only ever gains information, whichever order
// webhooks arrive in, and the evidence is worked out from all of it afterwards. That is what makes
// redelivered and out-of-order events end in the same state.
export type FixFacts = {
  url: string;
  opened?: { sha: string; entryIds: string[] }; // our last commit, and the entries it fixed
  edited?: true;
  merged?: { at: string; sha: string; humanDiff?: string; changedFiles: string[] };
  closed?: { at: string; comment?: string };
  returnedAt?: string; // the first rescan after the merge that found a fixed entry back
};

// A revert on the default branch, by the PR or commit it names. Kept even when no merged fix matches
// yet, because a revert's event can arrive before the merge's.
export type SeenRevert = { at: string; pr?: number; sha?: string };

export type RepoFacts = {
  repo: string;
  fixes: Record<string, FixFacts>;
  reverts: SeenRevert[];
};

const REPEATED_AT = 2;
const MAX_HABIT_REASONS = 5;

export const instant = (at: string) => new Date(at).toISOString();
const earliest = (a?: string, b?: string) => (a && b ? (a < b ? a : b) : (a ?? b));

// A PR closed, reopened and closed again keeps its last close, and a comment wins a tie.
function laterClose(a: FixFacts['closed'], b: FixFacts['closed']) {
  if (!a || !b) return a ?? b;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.comment ? a : b;
}

export function mergeFix(old: FixFacts | undefined, fresh: FixFacts): FixFacts {
  return {
    url: fresh.url,
    opened: old?.opened ?? fresh.opened,
    edited: old?.edited ?? fresh.edited,
    merged: old?.merged ?? fresh.merged,
    closed: laterClose(old?.closed, fresh.closed),
    returnedAt: earliest(old?.returnedAt, fresh.returnedAt),
  };
}

export function addReverts(facts: RepoFacts, seen: SeenRevert[]): RepoFacts {
  const key = ({ at, pr, sha }: SeenRevert) => `${at} ${pr ?? ''} ${sha ?? ''}`;
  const all = new Map([...facts.reverts, ...seen].map((revert) => [key(revert), revert]));
  return { ...facts, reverts: [...all.values()].sort((a, b) => key(a).localeCompare(key(b))) };
}

export function revertNames(number: number, fix: FixFacts, revert: SeenRevert): boolean {
  if (revert.pr === number) return true;
  return revert.sha !== undefined && [fix.opened?.sha, fix.merged?.sha].includes(revert.sha);
}

function revertedOf(facts: RepoFacts, number: number, fix: FixFacts): FixEvidence['reverted'] {
  // A revert naming a PR that never merged reverted nothing of ours.
  if (!fix.merged) return undefined;
  // `reverts` is sorted by time, so the first match is the earliest.
  const revertAt = facts.reverts.find((revert) => revertNames(number, fix, revert))?.at;
  const first = earliest(revertAt, fix.returnedAt);
  if (!first) return undefined;
  return { at: first, via: first === revertAt ? 'revert' : 'rescan' };
}

export function evidenceFor(facts: RepoFacts, number: number): FixEvidence {
  const fix = facts.fixes[number];
  const { edited, merged, closed } = fix;
  const reverted = revertedOf(facts, number, fix);
  return {
    // Never `edited: false`: memory keeps the first value it sees, so a false could never become true.
    ...(edited && { edited }),
    ...(merged && {
      merged: { at: merged.at, ...(merged.humanDiff && { humanDiff: merged.humanDiff }) },
    }),
    // Closed, reopened and merged ends up merged.
    ...(closed && !merged && { closed }),
    ...(reverted && { reverted }),
  };
}

export function habitsOf(facts: RepoFacts): RepoHabitEvidence {
  const fixes = Object.values(facts.fixes);
  const rejected = fixes
    .flatMap(({ closed, merged }) => (closed && !merged ? [closed] : []))
    .sort((a, b) => a.at.localeCompare(b.at));
  const touches = new Map<string, number>();
  for (const file of fixes.flatMap((fix) => fix.merged?.changedFiles ?? [])) {
    touches.set(file, (touches.get(file) ?? 0) + 1);
  }
  return {
    repo: facts.repo,
    rejections: {
      count: rejected.length,
      reasons: rejected.flatMap(({ comment }) => comment ?? []).slice(-MAX_HABIT_REASONS),
    },
    edits: {
      count: fixes.filter((fix) => fix.edited).length,
      repeatedFiles: [...touches]
        .filter(([, count]) => count >= REPEATED_AT)
        .map(([file]) => file)
        .sort(),
    },
  };
}

export type FactStore = {
  read: (repo: string) => Promise<RepoFacts>;
  update: (repo: string, change: (facts: RepoFacts) => RepoFacts) => Promise<RepoFacts>;
};

// One JSON file per repo. Deliveries are handled at once, so updates take turns.
// shortcut: one process owns these files, as with the queue; move to a database for several workers.
export function createFactStore(dir: string): FactStore {
  let turn: Promise<unknown> = Promise.resolve();
  const fileFor = (repo: string) => {
    if (!REPO_PATTERN.test(repo)) throw new InvalidRepoError(repo);
    return join(dir, `${repo}.json`);
  };
  const read = async (repo: string): Promise<RepoFacts> =>
    (await readJsonFile<RepoFacts>(fileFor(repo))) ?? { repo, fixes: {}, reverts: [] };
  return {
    read,
    update(repo, change) {
      const next = turn.then(async () => {
        const facts = change(await read(repo));
        await writeJsonFile(fileFor(repo), facts);
        return facts;
      });
      turn = next.catch(() => undefined);
      return next;
    },
  };
}
