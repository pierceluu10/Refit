import { join } from 'node:path';
import { loadDeadApis } from '../dead-apis/list.ts';
import { PROPOSED_DIR } from '../dead-apis/proposals.ts';
import { BudgetLedger } from '../inventory/budget.ts';
import { checkUnclear } from '../inventory/dead-check.ts';
import { scanDeadApis } from '../inventory/dead-scan.ts';
import { SCANNER_VERSION } from '../inventory/scanner-version.ts';
import {
  Budget,
  defaultAi,
  defaultMemory,
  memoryDir,
  recordEvidence,
  recordHabits,
  scrubFor,
  shareLearning,
  sharedStore,
} from '../memory/index.ts';
import { runRepoJob } from '../orchestrator/index.ts';
import type { Finding } from '../shared/types.ts';
import type { ConsentStore } from './consent.ts';
import { createEvidence, type Evidence } from './evidence.ts';
import { createFactStore } from './fix-facts.ts';
import { cloneRepo, treeOfCheckout } from './git.ts';
import {
  commitFiles,
  compareFiles,
  headTree,
  listPullComments,
  listPullCommits,
  listPullFiles,
} from './github.ts';
import { createJobRunner } from './jobs.ts';
import { createOpenPullRequest } from './pr.ts';
import type { TriggerStore } from './triggers.ts';
import type { InstallationTokens, RecordEvidence, RecordHabits, UnderstandJob } from './types.ts';

let ledger: Promise<BudgetLedger> | undefined;
// One ledger for the process, as the loop has one budget: with a new one per scan, a rescan of every
// repo would give each repo's AI check the whole cap.
const openLedger = () => (ledger ??= BudgetLedger.fromEnv());

const scan = async (dir: string, repo: string) =>
  checkUnclear(await scanDeadApis(dir, repo, { storeDir: PROPOSED_DIR }), dir, { openLedger });

// A send can trigger a model call, so each gets its own cap, as a verdict does.
const EVIDENCE_BUDGET_USD = 1;

const sendEvidence: RecordEvidence = async (pr, evidence, { consented }) => {
  const memory = {
    ...defaultMemory(pr),
    ...defaultAi(process.env, new Budget(EVIDENCE_BUDGET_USD)),
  };
  await recordEvidence(pr, evidence, memory);
  const providers = [...new Set(loadDeadApis().entries.map((entry) => entry.provider))];
  await shareLearning({
    store: memory.store,
    shared: sharedStore(memoryDir()),
    consented,
    scrub: scrubFor(pr, providers),
  });
};
const sendHabits: RecordHabits = (habits) => recordHabits(habits);

/** The real evidence, for the server and for a manual rescan, so a PR either one opens is remembered. */
export const createAppEvidence = (
  tokens: InstallationTokens,
  dataDir: string,
  consent: Pick<ConsentStore, 'consented'>,
) =>
  createEvidence({
    tokens,
    github: { listPullCommits, listPullFiles, commitFiles, compareFiles, listPullComments },
    facts: createFactStore(join(dataDir, 'fixes')),
    consent,
    recordEvidence: sendEvidence,
    recordHabits: sendHabits,
  });

/** Hands a job's scan to evidence, only for a repo with a merged fix that could come back. */
export const rescanWith =
  (evidence: Pick<Evidence, 'hasFixToWatch' | 'rescanFound'>) =>
  async ({ installationId, repo }: UnderstandJob, findings: Finding[], at: string) => {
    if (await evidence.hasFixToWatch(repo)) {
      await evidence.rescanFound(installationId, repo, findings, at);
    }
  };

/** The real job runner, for the server and for a manual rescan. */
export const createAppRunner = (
  tokens: InstallationTokens,
  triggers: TriggerStore,
  evidence: Pick<Evidence, 'opened' | 'hasFixToWatch' | 'rescanFound'>,
) =>
  createJobRunner({
    tokens,
    runRepoJob,
    checkout: cloneRepo,
    openPullRequestFor: (installationId) =>
      createOpenPullRequest(tokens, installationId, fetch, evidence.opened),
    headTree: (token, repo) => headTree(token, repo),
    treeOfCheckout,
    scan,
    loadList: () => loadDeadApis(),
    triggers,
    scannerVersion: SCANNER_VERSION,
    rescan: rescanWith(evidence),
  });
