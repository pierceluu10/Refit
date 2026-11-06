// The short human summary, built from what the agent recorded.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RecordedUsage } from './collector.ts';
import type { DependencyFinding } from './dependency-merge.ts';

const CHANNEL_WORDS: Record<RecordedUsage['via'], string> = {
  sdk: 'its SDK',
  http: 'raw HTTP',
  graphql: 'GraphQL',
  webhook: 'webhooks',
};

function places(count: number): string {
  return count === 1 ? '1 place' : `${count} places`;
}

function describe(usage: RecordedUsage): string {
  const purpose = usage.purpose ? ` for ${usage.purpose}` : '';
  const channel = usage.sdk
    ? `${usage.sdk.name} ${usage.sdk.version}`.trim()
    : CHANNEL_WORDS[usage.via];
  const pinned = usage.pinnedVersion ? `, pinned to ${usage.pinnedVersion.value}` : '';
  return `${usage.provider}${purpose} through ${channel}${pinned} in ${places(usage.callSites.length)}`;
}

export function summarize(
  repo: string,
  usages: RecordedUsage[],
  outcome: SDKResultMessage['subtype'],
): string {
  const incomplete =
    outcome === 'success' ? '' : ` The run ended early (${outcome}), so this may be incomplete.`;
  if (usages.length === 0) return `${repo}: no external API usage was recorded.${incomplete}`;
  const sorted = [...usages].sort((a, b) => b.callSites.length - a.callSites.length);
  return `${repo} uses ${sorted.map(describe).join('; ')}.${incomplete}`;
}

export function summarizeDependencies(
  repo: string,
  dependencies: DependencyFinding[],
  outcome: SDKResultMessage['subtype'],
): string {
  const incomplete =
    outcome === 'success' ? '' : ` The run ended early (${outcome}), so this may be incomplete.`;
  if (dependencies.length === 0) return `${repo}: no dependencies were recorded.${incomplete}`;
  const byKind = new Map<string, string[]>();
  for (const { kind, name, version, package: owner, declaredIn } of dependencies) {
    const label = [name, version, owner && `in ${owner}`, `(${places(declaredIn.length)})`];
    byKind.set(kind, [...(byKind.get(kind) ?? []), label.filter(Boolean).join(' ')]);
  }
  const lines = [...byKind].map(([kind, entries]) => `${kind}: ${entries.join(', ')}`);
  return `${repo} depends on:\n${lines.join('\n')}${incomplete && `\n${incomplete.trim()}`}`;
}
