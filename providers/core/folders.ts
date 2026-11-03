// Provider folders. Any folder under providers/ with a provider.json and a prompt.md is a provider:
// provider.json names it and gives hints (and, optionally, starting pages), prompt.md says how it
// versions and announces changes. No code changes are needed to add one.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderHints } from '../../shared/types.ts';
import type { LoadedProvider, ProviderKnowledge, ProviderSpec } from './types.ts';

export const PROVIDERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const ID = /^[a-z0-9][a-z0-9-]*$/;

export function listProviderIds(root = PROVIDERS_DIR): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID.test(entry.name))
    .filter((entry) => existsSync(join(root, entry.name, 'provider.json')))
    .map((entry) => entry.name)
    .sort();
}

export function loadProvider(id: string, root = PROVIDERS_DIR): LoadedProvider {
  if (!ID.test(id)) throw new Error(`bad provider id: ${id}`);
  const dir = join(root, id);
  const spec = JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8')) as ProviderSpec;
  if (spec.id !== id)
    throw new Error(`${id}/provider.json has id "${spec.id}"; it must match the folder`);
  const promptPath = join(dir, 'prompt.md');
  const knowledgePath = join(dir, 'knowledge.json');
  return {
    ...spec,
    sources: spec.sources ?? [],
    dir,
    prompt: existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '',
    knowledge: existsSync(knowledgePath)
      ? (JSON.parse(readFileSync(knowledgePath, 'utf8')) as ProviderKnowledge)
      : undefined,
  };
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** Hints from several places as one, each list without repeats; empty lists are left out. */
export function mergeHints(...all: ProviderHints[]): ProviderHints {
  const merged: ProviderHints = {};
  for (const key of ['packages', 'hosts', 'docsUrls'] as const) {
    const values = unique(all.flatMap((hints) => hints[key] ?? []));
    if (values.length) merged[key] = values;
  }
  return merged;
}

/**
 * What a folder tells the discovery step: provider.json's hints, plus the SDKs
 * and docs knowledge.json names. SDKs keep their registry ("npm:octokit"), so a
 * name is not looked up where it means something else; Go module paths lead to
 * their repository's releases. Other ecosystems are not looked up yet.
 */
export function folderHints(provider: LoadedProvider): ProviderHints {
  const sdks = (provider.knowledge?.sdks ?? []).flatMap((sdk) => {
    const ecosystem = sdk.ecosystem.toLowerCase();
    if (ecosystem === 'npm' || ecosystem === 'pypi') return [`${ecosystem}:${sdk.package}`];
    if (ecosystem === 'go') return [sdk.package];
    return [];
  });
  return mergeHints(provider.hints ?? {}, {
    packages: sdks,
    docsUrls: (provider.knowledge?.docs ?? []).map((doc) => doc.url),
  });
}
