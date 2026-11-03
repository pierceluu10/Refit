import type { RunRepoJob } from '../shared/types.ts';
import type { ListRunViews } from './types.ts';

// shortcut: runs nothing until the orchestrator's runRepoJob merges (#472, r2/orchestrator); then
// main.ts imports `runRepoJob` from '../orchestrator/index.ts' and this goes.
export const runRepoJob: RunRepoJob = async ({ repo }) => {
  console.log(`orchestrator runRepoJob not merged yet; nothing ran for ${repo}`);
  return [];
};

// shortcut: no runs until memory's listRunViews merges (#473, r2/memory); then main.ts imports
// `listRunViews` from '../memory/index.ts' and this goes.
export const listRunViews: ListRunViews = async () => [];
