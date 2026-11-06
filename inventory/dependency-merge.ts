// Folds the API inventory (ApiUsage) into the dependency list, so SDK call sites and pinned API
// versions sit beside the libraries they belong to. Pure: inputs are never modified.
import type { ApiUsage, DependencyUsage, ProviderHints } from '../shared/types.ts';
import { mergeHints } from './hints.ts';

// DependencyUsage has no hints or package field and shared/types.ts is off limits, so findings carry them additively.
export type DependencyFinding = DependencyUsage & { hints?: ProviderHints; package?: string };

type CallSite = ApiUsage['callSites'][number];

const ROOT_PACKAGE = '.';
const SDK_KINDS = new Set<DependencyUsage['kind']>(['library', 'sdk']);

function mergeCallSites(existing: CallSite[] = [], added: CallSite[]): CallSite[] {
  const seen = new Set<string>();
  return [...existing, ...added].filter((site) => {
    const key = JSON.stringify([site.file, site.line, site.operation]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withUsage(
  finding: DependencyFinding,
  callSites: CallSite[],
  hints: ProviderHints | undefined,
): DependencyFinding {
  const merged = mergeHints(finding.hints, hints ?? {});
  return {
    ...finding,
    callSites: mergeCallSites(finding.callSites, callSites),
    ...(merged ? { hints: merged } : {}),
  };
}

// Length of the package directory when it contains the file, 0 for the root, -1 when it does not.
function containment(finding: DependencyFinding, file: string): number {
  const directory = finding.package ?? ROOT_PACKAGE;
  if (directory === ROOT_PACKAGE) return 0;
  return file === directory || file.startsWith(`${directory}/`) ? directory.length : -1;
}

// The finding whose package directory is the longest prefix of the file; the first when none contains it.
function routeCallSite(findings: DependencyFinding[], indexes: number[], file: string): number {
  return indexes.reduce(
    (best, index) =>
      containment(findings[index], file) > containment(findings[best], file) ? index : best,
    indexes[0],
  );
}

function sdkFinding(usage: ApiUsage, sdk: NonNullable<ApiUsage['sdk']>): DependencyFinding {
  const hints = mergeHints(undefined, usage.hints ?? {});
  return {
    repo: usage.repo,
    kind: 'sdk',
    name: sdk.name,
    version: sdk.version,
    declaredIn: sdk.lockfile ? [{ file: sdk.lockfile }] : [],
    callSites: [...usage.callSites],
    ...(hints ? { hints } : {}),
  };
}

function mergeApiEntry(
  existing: DependencyFinding | undefined,
  usage: ApiUsage,
): DependencyFinding {
  const { pinnedVersion } = usage;
  const entry = existing ?? {
    repo: usage.repo,
    kind: 'api' as const,
    name: usage.provider,
    ecosystem: usage.provider,
    declaredIn: [],
  };
  const declaredIn = pinnedVersion
    ? [...entry.declaredIn, { file: pinnedVersion.file, line: pinnedVersion.line }]
    : entry.declaredIn;
  const notes = new Set([...(entry.notes?.split(', ') ?? []), usage.via]);
  const version = entry.version ?? pinnedVersion?.value;
  return {
    ...withUsage(entry, usage.callSites, usage.hints),
    ...(version === undefined ? {} : { version }),
    declaredIn: declaredIn.filter(
      (place, position) =>
        declaredIn.findIndex((other) => other.file === place.file && other.line === place.line) ===
        position,
    ),
    notes: [...notes].join(', '),
  };
}

export function mergeApiUsages(
  findings: DependencyFinding[],
  usages: ApiUsage[],
): DependencyFinding[] {
  const result = [...findings];
  const apiEntries = new Map<string, DependencyFinding>();
  for (const usage of usages) {
    const { sdk } = usage;
    if (sdk) {
      const matches = result.flatMap((finding, index) =>
        SDK_KINDS.has(finding.kind) && finding.name === sdk.name ? [index] : [],
      );
      if (matches.length === 0) {
        result.push(sdkFinding(usage, sdk));
      } else {
        const routed = new Map<number, CallSite[]>(matches.map((index) => [index, []]));
        for (const site of usage.callSites) {
          routed.get(routeCallSite(result, matches, site.file))?.push(site);
        }
        for (const [index, sites] of routed) {
          result[index] = { ...withUsage(result[index], sites, usage.hints), kind: 'sdk' };
        }
      }
    }
    if (usage.pinnedVersion || !sdk) {
      apiEntries.set(usage.provider, mergeApiEntry(apiEntries.get(usage.provider), usage));
    }
  }
  return [...result, ...apiEntries.values()];
}
