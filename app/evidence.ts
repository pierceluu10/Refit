import { redactSecrets } from '../harness/secrets.ts';
import type { Finding } from '../shared/types.ts';
import type { ConsentStore } from './consent.ts';
import {
  addReverts,
  evidenceFor,
  habitsOf,
  instant,
  mergeFix,
  ownedBy,
  revertNames,
} from './fix-facts.ts';
import type { FactStore, FixFacts, RepoFacts, SeenRevert } from './fix-facts.ts';
import { BOT, isPersonCommit } from './github.ts';
import type { ChangedFile, ComparedCommit, FileComparison, PullComment } from './github.ts';
import type { InstallationTokens, OpenedFix, RecordEvidence, RecordHabits } from './types.ts';

// The same cap memory's recipe extraction reads a diff under.
export const MAX_HUMAN_DIFF_CHARS = 60_000;
export const MAX_COMMENT_CHARS = 2_000;
const LIVE = 'live';
const DIRECT_COMPARISONS = new Set(['ahead', 'identical']);
const REWRITTEN_NOTE =
  'The branch was rewritten after our commit, so each file below shows the whole merged change, not only what people edited.';

const REVERT_OF_REVERT = /^Revert "Revert /;
const REVERT_SUBJECT = /^Revert "(.*)"(?: \(#\d+\))?$/;
const NAMED_IN_TITLE = /\(#(\d+)\)$|pull request #(\d+)/;
const REVERTS_PR = /^Reverts (?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gm;
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{40})\b/g;
const REVERT_BRANCH = /^revert-(\d+)-/;

export type EvidenceGitHub = {
  listPullCommits: (token: string, repo: string, number: number) => Promise<ComparedCommit[]>;
  listPullFiles: (token: string, repo: string, number: number) => Promise<ChangedFile[]>;
  commitFiles: (token: string, repo: string, sha: string) => Promise<ChangedFile[]>;
  compareFiles: (
    token: string,
    repo: string,
    base: string,
    head: string,
  ) => Promise<FileComparison>;
  listPullComments: (token: string, repo: string, number: number) => Promise<PullComment[]>;
};

export type EvidenceDeps = {
  tokens: InstallationTokens;
  github: EvidenceGitHub;
  facts: FactStore;
  consent: Pick<ConsentStore, 'consented'>;
  recordEvidence: RecordEvidence;
  recordHabits: RecordHabits;
};

// Only the fields evidence reads; GitHub sends many more.
export type PullEvent = {
  pull_request: {
    html_url: string;
    number: number;
    title: string;
    body: string | null;
    merged: boolean;
    merged_at: string | null;
    closed_at: string | null;
    merge_commit_sha: string | null;
    head: { ref: string; sha: string; repo?: { full_name: string } | null };
    base: { ref: string };
  };
  sender: { login: string; type: string };
  installation: { id: number };
  repository: { full_name: string; default_branch: string };
};

export type PushEvent = {
  ref: string;
  deleted: boolean;
  commits?: { id: string; message: string; timestamp: string }[];
  installation: { id: number };
  repository: { full_name: string; default_branch: string };
};

const capped = (text: string, max: number) =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n[... ${text.length - max} more characters not shown ...]`;

const KEY_EDGE = /-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/;
// A key's body has no name or prefix to go by, only its width: 64 in PEM, 70 in OpenSSH, 76 at most.
// Hashes match too; evidence loses nothing by that.
const KEY_BODY_LINE = /^[ +-]?\s*[A-Za-z0-9+/]{60,76}={0,2}\s*$/;
const HUNK_OR_FILE = /^(?:@@ |--- )/;

// redactSecrets needs both ends of a key, and a diff's context often shows only a slice of one.
// shortcut: a key's short last line, seen with no BEGIN above it, stays; a few characters of a key are no key.
function redactKeySlices(text: string) {
  let inKey = false;
  return text
    .split('\n')
    .map((line) => {
      const edge = KEY_EDGE.exec(line);
      if (edge) inKey = edge[1] === 'BEGIN';
      else if (HUNK_OR_FILE.test(line)) inKey = false;
      return edge || inKey || KEY_BODY_LINE.test(line) ? '[redacted]' : line;
    })
    .join('\n');
}

// Hard limit 4: a secret never leaves in evidence. Redacted before the cap, so a cut can't hide one.
const safeText = (text: string, max: number) => capped(redactKeySlices(redactSecrets(text)), max);

const changedLines = (patch: string) =>
  patch
    .split('\n')
    .filter((line) => /^[+-]/.test(line))
    .join('\n');

// Hunk positions and context move when main moves. The lines a change adds and removes don't.
function sameChange(ours: ChangedFile | undefined, merged: ChangedFile | undefined): boolean {
  if (!ours || !merged) return false;
  if (ours.patch === undefined || merged.patch === undefined) return ours.sha === merged.sha;
  return changedLines(ours.patch) === changedLines(merged.patch);
}

const renderFile = ({ filename, status, patch }: ChangedFile) =>
  `--- ${filename} (${status})\n${patch ?? 'GitHub shows no text diff for this file.'}`;

function renderHumanDiff(files: ChangedFile[], rewritten: boolean) {
  const body = files.map(renderFile).join('\n');
  return safeText(rewritten ? `${REWRITTEN_NOTE}\n${body}` : body, MAX_HUMAN_DIFF_CHARS);
}

// What people changed between our commit and what was merged. A squash's tree can't be compared: it
// also holds everything main gained since we branched, and that isn't an edit to our fix. The PR's
// final head is what was merged, so that is the tree to compare with ours.
async function humanChanges(
  deps: EvidenceDeps,
  token: string,
  repo: string,
  pr: PullEvent['pull_request'],
  ours: string,
): Promise<Pick<NonNullable<FixFacts['merged']>, 'humanDiff' | 'changedFiles'>> {
  if (pr.head.sha === ours) return { changedFiles: [] };
  const [mine, merged, comparison] = await Promise.all([
    deps.github.commitFiles(token, repo, ours),
    deps.github.listPullFiles(token, repo, pr.number),
    deps.github.compareFiles(token, repo, ours, pr.head.sha),
  ]);
  const named = (files: ChangedFile[], path: string) =>
    files.find((file) => file.filename === path);
  // Update branch can bring main's edits into our files, and those leave our change as it was.
  const edited = new Set(
    [...mine, ...merged]
      .map((file) => file.filename)
      .filter((path) => !sameChange(named(mine, path), named(merged, path))),
  );
  const direct = DIRECT_COMPARISONS.has(comparison.status);
  const files = (direct ? comparison.files : merged).filter((file) => edited.has(file.filename));
  if (files.length === 0) return { changedFiles: [] };
  return {
    humanDiff: renderHumanDiff(files, !direct),
    changedFiles: files.map((file) => file.filename).sort(),
  };
}

// The closing person's own latest word, else the latest word from any person. No guessing from content.
export function closingComment(comments: PullComment[], closer: string): string | undefined {
  const said = comments
    .filter((comment) => comment.body?.trim() && comment.user?.type !== BOT)
    .sort((a, b) => a.at.localeCompare(b.at));
  const fromCloser = said.filter((comment) => comment.user?.login === closer);
  const chosen = fromCloser.at(-1) ?? said.at(-1);
  return chosen?.body ? safeText(chosen.body, MAX_COMMENT_CHARS) : undefined;
}

type Named = { prs: number[]; shas: string[] };

// What a revert commit or PR says it reverts, in the words git and GitHub write. Reverting a revert
// puts the fix back, so it names nothing.
// shortcut: a fix put back that way stays counted as reverted; track re-applies if that skews the ladder.
export function revertedBy(message: string, repo: string): Named {
  const subject = message.split('\n', 1)[0];
  if (REVERT_OF_REVERT.test(subject)) return { prs: [], shas: [] };
  const title = REVERT_SUBJECT.exec(subject)?.[1].match(NAMED_IN_TITLE);
  const inTitle = title ? [Number(title[1] ?? title[2])] : [];
  const inBody = [...message.matchAll(REVERTS_PR)]
    .filter(([, named]) => !named || named === repo)
    .map(([, , number]) => Number(number));
  return {
    prs: [...new Set([...inTitle, ...inBody])],
    shas: [...message.matchAll(REVERTS_COMMIT)].map(([, sha]) => sha),
  };
}

const seenAt = (at: string, { prs, shas }: Named): SeenRevert[] => [
  ...prs.map((pr) => ({ at: instant(at), pr })),
  ...shas.map((sha) => ({ at: instant(at), sha })),
];

export function createEvidence(deps: EvidenceDeps) {
  // Consent is read fresh each time, so a revoked yes stops sharing from the next event on.
  async function send(installationId: number, facts: RepoFacts, numbers: number[]) {
    const consented = await deps.consent.consented(installationId);
    for (const number of numbers) {
      await deps.recordEvidence(facts.fixes[number].url, evidenceFor(facts, number), { consented });
    }
    await deps.recordHabits(habitsOf(facts));
  }

  const withFix = (facts: RepoFacts, number: number, fresh: FixFacts): RepoFacts => ({
    ...facts,
    fixes: { ...facts.fixes, [number]: mergeFix(facts.fixes[number], fresh) },
  });

  const addFix = (installationId: number, repo: string, number: number, fresh: FixFacts) =>
    deps.facts.update(repo, (facts) => withFix(ownedBy(facts, installationId), number, fresh));

  async function recordReverts(installationId: number, repo: string, seen: SeenRevert[]) {
    if (seen.length === 0) return;
    const facts = await deps.facts.update(repo, (current) =>
      addReverts(ownedBy(current, installationId), seen),
    );
    const numbers = Object.keys(facts.fixes)
      .map(Number)
      .filter((number) => {
        const fix = facts.fixes[number];
        return fix.merged && seen.some((revert) => revertNames(number, fix, revert));
      });
    if (numbers.length > 0) await send(installationId, facts, numbers);
  }

  async function mergedFacts(event: PullEvent, known: FixFacts | undefined): Promise<FixFacts> {
    const { pull_request: pr, repository, installation } = event;
    if (known?.merged || !pr.merged_at) return { url: pr.html_url };
    const repo = repository.full_name;
    const token = await deps.tokens.token(installation.id);
    const commits = await deps.github.listPullCommits(token, repo, pr.number);
    // shortcut: a PR opened before the app kept its commit has no humanDiff; `edited` still works.
    const changes = known?.opened
      ? await humanChanges(deps, token, repo, pr, known.opened.sha)
      : { changedFiles: [] };
    // A person's amend keeps the bot as author, and resolving a conflict is a merge commit, so a change
    // in what was merged counts as an edit even when no commit looks like a person's.
    const edited = commits.some(isPersonCommit) || changes.humanDiff !== undefined;
    return {
      url: pr.html_url,
      ...(edited && { edited: true as const }),
      merged: {
        at: instant(pr.merged_at),
        sha: pr.merge_commit_sha ?? pr.head.sha,
        ...changes,
        ...(pr.base.ref !== repository.default_branch && { offDefault: true as const }),
      },
    };
  }

  async function closedFacts(event: PullEvent, known: FixFacts | undefined): Promise<FixFacts> {
    const { pull_request: pr, repository, installation, sender } = event;
    if (known?.merged || !pr.closed_at) return { url: pr.html_url };
    const at = instant(pr.closed_at);
    if (known?.closed?.at === at && known.closed.comment) return { url: pr.html_url };
    const token = await deps.tokens.token(installation.id);
    const comments = await deps.github.listPullComments(token, repository.full_name, pr.number);
    const comment = closingComment(comments, sender.login);
    return { url: pr.html_url, closed: { at, ...(comment && { comment }) } };
  }

  return {
    // Our PR just opened: its commit is what later edits are measured from.
    // shortcut: names no installation, so on a name that changed hands the next event drops this too.
    async opened({ repo, number, url, sha, entryIds }: OpenedFix) {
      await deps.facts.update(repo, (facts) =>
        withFix(facts, number, { url, opened: { sha, entryIds } }),
      );
    },

    // The repo left this installation: what its people said goes with it.
    forget: (repo: string) => deps.facts.forget(repo),

    // pull_request.closed on an Aptitude branch.
    async closed(event: PullEvent) {
      const { pull_request: pr, repository, installation } = event;
      const repo = repository.full_name;
      const known = ownedBy(await deps.facts.read(repo), installation.id).fixes[pr.number];
      const fresh = pr.merged ? await mergedFacts(event, known) : await closedFacts(event, known);
      await send(installation.id, await addFix(installation.id, repo, pr.number, fresh), [
        pr.number,
      ]);
    },

    // pull_request.synchronize on an Aptitude branch, where a person pushed their own commit.
    async edited({ pull_request: pr, repository, installation }: PullEvent) {
      const fresh = { url: pr.html_url, edited: true as const };
      const facts = await addFix(installation.id, repository.full_name, pr.number, fresh);
      await send(installation.id, facts, [pr.number]);
    },

    // pull_request.closed on any other branch: GitHub's revert PR form, once merged to the default branch.
    async revertMerged({ pull_request: pr, repository, installation }: PullEvent) {
      if (!pr.merged || !pr.merged_at || pr.base.ref !== repository.default_branch) return;
      const repo = repository.full_name;
      const named = revertedBy(`${pr.title}\n\n${pr.body ?? ''}`, repo);
      const branch = REVERT_BRANCH.exec(pr.head.ref)?.[1];
      const prs = branch ? [...new Set([...named.prs, Number(branch)])] : named.prs;
      await recordReverts(installation.id, repo, seenAt(pr.merged_at, { ...named, prs }));
    },

    // A push to the default branch: `Revert "..."` commits naming our PR or its commit.
    async pushed({ ref, deleted, commits = [], installation, repository }: PushEvent) {
      if (deleted || ref !== `refs/heads/${repository.default_branch}`) return;
      const repo = repository.full_name;
      const seen = commits.flatMap((commit) =>
        seenAt(commit.timestamp, revertedBy(commit.message, repo)),
      );
      await recordReverts(installation.id, repo, seen);
    },

    // Whether a scan of this repo could find anything back, so other repos can skip it.
    hasFixToWatch: async (repo: string) =>
      Object.values((await deps.facts.read(repo)).fixes).some(
        ({ merged, opened }) => merged && !merged.offDefault && opened?.entryIds.length,
      ),

    // Called by the scan path with a scan's findings. `at` is when the checkout was taken, so a scan of
    // code from before a merge never counts against that merge. Only live uses count: a comment
    // mentioning a dead API isn't the dead API back.
    async rescanFound(installationId: number, repo: string, findings: Finding[], at: string) {
      const live = findings.filter((finding) => finding.matchClass === LIVE);
      const scannedAt = instant(at);
      const returnedIn = ({ fixes }: RepoFacts) =>
        Object.keys(fixes)
          .map(Number)
          .filter((number) => {
            const { opened, merged } = fixes[number];
            if (!merged || merged.offDefault || scannedAt <= merged.at) return false;
            return live.some((finding) => opened?.entryIds.includes(finding.entryId));
          });
      if (returnedIn(ownedBy(await deps.facts.read(repo), installationId)).length === 0) return;
      const facts = await deps.facts.update(repo, (stored) => {
        const current = ownedBy(stored, installationId);
        return {
          ...current,
          fixes: {
            ...current.fixes,
            ...Object.fromEntries(
              returnedIn(current).map((number) => {
                const fix = current.fixes[number];
                return [number, mergeFix(fix, { url: fix.url, returnedAt: scannedAt })];
              }),
            ),
          },
        };
      });
      await send(installationId, facts, returnedIn(facts));
    },
  };
}

export type Evidence = ReturnType<typeof createEvidence>;
