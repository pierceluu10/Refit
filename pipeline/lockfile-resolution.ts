import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  dockerSandboxArguments,
  preparationProfile,
  removeDockerContainer,
  removeExpiredSandboxContainers,
} from './docker-sandbox.ts';
import { readCommittedFile, type readCommittedRepository } from './committed-repository.ts';
import { legacyPeerDeps } from './dependency-inputs.ts';
import {
  dependencySources,
  isRegistrySource,
  MAX_LOCK_BYTES,
  MAX_PACKAGE_BYTES,
} from './npm-lock.ts';
import { DEFAULT_PNPM_10_VERSION, PNPM_WORKSPACE } from './pnpm-inputs.ts';
import { PNPM_LOCKFILE } from './pnpm-lock.ts';
import { isObject, parseJson } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// Founders' decision (2026-10-27): a networked lockfile-resolution step may run before, and
// separate from, the offline validation. It writes a lockfile for validation only; the lockfile
// never reaches the patch. npm resolves as of an absolute date (`--before`). pnpm has only a
// relative minimumReleaseAge, so Refit turns the date into an age in minutes when it starts.

const execute = promisify(execFile);
const RESOLUTION_TIMEOUT_MS = 300_000;
const MAX_LATE_PINS = 8;
// minimumReleaseAge needs pnpm 10.16 or later; pnpm 9 and 10 both write lockfile v9.
const PNPM_RESOLUTION_VERSION = DEFAULT_PNPM_10_VERSION;
// The preparation refusals a resolved lockfile can replace (dependency-preparation.ts and the
// non-registry-dependency stop in preparation-stops.ts).
export const RESOLVABLE_REFUSALS = new Set([
  'no-lockfile',
  'lockfile-out-of-sync',
  'lockfile-integrity',
  'peer-dependency-conflict',
  'non-registry-dependency',
]);

// The package managers a re-resolution can run, with the lockfile each writes. The Shopify SDK
// upgrade (shopify-sdk-upgrade.ts) runs each with the project's own release.
export type ResolutionManager = 'npm' | 'pnpm' | 'yarn' | 'yarn-berry' | 'bun';
export const RESOLUTION_LOCKFILES: Record<ResolutionManager, string> = {
  npm: 'package-lock.json',
  pnpm: PNPM_LOCKFILE,
  yarn: 'yarn.lock',
  'yarn-berry': 'yarn.lock',
  bun: 'bun.lock',
};

export class LockfileResolutionError extends PipelineInputError {
  override name = 'LockfileResolutionError';
  constructor(
    message: string,
    readonly result?: { code: number | null; signal: NodeJS.Signals | null; stderr: string },
  ) {
    super(message);
  }
}

// Off by default until the benchmark evidence is recorded; `on` enables resolution and the
// types-only peer bump that uses it.
export function lockfileResolutionEnabled(value = process.env.REFIT_LOCKFILE_RESOLUTION) {
  const mode = value?.trim() || 'on';
  if (mode !== 'on' && mode !== 'off')
    throw new PipelineInputError('REFIT_LOCKFILE_RESOLUTION must be on or off.');
  return mode === 'on';
}

// Runs in the container with only package.json (and a seed lockfile) in its workspace: no
// repository .npmrc, scripts or code. A declaration the manager cannot satisfy as of the cutoff
// because its lowest version is newer (the stripe release a patch pins, a raised peer) is left out
// of a first pass and added back in a second, seeded with the first pass's lockfile and cut off at
// its publication time, so only those packages and what they newly need resolve later than the
// cutoff. npm's peer conflict (ERESOLVE) is retried once with --legacy-peer-deps and recorded.
export const RESOLVE_SCRIPT = `
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [cutoff, legacyFlag, manager, managerVersion, tarballs, extraArguments] = process.argv.slice(1);
const extra = JSON.parse(extraArguments ?? "[]");
const lockfile = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", "yarn-berry": "yarn.lock", bun: "bun.lock" }[manager] ?? "package-lock.json";
const text = readFileSync("package.json", "utf8");
const manifest = JSON.parse(text);
const sections = ["dependencies", "devDependencies", "optionalDependencies"];
writeFileSync("/tmp/refit-user.npmrc", "");
writeFileSync("/tmp/refit-global.npmrc", "");
const env = { ...process.env, npm_config_userconfig: "/tmp/refit-user.npmrc", npm_config_globalconfig: "/tmp/refit-global.npmrc", npm_config_update_notifier: "false", npm_config_manage_package_manager_versions: "false", pnpm_config_pm_on_fail: "ignore", COREPACK_ENABLE_NETWORK: "0", CI: "true", PNPM_HOME: "/workspace/.pnpm-home", XDG_CACHE_HOME: "/workspace/.cache", XDG_STATE_HOME: "/workspace/.state", XDG_DATA_HOME: "/workspace/.data", YARN_ENABLE_SCRIPTS: "false", YARN_ENABLE_TELEMETRY: "false", YARN_ENABLE_IMMUTABLE_INSTALLS: "false", YARN_ENABLE_GLOBAL_CACHE: "false", YARN_IGNORE_PATH: "true", YARN_CACHE_FOLDER: "/workspace/.yarn-cache", YARN_NODE_LINKER: "node-modules", YARN_NPM_REGISTRY_SERVER: "https://registry.yarnpkg.com", BUN_INSTALL_CACHE_DIR: "/workspace/.bun-cache" };
const tools = "/workspace/.refit-tools/node_modules/";
// Bun's own binary for the container's platform (the image is Alpine, so musl).
const bunPackage = "@oven/bun-linux-" + (process.arch === "arm64" ? "aarch64" : "x64") + "-musl";
const run = (command, args) => {
  const result = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  process.stderr.write(result.stdout + result.stderr);
  return { status: result.status, output: result.stdout + result.stderr };
};
// An anonymous request for a private repository's archive fails, so only public ones are fetched.
for (const url of JSON.parse(tarballs)) {
  const response = await fetch(url, { redirect: "error" });
  await response.body?.cancel();
  if (!response.ok) {
    process.stderr.write("GitHub returned HTTP " + response.status + " for " + url + "; Refit fetches only public GitHub repositories.\\n");
    process.exit(1);
  }
}
const tool = { pnpm: "pnpm", yarn: "yarn", "yarn-berry": "@yarnpkg/cli-dist", bun: bunPackage }[manager];
if (tool && run("npm", ["install", "--prefix", "/workspace/.refit-tools", "--cache=/workspace/.npm-cache", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", tool + "@" + managerVersion]).status !== 0) process.exit(1);
let legacy = legacyFlag === "1";
function resolve(before) {
  if (manager === "pnpm") {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(before)) / 60000));
    return run(tools + ".bin/pnpm", ["install", "--lockfile-only", "--no-frozen-lockfile", "--ignore-scripts", "--config.ignore-pnpmfile=true", "--store-dir=/workspace/.pnpm-store", "--registry=https://registry.npmjs.org/", ...(minutes ? ["--config.minimum-release-age=" + minutes] : []), ...extra]);
  }
  // Yarn 1 has no lockfile-only mode; it installs with scripts off into a folder nothing reads.
  if (manager === "yarn") return run(tools + ".bin/yarn", ["install", "--ignore-scripts", "--ignore-engines", "--non-interactive", "--no-progress", "--registry", "https://registry.yarnpkg.com", "--cache-folder", "/workspace/.yarn-cache", "--modules-folder", "/workspace/.refit-modules", ...extra]);
  if (manager === "yarn-berry") return run("node", [tools + "@yarnpkg/cli-dist/bin/yarn.js", "install", "--mode=update-lockfile", ...extra]);
  if (manager === "bun") return run(tools + bunPackage + "/bin/bun", ["install", "--lockfile-only", "--ignore-scripts", "--no-progress", "--registry=https://registry.npmjs.org/", ...extra]);
  const result = run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", "--cache=/workspace/.npm-cache", "--before=" + before, ...(legacy ? ["--legacy-peer-deps"] : [])]);
  if (result.status === 0 || legacy || !/^npm (?:ERR!|error) code ERESOLVE$/m.test(result.output)) return result;
  legacy = true;
  return resolve(before);
}
const tooNew = manager === "pnpm"
  ? /ERR_PNPM_NO_MATURE_MATCHING_VERSION\\s+Version \\S+ \\([^)]*\\) of (@?[^\\s@]+) does not meet/
  : manager === "npm" ? /No matching version found for (@?[^@\\s]+)@(\\S+?) with a date before/ : /(?!)/;
async function published(name, version) {
  const response = await fetch("https://registry.npmjs.org/" + name.replace("/", "%2f"), { headers: { accept: "application/json" }, redirect: "error" });
  if (!response.ok) throw new Error("The npm registry returned HTTP " + response.status + " for " + name + ".");
  const time = (await response.json()).time?.[version];
  if (typeof time !== "string") throw new Error("The npm registry records no publication time for " + name + " " + version + ".");
  return time;
}
const late = {};
for (let pass = 0; ; pass++) {
  const result = resolve(cutoff);
  if (result.status === 0) break;
  const target = tooNew.exec(result.output);
  const section = target && sections.find((key) => manifest[key]?.[target[1]] !== undefined && (target[2] === undefined || manifest[key][target[1]] === target[2]));
  const spec = section && manifest[section][target[1]];
  const minimum = typeof spec === "string" && /^[~^]?(\\d+\\.\\d+\\.\\d+)$/.exec(spec)?.[1];
  if (!minimum || pass >= ${MAX_LATE_PINS}) process.exit(result.status ?? 1);
  const time = await published(target[1], minimum);
  if (Date.parse(time) <= Date.parse(cutoff)) process.exit(result.status ?? 1);
  late[target[1]] = { section, spec, published: time };
  delete manifest[section][target[1]];
  writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\\n");
}
if (Object.keys(late).length) {
  writeFileSync("package.json", text);
  const before = Object.values(late).map((entry) => entry.published).sort().at(-1);
  if (resolve(before).status !== 0) process.exit(1);
}
process.stdout.write(JSON.stringify({ lockfile: readFileSync(lockfile, "utf8"), late, legacyPeerDeps: legacy }));
`;

export interface ResolvedLockfile {
  lockfile: string;
  // When Refit resolved it: the repository's last commit date, and any pins resolved later.
  before: string;
  late: Record<string, { spec: string; published: string }>;
  // npm rejected the peer dependencies, so the lockfile was resolved with --legacy-peer-deps.
  legacyPeerDeps?: boolean;
}

// Resolves package-lock.json (or pnpm-lock.yaml) for a root project in its own networked
// container, as of `before`. `seed` is the committed lockfile the manager starts from, so versions
// it locks that still satisfy package.json are kept. `tarballs` are public GitHub archives the
// manifest declares (githubSources). Every resolved package is then checked by the ordinary
// preparation.
export async function resolveNpmLockfile(options: {
  manifest: string;
  seed?: string;
  before: string;
  legacyPeerDeps?: boolean;
  manager?: ResolutionManager;
  // The release of the manager to run; pnpm defaults to PNPM_RESOLUTION_VERSION.
  managerVersion?: string;
  // Further arguments to the manager's install (lockfile settings to keep).
  managerArguments?: string[];
  // pnpm-workspace.yaml, which names pnpm's workspaces and catalogs.
  pnpmWorkspace?: string;
  tarballs?: string[];
  // npm workspaces' package.json files, at their paths: a project with workspaces resolves only
  // with them (the Shopify app template's `extensions/*`).
  workspaces?: { path: string; content: string }[];
  image: string;
  signal?: AbortSignal;
}): Promise<ResolvedLockfile> {
  const manager = options.manager ?? 'npm';
  if (Number.isNaN(Date.parse(options.before)))
    throw new PipelineInputError(`Lockfile resolution needs a date; ${options.before} is not one.`);
  const manifest = parseJson(options.manifest);
  if (!isObject(manifest)) throw new PipelineInputError('package.json is not an object.');
  if (
    (manager === 'npm' || manager === 'yarn' || manager === 'yarn-berry' || manager === 'bun') &&
    manifest.workspaces !== undefined &&
    !options.workspaces
  )
    throw new PipelineInputError('Refit resolves lockfiles only for projects without workspaces.');
  for (const workspace of options.workspaces ?? [])
    if (
      !/^(?:[\w@.-]+\/)*package\.json$/.test(workspace.path) ||
      workspace.path.split('/').includes('..')
    )
      throw new PipelineInputError(
        `Workspace manifest path ${workspace.path} is not a relative package.json.`,
      );
  const input = await mkdtemp(join(tmpdir(), 'refit-lock-input-'));
  const name = `refit-lockfile-${randomUUID()}`;
  try {
    await chmod(input, 0o755);
    await writeFile(join(input, 'package.json'), options.manifest, { mode: 0o644 });
    for (const workspace of options.workspaces ?? []) {
      await mkdir(join(input, workspace.path, '..'), { recursive: true, mode: 0o755 });
      await writeFile(join(input, workspace.path), workspace.content, { mode: 0o644 });
    }
    if (options.pnpmWorkspace !== undefined)
      await writeFile(join(input, PNPM_WORKSPACE), options.pnpmWorkspace, { mode: 0o644 });
    if (options.seed !== undefined)
      await writeFile(join(input, RESOLUTION_LOCKFILES[manager]), options.seed, { mode: 0o644 });
    await removeExpiredSandboxContainers();
    const argumentsList = dockerSandboxArguments({
      name,
      directory: input,
      image: options.image,
      command: [
        'node',
        '--input-type=module',
        '-e',
        RESOLVE_SCRIPT,
        new Date(options.before).toISOString(),
        options.legacyPeerDeps ? '1' : '0',
        manager,
        options.managerVersion ?? PNPM_RESOLUTION_VERSION,
        JSON.stringify(options.tarballs ?? []),
        JSON.stringify(options.managerArguments ?? []),
      ],
      network: 'bridge',
      timeoutMs: RESOLUTION_TIMEOUT_MS,
      preparation: preparationProfile(),
    });
    let stdout: string;
    try {
      ({ stdout } = await execute('docker', argumentsList, {
        maxBuffer: 2 * MAX_LOCK_BYTES,
        timeout: RESOLUTION_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        signal: options.signal,
      }));
    } catch (error) {
      options.signal?.throwIfAborted();
      const failed = error as { code?: unknown; signal?: NodeJS.Signals; stderr?: string };
      const stderr = String(failed.stderr ?? '');
      throw new LockfileResolutionError(
        `${manager} could not resolve a lockfile as of ${options.before} (${failed.code ?? failed.signal}). ${stderr.slice(-2048)}`,
        {
          code: typeof failed.code === 'number' ? failed.code : null,
          signal: failed.signal ?? null,
          stderr,
        },
      );
    }
    const output = parseJson(stdout);
    if (!isObject(output) || typeof output.lockfile !== 'string' || !isObject(output.late))
      throw new LockfileResolutionError('Lockfile resolution did not produce a lockfile.');
    return {
      lockfile:
        options.seed === undefined || manager !== 'npm'
          ? output.lockfile
          : keepSeedNames(options.seed, output.lockfile),
      before: options.before,
      late: output.late as ResolvedLockfile['late'],
      legacyPeerDeps: output.legacyPeerDeps === true,
    };
  } finally {
    const cleanup = await Promise.allSettled([
      removeDockerContainer(name),
      rm(input, { recursive: true, force: true }),
    ]);
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }
}

// A GitHub declaration npm would install with git: `github:o/r`, `o/r` or a git or https URL on
// github.com, with an optional `#ref`. The image has no git, so Refit fetches the repository's
// archive at a pinned commit or tag instead.
const GITHUB_SOURCE =
  /^(?:github:|git\+https:\/\/github\.com\/|git\+ssh:\/\/git@github\.com[:/]|git:\/\/github\.com\/|https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.+))?$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const TAG = /^v?\d+\.\d+\.\d+[\w.+-]*$/;

// The manifest with each GitHub declaration replaced by its public archive at a pinned commit or
// tag, for validation only. The commit comes from the committed lockfile's record, else from the
// declaration's own `#<commit>` or `#<version tag>`. Any other non-registry declaration (a branch,
// an unpinned repository, another host, a local path) keeps its named stop.
export function githubSources(manifest: Record<string, unknown>, seed?: string) {
  const lock = seed === undefined ? undefined : parseJson(seed);
  const records = isObject(lock) && isObject(lock.packages) ? lock.packages : {};
  const rewritten = structuredClone(manifest);
  const sources: Record<string, { source: string; tarball: string }> = {};
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = rewritten[section];
    if (!isObject(dependencies)) continue;
    for (const [name, source] of Object.entries(dependencies)) {
      if (isRegistrySource(source)) continue;
      const match = typeof source === 'string' ? GITHUB_SOURCE.exec(source) : null;
      const record = records[`node_modules/${name}`];
      const locked =
        match && isObject(record) && typeof record.resolved === 'string'
          ? /^git\+(?:ssh:\/\/git@|https:\/\/)github\.com\/([\w.-]+?)\/([\w.-]+?)(?:\.git)?#([0-9a-f]{40})$/i.exec(
              record.resolved,
            )
          : null;
      const ref =
        locked &&
        locked[1].toLowerCase() === match![1].toLowerCase() &&
        locked[2].toLowerCase() === match![2].toLowerCase()
          ? locked[3]
          : match?.[3] && (COMMIT.test(match[3]) || TAG.test(match[3]))
            ? match[3]
            : undefined;
      if (!match || !ref) {
        dependencySources({ [section]: { [name]: source } }, 'package.json');
        continue;
      }
      const tarball = `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${ref}`;
      dependencies[name] = tarball;
      sources[name] = { source: source as string, tarball };
    }
  }
  return { manifest: rewritten, sources };
}

// Only the .npmrc settings that change resolution are read; the file never reaches the manager. A
// registry for a scope the manifest never declares cannot change what resolves.
export function npmrcRefusal(npmrc: string, manifest: Record<string, unknown>) {
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap((section) => (isObject(manifest[section]) ? Object.entries(manifest[section]) : []))
    .flatMap(([name, source]) => [
      name,
      ...(typeof source === 'string' && source.startsWith('npm:') ? [source.slice(4)] : []),
    ]);
  const refused = npmrc.split(/\r?\n/).some((line) => {
    if (/_auth/.test(line)) return true;
    const registry = /^\s*(@[^:\s]+:)?registry\s*=/.exec(line);
    if (!registry) return false;
    const scope = registry[1]?.slice(0, -1);
    return !scope || declared.some((name) => name.startsWith(`${scope}/`));
  });
  return refused
    ? 'Automatic preparation supports public npm registry dependencies only; .npmrc configures another registry or registry credentials. Private registry dependencies require a custom image.'
    : undefined;
}

type Snapshot = Awaited<ReturnType<typeof readCommittedRepository>>;
const ROOT_LOCKFILES = [
  'package-lock.json',
  PNPM_LOCKFILE,
  'yarn.lock',
  'bun.lock',
  'npm-shrinkwrap.json',
];

// The committed snapshot with a resolved lockfile in place of the refused or missing one, for a
// root npm or pnpm project whose preparation refused for `reason`; undefined when resolution does
// not apply. A pnpm project commits pnpm-lock.yaml or, with none, pins pnpm in packageManager.
// Binary bun.lockb is not read: preparation cannot read it. An out-of-sync lockfile, one npm's
// peer checks reject or one beside a GitHub dependency seeds the resolution; one without integrity
// does not, because its versions cannot be verified. `before` defaults to the snapshot's own
// commit date.
export async function resolvedLockfileSnapshot(
  snapshot: Snapshot,
  reason: string,
  options: {
    image: string;
    before?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  },
) {
  const paths = snapshot.entries.map((entry) => entry.slice(entry.indexOf('\t') + 1));
  if (
    !RESOLVABLE_REFUSALS.has(reason) ||
    !lockfileResolutionEnabled() ||
    !paths.includes('package.json')
  )
    return undefined;
  const manifest = await readCommittedFile(snapshot, 'package.json', MAX_PACKAGE_BYTES);
  const parsed = parseJson(manifest);
  if (!isObject(parsed)) throw new PipelineInputError('package.json is not an object.');
  const manager =
    paths.includes(PNPM_LOCKFILE) ||
    (!paths.includes('package-lock.json') &&
      typeof parsed.packageManager === 'string' &&
      parsed.packageManager.startsWith('pnpm@'))
      ? 'pnpm'
      : 'npm';
  const lockfile = manager === 'pnpm' ? PNPM_LOCKFILE : 'package-lock.json';
  if (
    ROOT_LOCKFILES.some((file) => file !== lockfile && paths.includes(file)) ||
    // pnpm reads workspaces, settings and patches from files the resolution does not receive.
    (manager === 'pnpm' &&
      (paths.includes(PNPM_WORKSPACE) ||
        (isObject(parsed.pnpm) && parsed.pnpm.patchedDependencies !== undefined)))
  )
    return undefined;
  const seed =
    reason !== 'no-lockfile' && reason !== 'lockfile-integrity' && paths.includes(lockfile)
      ? await readCommittedFile(snapshot, lockfile, MAX_LOCK_BYTES)
      : undefined;
  // Local, URL and other Git dependencies keep their named stop (non-registry-dependency); when
  // that is the refusal itself, resolution does not apply and the refusal stands alone.
  let github;
  try {
    github =
      manager === 'npm'
        ? githubSources(parsed, seed)
        : (dependencySources(parsed, 'package.json'), undefined);
  } catch (error) {
    if (reason === 'non-registry-dependency' && error instanceof PipelineInputError)
      return undefined;
    throw error;
  }
  const npmrc = paths.includes('.npmrc')
    ? await readCommittedFile(snapshot, '.npmrc', MAX_PACKAGE_BYTES)
    : '';
  const refusal = npmrcRefusal(npmrc, parsed);
  if (refusal) throw new PipelineInputError(refusal);
  const before = new Date(
    options.before ??
      (await snapshot.git(['show', '-s', '--format=%cI', snapshot.revision])).stdout.trim(),
  ).toISOString();
  const sources = github?.sources ?? {};
  const tarballs = Object.values(sources).map((entry) => entry.tarball);
  const resolvedManifest = tarballs.length
    ? JSON.stringify(github!.manifest, null, 2) + '\n'
    : manifest;
  options.onProgress?.(
    `Resolving ${lockfile} as of ${before} in networked Docker, for validation only; lifecycle scripts are disabled...`,
  );
  const resolved = await resolveNpmLockfile({
    manifest: resolvedManifest,
    seed,
    before,
    legacyPeerDeps: legacyPeerDeps(npmrc),
    manager,
    tarballs,
    image: options.image,
    signal: options.signal,
  });
  return {
    snapshot: {
      ...snapshot,
      entries: [
        ...snapshot.entries.filter((entry) => !entry.endsWith(`\t${lockfile}`)),
        `100644 blob 0000000000000000000000000000000000000000\t${lockfile}`,
      ],
      replaced: new Map([
        [lockfile, tarballs.length ? onRegistryHost(resolved.lockfile) : resolved.lockfile],
        ...(tarballs.length ? [['package.json', resolvedManifest] as const] : []),
      ]),
      tarballs: new Set(tarballs),
    },
    record: {
      reason,
      before,
      ...(Object.keys(resolved.late).length ? { late: resolved.late } : {}),
      ...(manager === 'pnpm' ? { manager: 'pnpm' as const } : {}),
      ...(resolved.legacyPeerDeps && !legacyPeerDeps(npmrc)
        ? { legacyPeerDeps: true as const }
        : {}),
      ...(tarballs.length ? { github: sources } : {}),
    },
  };
}

// npm ci normally rewrites every locked tarball's host to registry.npmjs.org
// (--replace-registry-host=always), which would also rewrite a GitHub archive. With archives it
// installs without that flag, so mirror URLs a seed kept are moved to the registry here instead:
// the same paths, checked against the same integrity.
export function onRegistryHost(lockfile: string) {
  const lock = parseJson(lockfile);
  if (!isObject(lock) || !isObject(lock.packages)) return lockfile;
  for (const record of Object.values(lock.packages))
    if (isObject(record) && typeof record.resolved === 'string')
      record.resolved = record.resolved.replace(
        /^https:\/\/registry\.(?:npmmirror\.com|yarnpkg\.com)\//,
        'https://registry.npmjs.org/',
      );
  return JSON.stringify(lock, null, 2) + '\n';
}

// The package name an npm lockfile key installs (`node_modules/a/node_modules/@b/c` is `@b/c`).
const packageName = (key: string) => key.slice(key.lastIndexOf('node_modules/') + 13);

// Lockfile keys Node reaches from the root without passing through `skip`, resolving each
// dependency to the nearest node_modules directory up the tree, as Node does.
export function reachedWithout(packages: Record<string, unknown>, skip: Set<string>) {
  const seen = new Set<string>(['']);
  const pending = [''];
  while (pending.length) {
    const key = pending.pop()!;
    const entry = packages[key];
    if (!isObject(entry)) continue;
    const names = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
      .filter((section) => section !== 'devDependencies' || key === '')
      .flatMap((section) => (isObject(entry[section]) ? Object.keys(entry[section]) : []));
    for (const name of names) {
      if (skip.has(name)) continue;
      for (
        let base = key;
        ;
        base = base.slice(0, Math.max(0, base.lastIndexOf('/node_modules/')))
      ) {
        const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
        if (packages[candidate] !== undefined) {
          if (!seen.has(candidate)) {
            seen.add(candidate);
            pending.push(candidate);
          }
          break;
        }
        if (!base) break;
      }
    }
  }
  return seen;
}

// npm names a lockfile after the directory it resolved in when package.json has no name; keep the
// names the committed lockfile records, in npm's own layout, so the shipped lockfile renames nothing.
export function keepSeedNames(seed: string, lockfile: string) {
  const [old, lock] = [parseJson(seed), parseJson(lockfile)];
  if (!isObject(old) || !isObject(lock) || !isObject(lock.packages)) return lockfile;
  const root = isObject(lock.packages['']) ? lock.packages[''] : undefined;
  const oldRoot = isObject(old.packages) && isObject(old.packages['']) ? old.packages[''] : {};
  if (lock.name === old.name && (!root || root.name === oldRoot.name)) return lockfile;
  const named = (entry: Record<string, unknown>, name: unknown) => {
    const { name: _, ...rest } = entry;
    return name === undefined ? rest : { name, ...rest };
  };
  const kept = {
    ...named(lock, old.name),
    packages: root ? { ...lock.packages, '': named(root, oldRoot.name) } : lock.packages,
  };
  const indent = /^\{\r?\n([ \t]+)"/.exec(lockfile)?.[1] ?? '  ';
  const eol = lockfile.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(kept, null, indent).replace(/\n/g, eol) + eol;
}

// The lockfile keys that change between two npm lockfiles outside `names` and the packages only
// they reach; empty when the change stays inside them.
export function changesOutside(before: string, after: string, names: string[]) {
  const packages = (text: string) => {
    const lock = parseJson(text);
    return isObject(lock) && isObject(lock.packages) ? lock.packages : {};
  };
  const [old, changed] = [packages(before), packages(after)];
  const skip = new Set(names);
  const shared = new Set([...reachedWithout(old, skip), ...reachedWithout(changed, skip)]);
  // The root record's own declarations of `names` are the upgrade itself.
  const root = (entry: unknown) =>
    JSON.stringify(
      isObject(entry)
        ? Object.fromEntries(
            Object.entries(entry).map(([key, value]) => [
              key,
              isObject(value)
                ? Object.fromEntries(Object.entries(value).filter(([name]) => !skip.has(name)))
                : value,
            ]),
          )
        : entry,
    );
  return [...new Set([...Object.keys(old), ...Object.keys(changed)])].filter((key) => {
    if (key === '') return root(old[key]) !== root(changed[key]);
    if (JSON.stringify(old[key]) === JSON.stringify(changed[key])) return false;
    return !skip.has(packageName(key)) && shared.has(key);
  });
}
