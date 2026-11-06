// Anthropic tool pack: the shared model_replacement tool, its docs search and its playbook.

import type { ToolPack } from '../../shared/types.ts';
import { assembleToolPack, type ToolPackOptions } from '../toolkit/index.ts';
import { createModelReplacementTool } from '../upgrades/models.ts';

export function createToolPack(options?: ToolPackOptions): ToolPack {
  return assembleToolPack({
    provider: 'anthropic',
    tools: [createModelReplacementTool(options)],
    playbooksDir: new URL('./playbooks/', import.meta.url),
    options,
  });
}

export const toolPack: ToolPack = createToolPack();
