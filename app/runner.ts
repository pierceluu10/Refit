import { loadDeadApis } from '../dead-apis/list.ts';
import { PROPOSED_DIR } from '../dead-apis/proposals.ts';
import { BudgetLedger } from '../inventory/budget.ts';
import { checkUnclear } from '../inventory/dead-check.ts';
import { scanDeadApis } from '../inventory/dead-scan.ts';
import { runRepoJob } from '../orchestrator/index.ts';
import { cloneRepo, treeOfCheckout } from './git.ts';
import { headTree } from './github.ts';
import { createJobRunner } from './jobs.ts';
import { createOpenPullRequest } from './pr.ts';
import type { TriggerStore } from './triggers.ts';
import type { InstallationTokens } from './types.ts';

let ledger: Promise<BudgetLedger> | undefined;
// One ledger for the process, as the loop has one budget: with a new one per scan, a rescan of every
// repo would give each repo's AI check the whole cap.
const openLedger = () => (ledger ??= BudgetLedger.fromEnv());

const scan = async (dir: string, repo: string) =>
  checkUnclear(await scanDeadApis(dir, repo, { storeDir: PROPOSED_DIR }), dir, { openLedger });

/** The real job runner, for the server and for a manual rescan. */
export const createAppRunner = (tokens: InstallationTokens, triggers: TriggerStore) =>
  createJobRunner({
    tokens,
    runRepoJob,
    checkout: cloneRepo,
    openPullRequestFor: (installationId) => createOpenPullRequest(tokens, installationId),
    headTree: (token, repo) => headTree(token, repo),
    treeOfCheckout,
    scan,
    loadList: () => loadDeadApis(),
    triggers,
  });
