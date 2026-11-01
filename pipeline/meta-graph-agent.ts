import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fixWithAgent, type AgentFixResult } from './agent-fix.ts';
import { META_SDK } from './deadline-exposure.ts';
import { movedReconstructions, type GraphReconstruction } from './meta-graph-ai.ts';
import { scanGraphCalls, type GraphCall } from './meta-graph-calls.ts';
import { compareVersions, type MetaGraphChanges } from './meta-graph-changes.ts';
import { checkJsProof } from './meta-graph-code-proof.ts';
import { changesUsedBy, inEffect, type VersionMoveStop } from './meta-graph-moves.ts';
import { proveMetaGraphPatch } from './meta-graph-proof.ts';
import { renderPatch } from './patches.ts';
import { readRepository } from './repository.ts';
import type { Repository, SourceEdit } from './types.ts';

// The gut plan's hand-off (docs/GUT-PLAN.md): where the deterministic version moves and rule edits
// leave work, the agent fixer (agent-fix.ts) works in a copy of the repository, starting from their
// patch, with every old stop as context. Meta's deterministic judges grade it: every traced live
// request must send the target, the change table must prove every changed request at it, and
// checkJs must report no new error on the changed JavaScript.

const exec = promisify(execFile);
export const AGENT_CHANGE = 'meta-graph-agent';
const MAX_CHANGES = 60;
const MAX_CONTEXT = 40_000;

function git(directory: string, args: string[]) {
  return exec(
    'git',
    [
      '-c',
      'user.name=Refit',
      '-c',
      'user.email=refit@localhost',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.quotepath=false',
      ...args,
    ],
    { cwd: directory, maxBuffer: 256 * 1024 * 1024 },
  );
}

// A copy of the repository committed as the original, so its diff is the whole patch, with the
// deterministic patch applied as the agent's starting tree.
export async function agentWorkspace(repository: string, patch: string | null) {
  const directory = await mkdtemp(join(tmpdir(), 'refit-meta-agent-'));
  await cp(repository, directory, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules'].includes(basename(source)),
  });
  await git(directory, ['init', '-q']);
  await git(directory, ['add', '-A']);
  await git(directory, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'original']);
  if (patch) await applyDiff(directory, patch);
  return directory;
}

async function applyDiff(directory: string, diff: string) {
  const file = join(directory, '..', `${basename(directory)}.patch`);
  await writeFile(file, diff);
  try {
    await git(directory, ['apply', '--whitespace=nowarn', file]);
  } finally {
    await rm(file, { force: true });
  }
}

// Whether the workspace already holds `diff`: its reverse applies.
async function holds(directory: string, diff: string) {
  const file = join(directory, '..', `${basename(directory)}.check.patch`);
  await writeFile(file, diff);
  try {
    await git(directory, ['apply', '--reverse', '--check', file]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(file, { force: true });
  }
}

// The workspace's changes against the original, as renderPatch writes patches (whole-file hunks,
// quoted paths) so the rest of Refit reads them like any other; git writes deletions and binary
// files.
export async function workspaceDiff(directory: string) {
  await git(directory, ['add', '-A']);
  const { stdout } = await git(directory, ['diff', '--cached', '--name-status', '-z', 'HEAD']);
  const fields = stdout.split('\0').filter(Boolean);
  const files: { path: string; content: string }[] = [];
  const edits: SourceEdit[] = [];
  const other: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [status, path] = [fields[index], fields[index + 1]];
    if (status !== 'M' && status !== 'A') {
      other.push(path);
      continue;
    }
    const after = await readFile(join(directory, path));
    const before =
      status === 'A'
        ? Buffer.alloc(0)
        : (
            await exec('git', ['show', `HEAD:${path}`], {
              cwd: directory,
              encoding: 'buffer',
              maxBuffer: 256 * 1024 * 1024,
            })
          ).stdout;
    if (after.includes(0) || before.includes(0)) {
      other.push(path);
      continue;
    }
    const content = before.toString('utf8');
    if (status === 'M') files.push({ path, content });
    edits.push({
      file: path,
      start: 0,
      end: content.length,
      replacement: after.toString('utf8'),
      changeId: AGENT_CHANGE,
    });
  }
  const rendered = edits.length ? renderPatch({ root: directory, files } as Repository, edits) : '';
  const raw = other.length
    ? (await git(directory, ['diff', '--cached', '--binary', '--no-color', 'HEAD', '--', ...other]))
        .stdout
    : '';
  return rendered + raw;
}

const location = (call: GraphCall) => `${call.file}:${call.line}`;

// Every live request the patched code still sends below the target, or with no version.
export function requestsBelowTarget(calls: GraphCall[], target: string) {
  return calls
    .filter(
      (call) =>
        call.use === 'live' && (call.version === null || compareVersions(call.version, target) < 0),
    )
    .map((call) =>
      call.version === null
        ? `${location(call)}: ${call.method ?? 'request'} ${call.path ?? 'unknown path'} sends no Graph API version Refit can read; it must send ${target}`
        : `${location(call)}: ${call.method ?? 'request'} ${call.path ?? 'unknown path'} still sends ${call.version}, not ${target}`,
    );
}

// The judge the agent's tree is checked with after every round.
export function metaGraphJudge(options: {
  original: Repository;
  target: string;
  changes: MetaGraphChanges;
  reconstructions?: GraphReconstruction[];
}) {
  return async (directory: string) => {
    const patched = await readRepository(directory, META_SDK);
    const diff = await workspaceDiff(directory);
    const proof = await proveMetaGraphPatch(options.original, patched, {
      changes: options.changes,
      target: options.target,
      reconstructions: options.reconstructions,
    });
    const scan = await scanGraphCalls(directory, {
      repository: patched,
      reconstructions:
        options.reconstructions && movedReconstructions(options.reconstructions, patched),
    });
    const errors = [
      ...new Set([...proof.reasons, ...requestsBelowTarget(scan.calls, options.target)]),
    ];
    // Untyped names and TypeScript files prove nothing either way; a new checkJs error is a bug.
    if (diff)
      errors.push(
        ...checkJsProof(options.original, patched, diff).reasons.filter((reason) =>
          reason.startsWith('checkJs reports a new error'),
        ),
      );
    return { passed: errors.length === 0, errors };
  };
}

// The change-table entries between each live request's version and the target that it uses,
// quoted, for the agent's `change`.
export function changeText(
  calls: GraphCall[],
  changes: MetaGraphChanges,
  target: string,
  now: Date,
) {
  const oldest = changes.versions.map((entry) => entry.version).sort(compareVersions)[0];
  const used = new Map<string, MetaGraphChanges['changes'][number]>();
  for (const call of calls.filter((item) => item.use === 'live')) {
    const from = call.version ?? oldest;
    if (!from || compareVersions(from, target) >= 0) continue;
    const inRange = changes.changes.filter(
      (change) =>
        change.version !== null &&
        compareVersions(change.version, from) > 0 &&
        compareVersions(change.version, target) <= 0 &&
        !inEffect(change, now),
    );
    for (const change of changesUsedBy(call, inRange)) used.set(change.id, change);
  }
  const listed = [...used.values()].sort((a, b) => compareVersions(a.version!, b.version!));
  return [
    `Move every Meta Graph API request to ${target}.`,
    listed.length
      ? `Meta's changelogs list these changes between the versions the code sends and ${target} that its requests may use:`
      : `Meta's reviewed changelogs list no change between the versions the code sends and ${target} that its traced requests use.`,
    ...listed
      .slice(0, MAX_CHANGES)
      .map(
        (change) =>
          `- ${change.version} ${change.kind} ${change.id}: ${change.summary}${change.replacement ? ` Replacement: ${change.replacement}.` : ''}\n  Quote: "${change.quote}" (${change.source})`,
      ),
    ...(listed.length > MAX_CHANGES ? [`- and ${listed.length - MAX_CHANGES} more.`] : []),
  ].join('\n');
}

// Why the deterministic engine could not finish, every stop and finding at once, for `context`.
export function contextText(options: {
  stops: VersionMoveStop[];
  findings: string[];
  notes: string[];
  headStart: string[];
}) {
  const text = [
    ...(options.headStart.length
      ? [
          'Refit already applied these deterministic edits; the working tree starts from them:',
          ...options.headStart.map((item) => `- ${item}`),
        ]
      : []),
    ...(options.stops.length
      ? [
          'Requests Refit could not move, with every reason:',
          ...options.stops.map(
            (stop) =>
              `- ${stop.from ?? 'no readable version'}${stop.file ? ` at ${stop.file}:${stop.line}` : ''} (${stop.requests.map((request) => `${request.method ?? 'request'} ${request.path ?? 'unknown path'} at ${request.file}:${request.line}`).join('; ')}): ${stop.reasons.join(' ')}`,
          ),
        ]
      : []),
    ...(options.findings.length
      ? ['Findings:', ...options.findings.map((item) => `- ${item}`)]
      : []),
    ...(options.notes.length ? ['Notes:', ...options.notes.map((item) => `- ${item}`)] : []),
  ].join('\n');
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n[truncated]` : text;
}

// Runs the agent on a copy of the repository and returns its result with the whole patch, the
// deterministic head start included.
export async function handOffToAgent(options: {
  repository: string;
  original: Repository;
  target: string;
  changes: MetaGraphChanges;
  reconstructions?: GraphReconstruction[];
  patch: string | null;
  change: string;
  context: string;
}): Promise<AgentFixResult & { patch: string }> {
  const directory = await agentWorkspace(options.repository, options.patch);
  try {
    const result = await fixWithAgent({
      repoDir: directory,
      provider: 'meta-graph',
      target: options.target,
      change: options.change,
      context: options.context,
      check: metaGraphJudge(options),
    });
    // The fixer may leave its winning attempt in the workspace or only return it as a diff.
    const errors = [...result.errors];
    if (result.diff && !(await holds(directory, result.diff)))
      await applyDiff(directory, result.diff).catch((error: Error) =>
        errors.push(`The agent's diff does not apply to its starting tree: ${error.message}`),
      );
    return { ...result, errors, patch: await workspaceDiff(directory) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
