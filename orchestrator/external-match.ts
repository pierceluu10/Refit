// The match agent for external changes: runtimes, frameworks, libraries, advisories, models, images,
// CI, platforms and rules. A Claude agent reads every change against the repo's dependencies and call
// sites and decides what is affected, why and how urgent. Version overlap and dates reach it as hints;
// they never decide anything.
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ApiUsage,
  DependencyUsage,
  ExternalChange,
  ExternalTask,
  ProviderChange,
} from '../shared/types.ts';
import type { Budget } from './budget.ts';
import { messagesApi, type AskModel } from './match.ts';

export type Impact = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

// A task plus the agent's reasoning. alsoResolves lists changes merged into it because they move the
// same dependency to the same target.
export type ExternalMatchedTask = ExternalTask & {
  reasoning: string;
  impact: Impact;
  callSites: { file: string; line: number; why: string }[];
  alsoResolves: { changeId: string; title: string }[];
};

export type ExternalMatchResult = {
  tasks: ExternalMatchedTask[];
  notAffected: { changeId: string; reasoning: string }[];
  costUsd: number;
};

export type MatchExternal = (input: {
  repo: string;
  changes: ExternalChange[];
  dependencies: DependencyUsage[];
  usages: ApiUsage[];
  // API changes the API path already matches, so the agent can mark repeats of them.
  apiChanges?: ProviderChange[];
  repoDir?: string;
}) => Promise<ExternalMatchResult>;

export const EXTERNAL_SYSTEM_PROMPT = `You are Refit's match agent. Refit keeps software from falling behind: when anything outside a team's control changes (a runtime reaches end of life, a framework or library ships a breaking major, a security advisory lands, an AI model is retired, a base image or CI action is deprecated, a Kubernetes API or serverless runtime is removed, a platform or rule changes), Refit finds the affected code, fixes it, proves the fix and opens a PR.

You receive a list of external changes (each with a quote from its source) and the repository's dependency map: every runtime, framework, library, AI model, container image, CI action, platform and surface it depends on, the version, and every place that version is declared or implied. You may also receive the API usage map (call sites of third-party APIs) and a list of API changes another matcher already handles.

For EVERY change, read it against EVERY dependency and call site, then decide:
- Affected: the repo uses the dependency at a version, or in a way, the change touches. Create one task. List the indexes of every dependency that must move together for the fix: a runtime bump goes with the base image, the version files (.nvmrc, .python-version, engines, requires-python) and the CI lines that pin the same runtime. Name the affected call sites and why. Give a target version when the source or your knowledge supports one. Explain your reasoning and rate impact from what breaks, how visibly and how soon.
- Not affected: explain specifically why, in one or two sentences, naming the version or usage you checked.

Rules:
- Every change must come back exactly once: as a task or in notAffected. Never leave one out.
- When you are unsure whether a change applies, create the task anyway and say what is uncertain and what the migration agent should check. Unsure means attempt, not skip.
- Names are labels, not proof: "node", "nodejs" and the image "node:18-bookworm" are the same runtime; "actions/checkout@v3" is the action "actions/checkout".
- A change that repeats an API change in the list you were given is not affected here; name the API change it repeats.
- Two changes that move the same dependency to the same target belong in one task: put the second change's id in the first task's alsoResolves and leave it out of notAffected.
- The prompt includes hints computed by simple version and name matching and by date arithmetic. They can be wrong in both directions. Your own reading decides.
- Order the tasks from most to least urgent: deadline first, then severity (security first), then impact.
- deadline: the change's effective date if it has one, otherwise a date you can justify from the source, otherwise an empty string. Use YYYY-MM-DD.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'notAffected'],
  properties: {
    tasks: {
      type: 'array',
      description: 'Affected changes, most urgent first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'changeId',
          'dependencyIndexes',
          'usageIndexes',
          'callSites',
          'reasoning',
          'impact',
          'deadline',
          'toVersion',
          'alsoResolves',
        ],
        properties: {
          changeId: { type: 'string' },
          dependencyIndexes: { type: 'array', items: { type: 'integer' } },
          usageIndexes: { type: 'array', items: { type: 'integer' } },
          callSites: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['file', 'line', 'why'],
              properties: {
                file: { type: 'string' },
                line: { type: 'integer' },
                why: { type: 'string' },
              },
            },
          },
          reasoning: { type: 'string' },
          impact: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          deadline: { type: 'string' },
          toVersion: { type: 'string' },
          alsoResolves: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    notAffected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['changeId', 'reasoning'],
        properties: { changeId: { type: 'string' }, reasoning: { type: 'string' } },
      },
    },
  },
};

type AgentOutput = {
  tasks: {
    changeId: string;
    dependencyIndexes: number[];
    usageIndexes: number[];
    callSites: { file: string; line: number; why: string }[];
    reasoning: string;
    impact: string;
    deadline: string;
    toVersion: string;
    alsoResolves: string[];
  }[];
  notAffected: { changeId: string; reasoning: string }[];
};

// "node:18-bookworm" → "node", "actions/checkout@v3" → "actions/checkout", "NodeJS" → "node".
export function baseName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/^docker\.io\/(library\/)?/, '')
    .split(/[:@]/)[0];
  return base === 'nodejs' ? 'node' : base;
}

const major = (version?: string) => version?.match(/\d+/)?.[0];

// The other dependencies that likely move with dep: the same runtime as a base image, a version file
// or a CI setup step. Prompt context and the offline stub's grouping only; the agent decides.
export function companions(dep: DependencyUsage, deps: DependencyUsage[]): DependencyUsage[] {
  const base = baseName(dep.name);
  return deps.filter(
    (other) =>
      other !== dep &&
      (baseName(other.name) === base ||
        (other.kind === 'ci' && baseName(other.name).endsWith(`setup-${base}`))),
  );
}

// Name, version and date overlap between each change and the dependencies. Hints only.
export function externalHints(
  changes: ExternalChange[],
  deps: DependencyUsage[],
  today = new Date(),
): string[] {
  return changes.map((change) => {
    const base = baseName(change.dependency);
    const hits = deps.flatMap((dep, i) => {
      if (baseName(dep.name) !== base) return [];
      const from = change.fromVersions ?? [];
      const overlap = from.length
        ? from.some((v) => major(v) !== undefined && major(v) === major(dep.version))
          ? 'version overlaps fromVersions'
          : 'no major-version overlap with fromVersions'
        : 'no fromVersions given';
      const moves = companions(dep, deps).map((c) => deps.indexOf(c));
      return [
        `dependency ${i} (${dep.name}${dep.version ? `@${dep.version}` : ''}; ${overlap}${moves.length ? `; may move with ${moves.join(', ')}` : ''})`,
      ];
    });
    const days = change.effectiveDate
      ? Math.round((Date.parse(change.effectiveDate) - today.getTime()) / 86_400_000)
      : undefined;
    const when =
      days === undefined || Number.isNaN(days)
        ? 'no date'
        : days < 0
          ? `effective ${-days} day(s) ago`
          : `effective in ${days} day(s)`;
    return `- ${change.id}: ${when}; ${hits.length ? hits.join('; ') : 'no name match found'}`;
  });
}

export function buildExternalPrompt(input: Parameters<MatchExternal>[0]): string {
  const { repo, changes, dependencies, usages, apiChanges = [] } = input;
  return [
    `Repository: ${repo}`,
    `External changes (${changes.length}):\n${JSON.stringify(changes, null, 2)}`,
    `Dependencies, by index:\n${JSON.stringify(
      dependencies.map((dep, index) => ({ index, ...dep })),
      null,
      2,
    )}`,
    `API usages, by index:\n${JSON.stringify(
      usages.map((usage, index) => ({ index, ...usage })),
      null,
      2,
    )}`,
    apiChanges.length
      ? `API changes already handled by the API matcher (ids and titles only):\n${apiChanges.map((c) => `- ${c.id}: ${c.title}`).join('\n')}`
      : '',
    `HINTS (name, version and date matching only, may be wrong; read every dependency against every change regardless):\n${externalHints(changes, dependencies).join('\n')}`,
    'Return a verdict for every change: a task, an alsoResolves entry, or a notAffected entry.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const SEVERITY = ['security', 'deadline', 'breaking', 'notice'];
const IMPACT: Impact[] = ['critical', 'high', 'medium', 'low', 'unknown'];
const rank = (list: string[], value?: string) => {
  const i = value ? list.indexOf(value) : -1;
  return i === -1 ? list.length : i;
};

// Deadline first (soonest first, none last), then severity (security first), then impact. The sort is
// stable, so the agent's own order breaks ties. Ordering only: nothing is dropped.
export function rankTasks<T extends ExternalMatchedTask>(tasks: T[]): T[] {
  const time = (t: T) => (t.deadline ? Date.parse(t.deadline) : Number.POSITIVE_INFINITY);
  const sorted = [...tasks].sort(
    (a, b) =>
      time(a) - time(b) ||
      rank(SEVERITY, a.change.severity) - rank(SEVERITY, b.change.severity) ||
      rank(IMPACT, a.impact) - rank(IMPACT, b.impact),
  );
  sorted.forEach((task, i) => (task.priority = i + 1));
  return sorted;
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

// One task per change per repo, and never two tasks for the same dependency and target: a later task
// for the same pair is merged into the earlier one, with every dependency the two name.
export function shapeTasks(tasks: ExternalMatchedTask[]): ExternalMatchedTask[] {
  const byChange = new Map<string, ExternalMatchedTask>();
  const byTarget = new Map<string, ExternalMatchedTask>();
  for (const task of tasks) {
    const sameChange = byChange.get(task.change.id);
    const key = task.change.toVersion
      ? `${baseName(task.change.dependency)}→${task.change.toVersion}`
      : undefined;
    const sameTarget = key ? byTarget.get(key) : undefined;
    const into = sameChange ?? sameTarget;
    if (into) {
      into.dependencies = unique([...into.dependencies, ...task.dependencies]);
      into.usages = unique([...into.usages, ...task.usages]);
      into.callSites.push(...task.callSites);
      if (!sameChange) {
        into.alsoResolves.push({ changeId: task.change.id, title: task.change.title });
        into.notes = `${into.notes ?? ''}\nAlso resolves ${task.change.id}: ${task.change.title}`;
      }
      continue;
    }
    byChange.set(task.change.id, task);
    if (key) byTarget.set(key, task);
  }
  return [...byChange.values()];
}

export const NO_VERDICT =
  'The match agent returned no verdict for this change. Check the repo for any use of the dependency, then upgrade or conclude not affected.';

export function createExternalMatchAgent(opts: {
  ask?: AskModel;
  client?: Pick<Anthropic, 'messages'>;
  budget: Budget;
  model?: string;
}): MatchExternal {
  const ask = opts.ask ?? messagesApi(opts);
  return async (input) => {
    const { repo, changes, dependencies, usages, repoDir } = input;
    if (changes.length === 0) return { tasks: [], notAffected: [], costUsd: 0 };
    const answer = await ask({
      system: EXTERNAL_SYSTEM_PROMPT,
      prompt: buildExternalPrompt(input),
      schema: SCHEMA,
      repoDir,
    });
    const output = answer.output as AgentOutput;
    const byId = new Map(changes.map((c) => [c.id, c]));

    const tasks: ExternalMatchedTask[] = [];
    const judged = new Set<string>();
    // Unknown change ids are model slips; the real changes are still attempted below.
    for (const t of output.tasks.filter((t) => byId.has(t.changeId))) {
      const change = byId.get(t.changeId)!;
      const withTarget =
        t.toVersion && !change.toVersion ? { ...change, toVersion: t.toVersion } : change;
      const also = t.alsoResolves.filter((id) => byId.has(id) && id !== change.id);
      also.forEach((id) => judged.add(id));
      judged.add(change.id);
      tasks.push({
        id: `${repo}:${change.id}`,
        repo,
        change: withTarget,
        dependencies: t.dependencyIndexes.flatMap((i) =>
          dependencies[i] ? [dependencies[i]] : [],
        ),
        usages: t.usageIndexes.flatMap((i) => (usages[i] ? [usages[i]] : [])),
        deadline: change.effectiveDate ?? (t.deadline || undefined),
        priority: 0,
        notes: [
          t.reasoning,
          ...also.map((id) => `Also resolves ${id}: ${byId.get(id)!.title}`),
        ].join('\n'),
        reasoning: t.reasoning,
        impact: rank(IMPACT, t.impact) < IMPACT.length ? (t.impact as Impact) : 'unknown',
        callSites: t.callSites,
        alsoResolves: also.map((id) => ({ changeId: id, title: byId.get(id)!.title })),
      });
    }

    // A change judged both ways keeps its task: unsure means attempt.
    const notAffected: ExternalMatchResult['notAffected'] = [];
    for (const n of output.notAffected) {
      if (!byId.has(n.changeId) || judged.has(n.changeId)) continue;
      judged.add(n.changeId);
      notAffected.push({ changeId: n.changeId, reasoning: n.reasoning });
    }
    // No verdict is not "not affected": the harness judges it with the code in front of it.
    for (const change of changes.filter((c) => !judged.has(c.id))) {
      tasks.push({
        id: `${repo}:${change.id}`,
        repo,
        change,
        dependencies: dependencies.filter((d) => baseName(d.name) === baseName(change.dependency)),
        usages: [],
        deadline: change.effectiveDate,
        priority: 0,
        notes: NO_VERDICT,
        reasoning: NO_VERDICT,
        impact: 'unknown',
        callSites: [],
        alsoResolves: [],
      });
    }
    return { tasks: rankTasks(shapeTasks(tasks)), notAffected, costUsd: answer.costUsd };
  };
}
