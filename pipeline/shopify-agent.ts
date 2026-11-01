import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fixWithAgent, type AgentFixInput, type AgentFixResult } from './agent-fix.ts';
import { renderPatch } from './patches.ts';
import type { Repository, SourceEdit } from './types.ts';

const execute = promisify(execFile);

export type FixWithAgent = (input: AgentFixInput) => Promise<AgentFixResult>;
export { fixWithAgent };

// What the hand-off produced: the agent's result, with `diff` replaced by the whole patch against
// the original tree (the codemods' edits and the agent's), in Refit's patch format.
export type ShopifyHandOff = AgentFixResult & { files: string[] };

const SKIPPED = new Set(['node_modules', '.git']);
// The scan, the workflow and validation each run the pipeline on the same committed tree; the
// first run with AI pays for the agent, the others reuse its result. It lives beside the run's AI
// ledger, so it never outlives the run; without a ledger directory nothing is reused.
const cacheDirectory = () => {
  const ledger = process.env.REFIT_AI_BUDGET_DIRECTORY?.trim();
  return ledger ? join(ledger, 'shopify-agent') : undefined;
};

const git = (directory: string, args: string[]) =>
  execute(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=Refit',
      '-c',
      'user.email=refit@localhost',
      '-C',
      directory,
      ...args,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );

// Runs the agent on a copy of the repository with the codemods' patch applied. Undefined when AI is
// off and no earlier run with AI left a result for this tree.
export async function shopifyHandOff(options: {
  repository: Repository;
  codemods: string;
  key: string;
  run: boolean;
  agent: FixWithAgent;
  input: Omit<AgentFixInput, 'repoDir' | 'provider'>;
}): Promise<ShopifyHandOff | undefined> {
  const cache = cacheDirectory();
  const cached = cache && join(cache, `${options.key}.json`);
  if (cached && existsSync(cached))
    return JSON.parse(await readFile(cached, 'utf8')) as ShopifyHandOff;
  if (!options.run) return undefined;
  const parent = await mkdtemp(join(tmpdir(), 'refit-shopify-agent-'));
  const directory = join(parent, basename(options.repository.root) || 'repository');
  try {
    await cp(options.repository.root, directory, {
      recursive: true,
      filter: (source) => !SKIPPED.has(basename(source)),
    });
    await git(directory, ['init', '-q']);
    // The agent may install dependencies; they never belong in the patch.
    await writeFile(join(directory, '.git', 'info', 'exclude'), 'node_modules/\n');
    await git(directory, ['add', '-A']);
    await git(directory, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'original']);
    if (options.codemods) {
      await writeFile(join(parent, 'codemods.patch'), options.codemods);
      await git(directory, ['apply', join(parent, 'codemods.patch')]);
    }
    const result = await options.agent({
      ...options.input,
      repoDir: directory,
      provider: 'shopify',
    });
    await git(directory, ['add', '-A']);
    const changes = (
      await git(directory, ['diff', '--cached', '--name-status', '-z', 'HEAD'])
    ).stdout
      .split('\0')
      .filter(Boolean);
    const before: { path: string; content: string }[] = [];
    const edits: SourceEdit[] = [];
    // shortcut: deleted and renamed files are left out of the patch; add them if the agent needs them.
    for (let index = 0; index + 1 < changes.length; index += 2) {
      const [status, path] = [changes[index], changes[index + 1]];
      if (status !== 'M' && status !== 'A') continue;
      const original =
        status === 'M' ? (await git(directory, ['show', `HEAD:${path}`])).stdout : '';
      const content = await readFile(join(directory, path), 'utf8');
      if (status === 'M') before.push({ path, content: original });
      edits.push({
        file: path,
        start: 0,
        end: original.length,
        replacement: content,
        changeId: 'shopify-agent',
      });
    }
    const diff = renderPatch({ ...options.repository, files: before }, edits);
    const handOff: ShopifyHandOff = {
      ...result,
      outcome: diff ? result.outcome : 'no-change',
      diff,
      files: edits.map((edit) => edit.file),
    };
    // A failed attempt (an error, the budget) may succeed on a later run.
    if (cache && cached && handOff.outcome !== 'failed') {
      await mkdir(cache, { recursive: true });
      await writeFile(cached, JSON.stringify(handOff));
    }
    return handOff;
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
