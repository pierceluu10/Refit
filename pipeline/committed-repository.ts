import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gitEnvironment } from './git-environment.ts';
import { PipelineInputError } from './types.ts';

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_SYMBOLIC_LINKS = 256;
// Linux resolves at most 40 links in one path lookup.
const MAX_LINK_HOPS = 40;
const REGULAR_ENTRY = /^(100644|100755) blob /;
const LINK_ENTRY = /^120000 blob ([0-9a-f]+)\t(.+)$/;
const SUBMODULE_ENTRY = /^160000 commit [0-9a-f]+\t(.+)$/;

// Resolves a committed link through the tree, including links in its target, and reports whether
// every step stays inside the repository. A dangling target inside the repository is accepted.
export function linkStaysInside(path: string, links: Map<string, string>) {
  const resolved = path.split('/').slice(0, -1);
  const pending = links.get(path)!.split('/');
  let hops = 1;
  if (pending[0] === '') return false;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return false;
      resolved.pop();
      continue;
    }
    resolved.push(part);
    const target = links.get(resolved.join('/'));
    if (target === undefined) continue;
    if (target.startsWith('/') || ++hops > MAX_LINK_HOPS) return false;
    resolved.pop();
    pending.unshift(...target.split('/'));
  }
  return true;
}

export async function readCommittedFile(
  snapshot: Awaited<ReturnType<typeof readCommittedRepository>>,
  path: string,
  maximumBytes: number,
) {
  if (
    !snapshot.entries.some(
      (entry) => REGULAR_ENTRY.test(entry) && entry.slice(entry.indexOf('\t') + 1) === path,
    )
  )
    throw new PipelineInputError(
      `Repository profile input is not a committed regular file: ${path}`,
    );
  const object = `${snapshot.revision}:${path}`;
  const bytes = Number((await snapshot.git(['cat-file', '-s', object])).stdout.trim());
  const limit = Math.min(maximumBytes, MAX_GIT_OUTPUT_BYTES);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit)
    throw new PipelineInputError(`Committed input ${path} exceeds its ${limit}-byte read limit.`);
  const content = (await snapshot.git(['show', object])).stdout;
  if (Buffer.byteLength(content) !== bytes)
    throw new PipelineInputError(`Committed input ${path} is not supported UTF-8 text.`);
  return content;
}

// The submodule paths a committed .gitmodules declares, read by Git's own config parser.
async function declaredSubmodules(
  git: (argumentsList: string[]) => Promise<{ stdout: string }>,
  revision: string,
  entries: string[],
) {
  if (!entries.some((entry) => REGULAR_ENTRY.test(entry) && entry.endsWith('\t.gitmodules')))
    return new Set<string>();
  try {
    const { stdout } = await git([
      'config',
      '-z',
      `--blob=${revision}:.gitmodules`,
      '--get-regexp',
      '^submodule\\..*\\.path$',
    ]);
    return new Set(
      stdout
        .split('\0')
        .filter(Boolean)
        .map((entry) => entry.slice(entry.indexOf('\n') + 1)),
    );
  } catch (error) {
    // Exit 1: no submodule declares a path.
    if ((error as { code?: unknown }).code === 1) return new Set<string>();
    throw error;
  }
}

// With `submodules` (owner decision 1) a submodule is left out instead of refused: Refit checks
// the committed root without it, and `submodules` names each one so the draft can say so.
export async function readCommittedRepository(
  path: string,
  options: { submodules?: boolean } = {},
) {
  const directory = await realpath(path);
  const git = (argumentsList: string[]) =>
    execute('git', ['-c', 'core.fsmonitor=false', '-C', directory, ...argumentsList], {
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnvironment(),
    });
  const topLevel = await realpath((await git(['rev-parse', '--show-toplevel'])).stdout.trim());
  if (directory !== topLevel)
    throw new PipelineInputError('Validation requires the Git repository root directory.');
  const revision = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
  const changed = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
  if (changed.length)
    throw new PipelineInputError(
      `Validation requires a clean committed repository, including untracked files; not committed: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, and ${changed.length - 5} more` : ''}.`,
    );
  const tree = (await git(['ls-tree', '-rz', revision])).stdout.split('\0').filter(Boolean);
  const submodules = options.submodules
    ? tree.flatMap((entry) => SUBMODULE_ENTRY.exec(entry)?.[1] ?? [])
    : [];
  const entries = tree.filter((entry) => !submodules.length || !SUBMODULE_ENTRY.test(entry));
  const linkEntries = entries
    .map((entry) => LINK_ENTRY.exec(entry))
    .filter((match): match is RegExpExecArray => Boolean(match));
  // A gitlink .gitmodules does not declare has no URL, so every clone, CI run and deploy sees an
  // empty directory there; git archive writes the same empty directory for validation.
  const declared = entries.some((entry) => SUBMODULE_ENTRY.test(entry))
    ? await declaredSubmodules(git, revision, entries)
    : new Set<string>();
  const submodule = entries.find((entry) => {
    const gitlink = SUBMODULE_ENTRY.exec(entry);
    if (gitlink) return declared.has(gitlink[1]);
    return !REGULAR_ENTRY.test(entry) && !LINK_ENTRY.test(entry);
  });
  if (submodule)
    throw new PipelineInputError(
      `Validation does not accept submodules; ${submodule.slice(submodule.indexOf('\t') + 1)} is one. Refit checks committed files only, so commit its files to the repository or remove the submodule.`,
    );
  if (linkEntries.length > MAX_SYMBOLIC_LINKS)
    throw new PipelineInputError(
      `Validation accepts at most ${MAX_SYMBOLIC_LINKS} tracked symbolic links.`,
    );
  const links = new Map<string, string>();
  for (const [, object, linkPath] of linkEntries)
    links.set(linkPath, (await git(['cat-file', 'blob', object])).stdout);
  const escaping = [...links.keys()].find((linkPath) => !linkStaysInside(linkPath, links));
  if (escaping)
    throw new PipelineInputError(
      `Validation accepts tracked symbolic links only when they resolve inside the repository; ${escaping} does not.`,
    );
  return { directory, revision, entries, git, submodules };
}
