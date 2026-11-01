import type { AgentTool, ToolPack } from '../../shared/types.ts';
import type { NetworkOptions } from './fetch.ts';
import { loadPlaybooks } from './playbooks.ts';
import { createSearchDocsTool, type SearchDocsOptions } from './searchDocs.ts';

export * from './fetch.ts';
export * from './playbooks.ts';
export * from './searchDocs.ts';
export * from './text.ts';
export * from './tool.ts';

export type ToolPackOptions = NetworkOptions & { searchDocs?: SearchDocsOptions };

/**
 * Assemble a provider ToolPack: the provider's own tools, its searchDocs tool and its playbooks.
 * `playbooksDir` is usually `new URL('./playbooks/', import.meta.url)` from the provider's tools.ts.
 */
export function assembleToolPack(spec: {
  provider: string;
  tools: AgentTool[];
  playbooksDir: string | URL;
  options?: ToolPackOptions;
}): ToolPack {
  const { fetch, timeoutMs, searchDocs } = spec.options ?? {};
  const network: NetworkOptions = {};
  if (fetch !== undefined) network.fetch = fetch;
  if (timeoutMs !== undefined) network.timeoutMs = timeoutMs;
  return {
    provider: spec.provider,
    tools: [...spec.tools, createSearchDocsTool(spec.provider, { ...network, ...searchDocs })],
    playbooks: loadPlaybooks(spec.playbooksDir),
  };
}
