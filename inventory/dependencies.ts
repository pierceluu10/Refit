// inventoryDependencies: one agent run that reads a repository and finds everything outside the code
// that can force it to change, including the API inventory, then adds P5's platform and regulated
// surfaces. The model decides what is true; scanners only give it leads.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { redactSecrets } from '../harness/secrets.ts';
import type { ApiUsage, InventoryDependencies, InventorySurfaces } from '../shared/types.ts';
import { MAIN_MODEL, purposesOf, runAgent } from './agent.ts';
import type { InventoryOptions } from './agent.ts';
import { UsageCollector } from './collector.ts';
import { DependencyCollector } from './dependency-collector.ts';
import { mergeApiUsages } from './dependency-merge.ts';
import type { DependencyFinding } from './dependency-merge.ts';
import { dependencyRecordTools, dependencyScanTools } from './dependency-tools.ts';
import {
  cleanCommit,
  defaultInventoryCache,
  readCachedInventory,
  writeCachedInventory,
} from './cache.ts';
import { mergeHints } from './hints.ts';
import {
  DEPENDENCY_AREA_READER_DESCRIPTION,
  DEPENDENCY_AREA_READER_PROMPT,
  DEPENDENCY_PROMPT_VERSION,
  DEPENDENCY_SYSTEM_PROMPT,
  dependencyTaskPrompt,
} from './prompt.ts';
import { summarizeDependencies } from './summary.ts';
import { inventorySurfaces } from './surfaces/agent.ts';
import { PROMPT_VERSION as SURFACES_PROMPT_VERSION } from './surfaces/prompt.ts';
import { readTools, recordTools } from './tools.ts';

export const DEFAULT_DEPENDENCY_RUN_CAP_USD = 1.2;
const REGISTRY_ECOSYSTEMS = new Set(['npm', 'pypi']);
const GITHUB_ACTIONS_ECOSYSTEM = 'github-actions';
// owner/repo at the start of an action or reusable workflow; local ./ paths and docker:// don't match.
const GITHUB_ACTION_REPOSITORY = /^(\w[\w.-]*\/[\w.-]+)/;

// cacheDir: where finished inventories are kept by commit; false turns the cache off.
export type DependencyOptions = InventoryOptions & {
  surfaces?: InventorySurfaces;
  cacheDir?: string | false;
};

// A new dependency or surfaces prompt reads every repo again.
export const INVENTORY_CACHE_VERSION = `${DEPENDENCY_PROMPT_VERSION}+${SURFACES_PROMPT_VERSION}`;

export type DependencyReport = {
  repo: string;
  promptVersion: string;
  model: string;
  dependencies: DependencyFinding[];
  usages: ApiUsage[];
  purposes: Record<string, string>;
  errors: string[];
  summary: string;
  agentSummary: string;
  outcome: SDKResultMessage['subtype'];
  costUsd: number;
  turns: number;
  durationMs: number;
};

// A paid-for inventory must survive a failed surfaces pass; ScanReport.errors says what is missing.
async function surfacesOf(
  repoDir: string,
  repo: string,
  surfaces: InventorySurfaces,
  errors: string[],
): Promise<DependencyFinding[]> {
  try {
    return await surfaces(repoDir, repo);
  } catch (error) {
    errors.push(`Platform and regulated surfaces were not read: ${(error as Error).message}`);
    return [];
  }
}

// What a name alone tells a watcher, for entries where the agent left hints out. The agent's hints stay.
function withDerivedHints(finding: DependencyFinding): DependencyFinding {
  const ecosystem = finding.ecosystem?.toLowerCase() ?? '';
  const action =
    ecosystem === GITHUB_ACTIONS_ECOSYSTEM ? GITHUB_ACTION_REPOSITORY.exec(finding.name)?.[1] : '';
  const hints = mergeHints(finding.hints, {
    ...(REGISTRY_ECOSYSTEMS.has(ecosystem) ? { packages: [finding.name] } : {}),
    ...(action ? { docsUrls: [`https://github.com/${action}`] } : {}),
  });
  return hints ? { ...finding, hints } : finding;
}

// A clean checkout at a commit already read costs $0: the code has not changed, so neither has what it
// depends on. What changed outside it is the watchers' job, and they read every day.
export async function runDependencyInventory(
  repoDir: string,
  repo: string,
  options: DependencyOptions = {},
): Promise<DependencyReport> {
  const cacheDir = options.cacheDir ?? defaultInventoryCache();
  const commit = cacheDir === false ? undefined : await cleanCommit(repoDir);
  if (cacheDir !== false && commit) {
    const cached = await readCachedInventory<DependencyReport>(
      cacheDir,
      repo,
      commit,
      INVENTORY_CACHE_VERSION,
    );
    if (cached) return { ...cached.report, costUsd: 0, turns: 0, durationMs: 0 };
  }
  const report = await readDependencies(repoDir, repo, options);
  // Only a finished, complete read is kept; anything partial is read again next time.
  if (cacheDir !== false && commit && report.outcome === 'success' && report.errors.length === 0) {
    await writeCachedInventory(cacheDir, {
      version: INVENTORY_CACHE_VERSION,
      repo,
      commit,
      cachedAt: new Date().toISOString(),
      report,
    }).catch(() => undefined); // a cache that can't be written costs the next scan, nothing else
  }
  return report;
}

async function readDependencies(
  repoDir: string,
  repo: string,
  options: DependencyOptions,
): Promise<DependencyReport> {
  const dependencyCollector = new DependencyCollector(repoDir, repo);
  const usageCollector = new UsageCollector(repoDir, repo);
  const tools = [
    ...readTools(repoDir),
    ...dependencyScanTools(repoDir),
    ...recordTools(usageCollector),
    ...dependencyRecordTools(dependencyCollector),
  ];
  const started = Date.now();
  const result = await runAgent(
    repoDir,
    repo,
    tools,
    {
      system: DEPENDENCY_SYSTEM_PROMPT,
      areaReader: DEPENDENCY_AREA_READER_PROMPT,
      areaReaderDescription: DEPENDENCY_AREA_READER_DESCRIPTION,
      task: dependencyTaskPrompt,
    },
    { ...options, defaultCapUsd: DEFAULT_DEPENDENCY_RUN_CAP_USD },
  );

  const errors =
    result.subtype === 'success' ? [] : [`The agent run ended early: ${result.subtype}`];
  const usages = usageCollector.usagesForOutput();
  const dependencies = [
    ...mergeApiUsages(
      dependencyCollector.list().map(({ dependency }) => dependency),
      usages,
    ).map(withDerivedHints),
    ...(await surfacesOf(repoDir, repo, options.surfaces ?? inventorySurfaces, errors)),
  ];

  const report: DependencyReport = {
    repo,
    promptVersion: DEPENDENCY_PROMPT_VERSION,
    model: MAIN_MODEL,
    dependencies,
    usages,
    purposes: purposesOf(usageCollector.list().map(({ usage }) => usage)),
    errors,
    summary: summarizeDependencies(repo, dependencies, result.subtype),
    agentSummary: result.subtype === 'success' ? result.result : result.errors.join('\n'),
    outcome: result.subtype,
    costUsd: result.total_cost_usd,
    turns: result.num_turns,
    durationMs: Date.now() - started,
  };
  // Hard limit: line text and notes come from the repository and the model, and leave this process.
  return JSON.parse(redactSecrets(JSON.stringify(report))) as DependencyReport;
}

export const inventoryDependencies: InventoryDependencies = async (repoDir, repo) =>
  (await runDependencyInventory(repoDir, repo)).dependencies;
