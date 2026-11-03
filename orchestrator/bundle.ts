// One task per repo and provider: every change the match agent found for that provider goes to a
// single harness run and a single PR. Separate runs per change each paid for a fresh sandbox,
// install, codegen, checks and test, and their PRs edited the same files and conflicted on merge.
import type { MatchedTask } from './match.ts';

function describe(task: MatchedTask, index: number): string {
  const { change } = task;
  const affects = Object.entries(change.affects)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join('; ');
  const sites = task.callSites.map((site) => `${site.file}:${site.line} (${site.why})`).join('; ');
  return [
    `${index + 1}. ${change.title} (${change.kind}${change.effectiveDate ? `, effective ${change.effectiveDate}` : ''})`,
    `   Source: ${change.source.url}`,
    `   Quote: ${change.source.quote.replace(/\s+/g, ' ').slice(0, 1200)}`,
    affects && `   Affects: ${affects}`,
    sites && `   Call sites: ${sites}`,
    `   Why it applies: ${task.reasoning.replace(/\s+/g, ' ').slice(0, 1200)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function bundleTasks(tasks: MatchedTask[]): MatchedTask[] {
  const groups = new Map<string, MatchedTask[]>();
  for (const task of tasks) {
    const key = `${task.repo}\n${task.change.provider}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0] as MatchedTask;
    const sorted = [...group].sort((a, b) => a.priority - b.priority);
    const first = sorted[0] as MatchedTask;
    const notes = [
      `This one task covers all ${sorted.length} ${first.change.provider} changes that affect this repo. Handle every one of them in this single change set, prove each with your test, and say in finish which you changed and which needed no change.`,
      ...sorted.map(describe),
    ].join('\n\n');
    return {
      ...first,
      id: `${first.id}+${sorted.length - 1}`,
      change: {
        ...first.change,
        title: `${sorted.length} changes: ${first.change.title} and more`,
      },
      usages: [
        ...new Map(sorted.flatMap((t) => t.usages).map((u) => [JSON.stringify(u), u])).values(),
      ],
      priority: first.priority,
      notes,
      reasoning: sorted.map((t) => `${t.change.id}: ${t.reasoning}`).join('\n'),
      callSites: sorted.flatMap((t) => t.callSites),
    };
  });
}
