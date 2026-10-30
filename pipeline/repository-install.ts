// The repository's own install, derived from what it commits (founder decision, 2026-10-28; see
// docs/CUSTOMER-ENVIRONMENT.md). Sources are tried in order: a root Dockerfile or devcontainer,
// then a CI workflow's install step, then the lockfile's manager. Only a recognised install
// command is ever run; every other step a source names is listed as skipped. Pure: the build
// sandbox in repository-environment.ts runs the plan.

import { parse } from 'yaml';
import { isObject } from './specifications.ts';

export type InstallManager = 'npm' | 'pnpm' | 'yarn';
export interface InstallPlan {
  source: 'dockerfile' | 'devcontainer' | 'ci' | 'lockfile';
  file: string;
  manager: InstallManager;
  command: string[];
  // The package-manager tool installed first (npm ships with the image), e.g. "pnpm@9.15.9".
  tool?: string;
  // Steps the source names beside the install, which Refit does not run.
  skipped: string[];
}

// The files a plan and its egress allowlist are read from.
export const INSTALL_FILES =
  /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|\.npmrc|\.yarnrc|\.yarnrc\.yml|Dockerfile|\.devcontainer\.json|\.devcontainer\/devcontainer\.json|\.github\/workflows\/[^/]+\.ya?ml)$/;

// Flags that keep an install an install: no package arguments, development dependencies kept
// (the checks need them), no filtering. `--omit`, `--production` and `--filter` are refused.
const FLAGS: Record<InstallManager, RegExp> = {
  npm: /^--(?:legacy-peer-deps|no-audit|no-fund|prefer-offline|ignore-scripts|foreground-scripts|no-optional|workspaces|include-workspace-root|include=(?:dev|optional|peer)|loglevel=\w+|no-progress|progress=false|audit=false|fund=false)$/,
  pnpm: /^--(?:frozen-lockfile|no-frozen-lockfile|prefer-offline|ignore-scripts|shamefully-hoist|strict-peer-dependencies|reporter=[\w-]+|silent)$/,
  yarn: /^--(?:frozen-lockfile|immutable|non-interactive|prefer-offline|ignore-engines|check-files|inline-builds|ignore-scripts|silent|network-timeout=?\d*|mode=[\w-]+)$|^\d+$/,
};

// One shell segment as an install command, or undefined when it is anything else.
export function installCommand(
  segment: string,
): { manager: InstallManager; command: string[] } | undefined {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  const [manager, verb, ...flags] = words;
  if (manager !== 'npm' && manager !== 'pnpm' && manager !== 'yarn') return undefined;
  const verbs =
    manager === 'npm'
      ? ['ci', 'install', 'i']
      : manager === 'pnpm'
        ? ['install', 'i']
        : ['install', undefined];
  if (!verbs.includes(verb)) {
    // `yarn --frozen-lockfile` is Yarn's install too.
    if (manager !== 'yarn' || !verb?.startsWith('--')) return undefined;
    flags.unshift(verb);
  }
  if (!flags.every((flag) => FLAGS[manager].test(flag))) return undefined;
  return { manager, command: frozen(manager, flags) };
}

// The install in its frozen form, so only the committed lockfile's versions are installed and
// graded: `npm install` runs as `npm ci`, and pnpm and Yarn always get a frozen lockfile.
function frozen(manager: InstallManager, flags: string[]) {
  if (manager === 'npm') return ['npm', 'ci', ...flags];
  const kept = flags.filter((flag) => flag !== '--no-frozen-lockfile');
  const locked = kept.includes('--frozen-lockfile') || kept.includes('--immutable');
  return [manager, 'install', ...kept, ...(locked ? [] : ['--frozen-lockfile'])];
}

// Splits a shell script into its commands. Anything with substitution or redirection stays one
// unrecognised segment.
function segments(script: string) {
  return script
    .replace(/\\\n/g, ' ')
    .split(/&&|;|\n|\|\|/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function fromScript(source: InstallPlan['source'], file: string, script: string) {
  const parts = segments(script);
  const found = parts.map(installCommand);
  const index = found.findIndex(Boolean);
  if (index < 0) return undefined;
  return {
    source,
    file,
    ...found[index]!,
    skipped: parts.filter((_, other) => other !== index),
  };
}

function dockerfile(content: string) {
  const runs = content
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => /^\s*RUN\s+(?:--\S+\s+)*(.*)$/i.exec(line)?.[1])
    .filter((line): line is string => Boolean(line) && !line!.trim().startsWith('['));
  return runs.join('\n');
}

function devcontainer(content: string) {
  let value: unknown;
  try {
    // shortcut: strips whole-line // comments only; a comment after a value fails the parse and
    // the devcontainer is skipped.
    value = JSON.parse(content.replace(/^\s*\/\/.*$/gm, ''));
  } catch {
    return '';
  }
  if (!isObject(value)) return '';
  const commands = ['onCreateCommand', 'updateContentCommand', 'postCreateCommand'].map(
    (key) => value[key],
  );
  return commands
    .flatMap((command) =>
      typeof command === 'string'
        ? [command]
        : Array.isArray(command)
          ? [command.join(' ')]
          : isObject(command)
            ? Object.values(command).map((entry) =>
                Array.isArray(entry) ? entry.join(' ') : String(entry),
              )
            : [],
    )
    .join('\n');
}

// Every `run:` of every job, for steps that run at the repository root.
function workflowScripts(content: string) {
  let value: unknown;
  try {
    value = parse(content);
  } catch {
    return [];
  }
  if (!isObject(value) || !isObject(value.jobs)) return [];
  return Object.values(value.jobs).flatMap((job) =>
    isObject(job) && Array.isArray(job.steps)
      ? job.steps.flatMap((step) =>
          isObject(step) &&
          typeof step.run === 'string' &&
          (step['working-directory'] === undefined || step['working-directory'] === '.')
            ? [step.run]
            : [],
        )
      : [],
  );
}

function lockfileManager(files: ReadonlyMap<string, string>): InstallManager | undefined {
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  if (files.has('package-lock.json') || files.has('npm-shrinkwrap.json')) return 'npm';
  return undefined;
}

// The packageManager pin, else a default of the lockfile's generation. Yarn 2+ ships as
// @yarnpkg/cli-dist.
function tool(manager: InstallManager, files: ReadonlyMap<string, string>) {
  if (manager === 'npm') return undefined;
  let pinned: string | undefined;
  try {
    const value = JSON.parse(files.get('package.json') ?? '{}');
    pinned = typeof value.packageManager === 'string' ? value.packageManager : undefined;
  } catch {
    pinned = undefined;
  }
  const version = new RegExp(`^${manager}@(\\d+\\.\\d+\\.\\d+)`).exec(pinned ?? '')?.[1];
  if (manager === 'pnpm') return `pnpm@${version ?? '10'}`;
  const berry = version ? !version.startsWith('1.') : files.has('.yarnrc.yml');
  return berry ? `@yarnpkg/cli-dist@${version ?? '4'}` : `yarn@${version ?? '1.22.22'}`;
}

export function installPlan(files: ReadonlyMap<string, string>): InstallPlan | undefined {
  if (!files.has('package.json')) return undefined;
  const candidates: (Omit<InstallPlan, 'tool'> | undefined)[] = [
    files.has('Dockerfile')
      ? fromScript('dockerfile', 'Dockerfile', dockerfile(files.get('Dockerfile')!))
      : undefined,
    ...['.devcontainer/devcontainer.json', '.devcontainer.json'].map((file) =>
      files.has(file)
        ? fromScript('devcontainer', file, devcontainer(files.get(file)!))
        : undefined,
    ),
    ...[...files.keys()]
      .filter((file) => file.startsWith('.github/workflows/'))
      .sort()
      .flatMap((file) =>
        workflowScripts(files.get(file)!).map((script) => fromScript('ci', file, script)),
      ),
  ];
  const found = candidates.find(Boolean);
  if (found) return { ...found, tool: tool(found.manager, files) };
  const manager = lockfileManager(files);
  if (!manager) return undefined;
  const yarnTool = manager === 'yarn' ? tool('yarn', files) : undefined;
  const command =
    manager === 'npm'
      ? ['npm', 'ci']
      : manager === 'pnpm'
        ? ['pnpm', 'install', '--frozen-lockfile']
        : ['yarn', 'install', yarnTool?.startsWith('yarn@') ? '--frozen-lockfile' : '--immutable'];
  return {
    source: 'lockfile',
    file: 'package.json',
    manager,
    command,
    tool: tool(manager, files),
    skipped: [],
  };
}

// Public registries, always reachable from the build sandbox.
export const PUBLIC_REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com'];
const MAX_HOSTS = 64;
const URL_HOST =
  /\b(?:https?|git\+https?|git\+ssh|ssh|git):\/\/(?:[^@/\s"']+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

const GITHUB_SHORTHAND = /^(?:github:)?[\w.-]+\/[\w.-]+(?:#.*)?$/;

function dependencyValues(manifest: string | undefined) {
  try {
    const value = JSON.parse(manifest ?? '{}');
    return ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((key) =>
      isObject(value[key]) ? Object.values(value[key]).map(String) : [],
    );
  } catch {
    return [];
  }
}

// The hosts the repository's own files name: registries in .npmrc and Yarn settings, and every
// dependency URL in the manifest and every URL in the lockfiles. GitHub shorthands name github.com and its tarball host.
export function namedHosts(files: ReadonlyMap<string, string>) {
  const hosts = new Set(PUBLIC_REGISTRIES);
  for (const [file, content] of files) {
    if (file.startsWith('.github/') || file === 'Dockerfile' || file.includes('devcontainer'))
      continue;
    // Only package.json's dependency sources count: a URL in a script is not a dependency.
    const text = file === 'package.json' ? dependencyValues(content).join('\n') : content;
    for (const match of text.matchAll(URL_HOST)) hosts.add(match[1].toLowerCase());
  }
  if (dependencyValues(files.get('package.json')).some((value) => GITHUB_SHORTHAND.test(value)))
    hosts.add('github.com');
  if (hosts.has('github.com')) hosts.add('codeload.github.com');
  return [...hosts].slice(0, MAX_HOSTS);
}

// Why an install failed, in the terms the fallback needs: something only the customer has.
const CUSTOMER_ONLY =
  /\bE401\b|\bE403\b|\bENEEDAUTH\b|401 Unauthorized|403 Forbidden|Failed to replace env in config|could not read Username|Permission denied \(publickey\)|ERR_PNPM_FETCH_40[13]|Request failed "40[13]|REFIT_DENIED=/;

export function needsCustomerEnvironment(stderr: string) {
  return CUSTOMER_ONLY.test(stderr);
}
