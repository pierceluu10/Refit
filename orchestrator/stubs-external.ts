// Offline stand-ins for the external-change path, until P2, F1 and O2 land, and whenever no model is
// available. Labelled as stubs in everything they return; none of them runs repo code.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DependencyKind,
  DependencyUsage,
  ExternalChange,
  ExternalTask,
  InventoryDependencies,
  MigrationKind,
  MigrationTask,
  RunExternalTask,
  WatchDependency,
} from '../shared/types.ts';
import { baseName, companions, rankTasks, shapeTasks } from './external-match.ts';
import type { ExternalMatchedTask, MatchExternal } from './external-match.ts';
import type { LoopRecord } from './loop.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

// shortcut: kind labels for a few well-known names so the offline report reads sensibly. The real
// inventory (P2) is an agent that reads the repo; this list never decides what counts as a dependency.
const FRAMEWORKS = new Set([
  'next',
  'react',
  'express',
  'flask',
  'django',
  'fastapi',
  'vue',
  'nuxt',
]);
const SDKS = new Set(['openai', 'stripe', 'anthropic', '@anthropic-ai/sdk', 'twilio', 'boto3']);
const kindOf = (name: string): DependencyKind =>
  FRAMEWORKS.has(name) ? 'framework' : SDKS.has(name) ? 'sdk' : 'library';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next']);
const MAX_FILES = 2000;

// Every file in the checkout, as paths relative to it. Reads only; the env files are never opened.
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string) => {
    if (out.length >= MAX_FILES) return;
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !/^\.env(\.|$)/.test(entry.name)) out.push(relative(dir, path));
    }
  };
  await walk(dir);
  return out.sort();
}

const lineOf = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  return i === -1 ? undefined : text.slice(0, i).split('\n').length;
};

// Stub for P2's inventoryDependencies: reads manifests, version files, Dockerfiles, workflows,
// Kubernetes and serverless files, and model names in source. An offline stand-in, not the agent.
export function stubInventoryDependencies(): InventoryDependencies {
  return async (repoDir, repo) => {
    const found = new Map<string, DependencyUsage>();
    const add = (
      kind: DependencyKind,
      name: string,
      version: string | undefined,
      at: { file: string; line?: number; text?: string },
      ecosystem?: string,
    ) => {
      const key = `${kind}:${name}`;
      const dep = found.get(key) ?? {
        repo,
        kind,
        name,
        ecosystem,
        version,
        declaredIn: [],
        notes: 'stub inventory: read from manifests offline, not by the inventory agent',
      };
      dep.version ??= version;
      dep.declaredIn.push(at);
      found.set(key, dep);
    };
    const files = await listFiles(repoDir);
    const read = (file: string) => readFile(join(repoDir, file), 'utf8').catch(() => '');

    for (const file of files) {
      const name = file.split('/').pop()!;
      const text = await read(file);
      if (!text) continue;
      const at = (needle: string) => ({ file, line: lineOf(text, needle), text: needle });
      if (name === 'package.json') {
        let pkg: Record<string, Record<string, string> | undefined>;
        try {
          pkg = JSON.parse(text);
        } catch {
          continue;
        }
        const node = pkg.engines?.node;
        if (node) add('runtime', 'node', node.match(/\d+/)?.[0], at(`"node": "${node}"`), 'node');
        for (const [dep, version] of Object.entries({
          ...pkg.dependencies,
          ...pkg.devDependencies,
        }))
          add(kindOf(dep), dep, version.replace(/^[^\d]*/, ''), at(`"${dep}"`), 'npm');
      } else if (name === '.nvmrc' || name === '.node-version') {
        add('runtime', 'node', text.trim().replace(/^v/, ''), { file, line: 1, text: text.trim() });
      } else if (name === '.python-version') {
        add('runtime', 'python', text.trim(), { file, line: 1, text: text.trim() });
      } else if (name === 'pyproject.toml' || /^requirements.*\.txt$/.test(name)) {
        const py = text.match(/requires-python\s*=\s*"([^"]+)"/);
        if (py) add('runtime', 'python', py[1].match(/\d+\.\d+/)?.[0], at(py[0]));
        for (const m of text.matchAll(/^\s*"?([A-Za-z][\w.-]*)\s*(?:==|>=|~=)\s*([\w.]+)"?,?$/gm))
          add(kindOf(m[1].toLowerCase()), m[1].toLowerCase(), m[2], at(m[0].trim()), 'pypi');
      } else if (/^Dockerfile/.test(name)) {
        for (const m of text.matchAll(/^FROM\s+(\S+)/gm))
          add('container-image', m[1], m[1].split(':')[1], at(m[0]), 'docker');
      } else if (file.startsWith('.github/workflows/')) {
        for (const m of text.matchAll(/uses:\s*([\w./-]+)@([\w.-]+)/g))
          add('ci', m[1], m[2], at(m[0]), 'github-actions');
        for (const m of text.matchAll(/runs-on:\s*([\w.-]+)/g))
          add('ci', m[1], m[1].split('-')[1], at(m[0]), 'github-actions');
        for (const m of text.matchAll(/(node|python)-version:\s*['"]?([\d.]+)/g))
          add('runtime', m[1] === 'node' ? 'node' : 'python', m[2], at(m[0]));
      } else if (/\.ya?ml$/.test(name) && /^apiVersion:/m.test(text)) {
        const api = text.match(/^apiVersion:\s*(\S+)/m)![1];
        const kind = text.match(/^kind:\s*(\S+)/m)?.[1] ?? 'unknown';
        add('infrastructure', kind, api, at(`apiVersion: ${api}`), 'kubernetes');
      } else if (name === 'serverless.yml' || name === 'serverless.yaml') {
        const rt = text.match(/runtime:\s*(\S+)/);
        if (rt) add('infrastructure', rt[1], rt[1], at(rt[0]), 'aws-lambda');
      } else if (/\.(m?[jt]sx?|py)$/.test(name)) {
        for (const m of text.matchAll(/model\s*[:=]\s*['"]([\w.:-]+)['"]/g))
          add('ai-model', m[1], undefined, at(m[0]), 'model');
      }
    }
    return [...found.values()];
  };
}

// Stub for F1's watchDependency: replays the illustrative fixture changes for the dependency.
export function stubWatchDependency(file = fixture('external-changes.json')): WatchDependency {
  return async (dep) => {
    const changes = JSON.parse(await readFile(file, 'utf8')) as ExternalChange[];
    return changes.filter((c) => baseName(c.dependency) === baseName(dep.name));
  };
}

const major = (v?: string) => v?.match(/\d+(\.\d+)?/)?.[0];
const sameVersion = (dep: DependencyUsage, from: string[]) =>
  from.some(
    (v) =>
      v === dep.version ||
      major(v) === major(dep.version) ||
      major(v) === dep.version?.match(/\d+/)?.[0],
  );

// shortcut: offline stand-in for the external match agent, never used when ANTHROPIC_API_KEY is set.
// Name and version matching here is only what lets the offline demo produce tasks and verdicts.
export const stubMatchExternal: MatchExternal = async ({ repo, changes, dependencies }) => {
  const tasks: ExternalMatchedTask[] = [];
  const notAffected: { changeId: string; reasoning: string }[] = [];
  for (const change of changes) {
    const named = dependencies.filter((d) => baseName(d.name) === baseName(change.dependency));
    const from = change.fromVersions ?? [];
    const hit = named.filter((d) => !from.length || !d.version || sameVersion(d, from));
    if (hit.length === 0) {
      notAffected.push({
        changeId: change.id,
        reasoning: named.length
          ? `stub matcher: ${change.dependency} is at ${named.map((d) => d.version).join(', ')}, outside ${from.join(', ')}`
          : `stub matcher: the repo's dependency map has no ${change.dependency}`,
      });
      continue;
    }
    const moving = [...new Set([...hit, ...hit.flatMap((d) => companions(d, dependencies))])];
    tasks.push({
      id: `${repo}:${change.id}`,
      repo,
      change,
      dependencies: moving,
      usages: [],
      deadline: change.effectiveDate,
      priority: 0,
      notes: 'stub matcher: no model available; name and version matched offline',
      reasoning: 'stub matcher: no model available; name and version matched offline',
      impact: change.severity === 'security' ? 'critical' : 'unknown',
      callSites: hit.flatMap((d) =>
        d.declaredIn.map(({ file, line }) => ({
          file,
          line: line ?? 1,
          why: `declares ${d.name}`,
        })),
      ),
      alsoResolves: [],
    });
  }
  return { tasks: rankTasks(shapeTasks(tasks)), notAffected, costUsd: 0 };
};

// Stub for O2's runExternalTask: changes nothing and says so.
export const stubRunExternalTask: RunExternalTask = async (task) => {
  const result: LoopRecord = {
    taskId: task.id,
    outcome: 'needs-review',
    diff: `# stub: placeholder diff for ${task.id}; offline run, no code was changed\n`,
    checks: [],
    costUsd: 0,
    transcriptPath: '',
    note: 'stub runExternalTask: offline run without ANTHROPIC_API_KEY, so nothing was upgraded or proven',
  };
  return result;
};

const API_KINDS: MigrationKind[] = [
  'api-version',
  'sdk-major',
  'field-removed',
  'field-renamed',
  'endpoint-removed',
  'rest-to-graphql',
  'auth-change',
  'webhook-payload',
  'model-retirement',
  'product-shutdown',
  'pagination-or-limits',
  'other',
];

// An external task in the API task's shape, for parts that only take MigrationTask: today's harness
// runTask (until O2's runExternalTask lands) and memory. The whole external change and every place the
// dependency is declared go into the notes, so the harness has everything the match agent saw.
export function asMigrationTask(task: ExternalTask): MigrationTask {
  const { change, dependencies, ...rest } = task;
  const kind = (API_KINDS as string[]).includes(change.kind)
    ? (change.kind as MigrationKind)
    : 'other';
  return {
    ...rest,
    change: { ...change, kind },
    notes: [
      task.notes ?? '',
      `External change (${change.kind}, ${change.dependencyKind}): ${change.dependency}${change.fromVersions ? ` from ${change.fromVersions.join(', ')}` : ''}${change.toVersion ? ` to ${change.toVersion}` : ''}.`,
      `Declared in:\n${dependencies
        .flatMap((d) =>
          d.declaredIn.map(
            (at) =>
              `- ${d.name}@${d.version ?? '?'}: ${at.file}${at.line ? `:${at.line}` : ''}${at.text ? ` (${at.text})` : ''}`,
          ),
        )
        .join('\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}
