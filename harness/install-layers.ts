// Reuses node_modules across sandboxes, so setup doesn't dominate the time. A layer is saved right
// after a scripts-off install, before any check or codegen runs, and its key covers every file that
// can steer that install (a pnpmfile or Yarn plugin is repo code that runs at install time). So a
// layer is a function of its key: a repo can only ever poison a layer it alone would hit, and the
// owner in the key keeps customers apart whatever they share.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PackageManager } from './checks.ts';
import type { ExecResult, Sandbox } from './types.ts';

const exec = promisify(execFile);

export const LAYERS_DIR = path.join(tmpdir(), 'aptitude-install-layers');
const KEPT_LAYERS = 40;
const SKIP = new Set(['node_modules', '.git', '.pnpm-store']);
const STEERS_INSTALL = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  'yarn.lock',
  '.yarnrc',
  '.yarnrc.yml',
  '.npmrc',
]);

// Files that steer the install, by path, in a stable order. Everything under .yarn counts: Yarn 2+
// runs the release and plugins checked in there.
async function steeringFiles(root: string, dir = root, inYarn = false): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name))
        found.push(...(await steeringFiles(root, full, inYarn || entry.name === '.yarn')));
    } else if (entry.isFile() && (inYarn || STEERS_INSTALL.has(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

export async function layerKey(
  dir: string,
  scope: string,
  pm: PackageManager,
  version: string | undefined,
  image: string,
): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify([scope, pm, version ?? '', image]));
  for (const file of await steeringFiles(dir)) {
    hash
      .update(path.relative(dir, file))
      .update('\0')
      .update(await readFile(file));
  }
  return hash.digest('hex').slice(0, 32);
}

// Copy-on-write where the disk has it, so a restore is a fraction of an install. -P keeps symlinks
// as links, so nothing is read or written through one.
const copyArgs = process.platform === 'darwin' ? ['-cRP'] : ['-a', '--reflink=auto'];
const copy = (from: string, to: string) => exec('cp', [...copyArgs, from, to]);

async function nodeModulesDirs(root: string, dir = root, depth = 0): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules') found.push(path.relative(root, full));
    else if (depth < 5 && !SKIP.has(entry.name))
      found.push(...(await nodeModulesDirs(root, full, depth + 1)));
  }
  return found;
}

async function restore(layer: string, dir: string): Promise<void> {
  const parts = JSON.parse(await readFile(path.join(layer, 'parts.json'), 'utf8')) as string[];
  await Promise.all(
    parts.map(async (part, index) => {
      await mkdir(path.dirname(path.join(dir, part)), { recursive: true });
      await copy(path.join(layer, String(index)), path.join(dir, part));
    }),
  );
  await utimes(layer, new Date(), new Date());
}

async function save(layer: string, dir: string, root: string): Promise<boolean> {
  const parts = await nodeModulesDirs(dir);
  if (parts.length === 0) return false;
  await mkdir(root, { recursive: true });
  const building = `${layer}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(building);
  await Promise.all(
    parts.map((part, index) => copy(path.join(dir, part), path.join(building, String(index)))),
  );
  await writeFile(path.join(building, 'parts.json'), JSON.stringify(parts));
  await rename(building, layer).catch(() => rm(building, { recursive: true, force: true }));
  await prune(root);
  return true;
}

// shortcut: keeps the newest layers by count, not by bytes; cap by disk use if layers grow past this.
async function prune(root: string): Promise<void> {
  const names = (await readdir(root)).filter((name) => !name.endsWith('.tmp'));
  const dated = await Promise.all(
    names.map(async (name) => ({
      name,
      at: (await stat(path.join(root, name))).mtimeMs,
    })),
  );
  const old = dated.sort((a, b) => b.at - a.at).slice(KEPT_LAYERS);
  await Promise.all(
    old.map(({ name }) => rm(path.join(root, name), { recursive: true, force: true })),
  );
}

export type LayerUse = 'restored' | 'saved' | 'none';

// Runs the install, or restores what an identical install left. Bun's binary comes with its install
// command, and pip installs outside the working copy, so neither has a layer. A layer that can't be
// read or written only costs the install.
export async function installWithLayer(
  sandbox: Pick<Sandbox, 'dir' | 'exec' | 'mode'> & { image?: string },
  options: {
    pm: PackageManager;
    version?: string;
    command: string;
    scope: string;
    root?: string;
  },
): Promise<ExecResult & { layer: LayerUse }> {
  const { pm, version, command, scope, root = LAYERS_DIR } = options;
  if (!['npm', 'pnpm', 'yarn'].includes(pm) || !scope) {
    return { ...(await sandbox.exec(command)), layer: 'none' };
  }
  const key = await layerKey(sandbox.dir, scope, pm, version, sandbox.image ?? sandbox.mode).catch(
    () => undefined,
  );
  const layer = key && path.join(root, key);
  if (layer) {
    const ready = await lstat(path.join(layer, 'parts.json')).catch(() => undefined);
    if (ready) {
      try {
        await restore(layer, sandbox.dir);
        return {
          code: 0,
          stdout: 'restored from an install layer',
          stderr: '',
          timedOut: false,
          layer: 'restored',
        };
      } catch {
        await rm(path.join(sandbox.dir, 'node_modules'), { recursive: true, force: true });
      }
    }
  }
  const result = await sandbox.exec(command);
  if (!layer || result.code !== 0) return { ...result, layer: 'none' };
  try {
    return { ...result, layer: (await save(layer, sandbox.dir, root)) ? 'saved' : 'none' };
  } catch {
    return { ...result, layer: 'none' };
  }
}
