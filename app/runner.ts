import { join } from 'node:path';
import { loadDeadApis } from '../dead-apis/list.ts';
import { PROPOSED_DIR } from '../dead-apis/proposals.ts';
import { BUDGET_ENV, BudgetExceededError, BudgetLedger } from '../inventory/budget.ts';
import { checkUnclear, type CheckLedger } from '../inventory/dead-check.ts';
import { scanDeadApis } from '../inventory/dead-scan.ts';
import { SCANNER_VERSION } from '../inventory/scanner-version.ts';
import {
  Budget as MemoryBudget,
  defaultAi,
  defaultMemory,
  memoryDir,
  recordEvidence,
  recordHabits,
  recordVerdict,
  scrubFor,
  shareLearning,
  sharedStore,
  type MemoryDeps,
} from '../memory/index.ts';
import { createBudget, type Budget as RunBudget } from '../orchestrator/budget.ts';
import { repoJobOn } from '../orchestrator/index.ts';
import type { Finding, RunRepoJob } from '../shared/types.ts';
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
import type {
  InstallationTokens,
  RecordEvidence,
  RecordHabits,
  RecordVerdict,
  UnderstandJob,
} from './types.ts';

// A verdict's share of the run while it learns; memory refuses a call whose worst case passes it.
const VERDICT_USD = 1;

let budget: RunBudget | undefined;
// The process's one run: the AI check, the loop and verdicts all spend this cap.
const runBudget = () => (budget ??= createBudget());

let job: RunRepoJob | undefined;
// orchestrator/index.ts's runRepoJob, but on this budget: that one keeps its budget to itself.
const runRepoJob: RunRepoJob = (input) => {
  job ??= repoJobOn(process.env.ANTHROPIC_API_KEY ? runBudget() : undefined);
  return job(input);
};

/** The check's ledger, also drawing on the run's budget, so the check and the loop share one cap. */
export const sharedLedger = (own: BudgetLedger, run: RunBudget): CheckLedger => ({
  assertCanSpend(usd) {
    own.assertCanSpend(usd);
    const free = run.capUsd - run.spentUsd() - run.heldUsd();
    if (usd > free) throw new BudgetExceededError(usd, Math.max(free, 0));
  },
  // The check holds a call's worst case by recording it, then corrects that by a negative amount.
  async record(spend) {
    run.chargeUsd(spend.costUsd);
    return own.record(spend);
  },
});

let ledger: Promise<CheckLedger> | undefined;
// One ledger for the process: with a new one per scan, a rescan of every repo would give each repo's
// AI check the whole cap.
const openLedger = () =>
  (ledger ??= BudgetLedger.fromEnv().then((own) => sharedLedger(own, runBudget())));

const scan = async (dir: string, repo: string) =>
  checkUnclear(await scanDeadApis(dir, repo, { storeDir: PROPOSED_DIR }), dir, { openLedger });

// A send can trigger a model call, so each gets its own cap, as a verdict does.
const EVIDENCE_BUDGET_USD = 1;

const sendEvidence: RecordEvidence = async (pr, evidence, { consented }) => {
  const memory = {
    ...defaultMemory(pr),
    ...defaultAi(process.env, new MemoryBudget(EVIDENCE_BUDGET_USD)),
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

/**
 * Records a verdict on its share of the run. With no cap, or nothing free, the share is $0: the verdict
 * is still stored and memory spends nothing. It never waits, since a verdict is stored only after this.
 */
export const verdictWith =
  (run: RunBudget | undefined, memory: (budget: MemoryBudget) => MemoryDeps): RecordVerdict =>
  async (pr, human) => {
    const hold = await run?.reserve('a verdict', VERDICT_USD, 0);
    const share = new MemoryBudget(hold?.usd ?? 0);
    try {
      const learned = await recordVerdict(pr, human, memory(share));
      console.log(`verdict ${human} ${pr}${learned ? '' : ' (no stored run has this PR)'}`);
    } finally {
      hold?.settle(share.spentUsd);
    }
  };

const hasCap = () => {
  const cap = Number(process.env[BUDGET_ENV]);
  return Number.isFinite(cap) && cap > 0;
};

/** The real verdict recorder, for the server. */
export const createAppVerdict = () =>
  verdictWith(hasCap() ? runBudget() : undefined, (share) => ({
    ...defaultMemory(),
    ...defaultAi(process.env, share),
  }));

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
    spentUsd: () => budget?.spentUsd() ?? 0,
    rescan: rescanWith(evidence),
  });
