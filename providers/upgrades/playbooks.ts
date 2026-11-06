// Upgrade playbooks: advice injected into the agent's prompt. Choosing a specific playbook for a
// dependency only adds context; a dependency with none still gets its kind's playbook.

import { existsSync, readFileSync } from 'node:fs';
import { parseFrontMatter } from '../toolkit/index.ts';

export const UPGRADE_KINDS = [
  'runtime-eol',
  'framework-major',
  'dependency-major',
  'security-fix',
  'container-image-eol',
  'ci-deprecation',
  'model-retirement',
] as const;
export const SPECIFICS = ['node', 'python', 'nextjs', 'django'] as const;

function read(path: string): string | undefined {
  const url = new URL(`./playbooks/${path}.md`, import.meta.url);
  return existsSync(url) ? parseFrontMatter(readFileSync(url, 'utf8')).body : undefined;
}

// "node:18-bookworm" and "nodejs" are node; "next" is nextjs.
export function specificFor(dependency: string): (typeof SPECIFICS)[number] | undefined {
  const name = dependency.toLowerCase().split(/[:@]/)[0].split('/').pop() ?? '';
  if (/^node(\.?js)?$/.test(name)) return 'node';
  if (/^(c?python\d*)$/.test(name)) return 'python';
  if (/^next(\.?js)?$/.test(name)) return 'nextjs';
  if (name === 'django') return 'django';
  return undefined;
}

/** The playbook for a change kind, plus the specifics for its dependency when there are any. */
export function upgradePlaybook(kind: string, dependency?: string): string {
  const specific = dependency ? specificFor(dependency) : undefined;
  return [read(kind), specific ? read(`specifics/${specific}`) : undefined]
    .filter(Boolean)
    .join('\n\n');
}
