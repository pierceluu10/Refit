// Upgrade tools and playbooks for the harness agent. Tools return information and never block; the
// agent decides what to do with it.

import type { AgentTool } from '../../shared/types.ts';
import { createActionVersionsTool } from './actions.ts';
import { createDockerImageTagsTool } from './docker.ts';
import { createEndOfLifeTool } from './end-of-life.ts';
import { createModelReplacementTool } from './models.ts';
import type { UpgradeToolOptions } from './options.ts';
import { createCodemodTool, createMigrationGuideTool, createRegistryDiffTool } from './packages.ts';

export { SPECIFICS, UPGRADE_KINDS, specificFor, upgradePlaybook } from './playbooks.ts';
export type { UpgradeToolOptions } from './options.ts';

/** Every upgrade tool, with its network options. Tests pass a recorded fetch and a fixed clock. */
export function createUpgradeTools(options: UpgradeToolOptions = {}): AgentTool[] {
  return [
    createEndOfLifeTool(options),
    createMigrationGuideTool(options),
    createRegistryDiffTool(options),
    createCodemodTool(options),
    createModelReplacementTool(options),
    createActionVersionsTool(options),
    createDockerImageTagsTool(options),
  ];
}

export const upgradeTools: AgentTool[] = createUpgradeTools();
export const [
  endOfLife,
  migrationGuide,
  registryDiff,
  codemod,
  modelReplacement,
  actionVersions,
  dockerImageTags,
] = upgradeTools;
