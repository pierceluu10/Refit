import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationKind } from '../../shared/types.ts';

export const MIGRATION_KINDS: readonly MigrationKind[] = [
  'api-version',
  'sdk-major',
  'field-removed',
  'field-renamed',
  'endpoint-removed',
  'rest-to-graphql',
  'auth-change',
  'webhook-payload',
  'model-retirement',
  'product-shutdown',
  'pagination-or-limits',
  'other',
];

export function isMigrationKind(value: string): value is MigrationKind {
  return (MIGRATION_KINDS as readonly string[]).includes(value);
}

export type FrontMatter = Record<string, string>;

/** Parse a simple `key: value` YAML front matter block. Returns the body without it. */
export function parseFrontMatter(markdown: string): { meta: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { meta: {}, body: markdown.trim() };
  const meta: FrontMatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body: markdown.slice(match[0].length).trim() };
}

function toPath(dir: string | URL): string {
  return dir instanceof URL ? fileURLToPath(dir) : dir;
}

/**
 * Load `<kind>.md` files from a playbooks directory into `ToolPack.playbooks`.
 * Front matter is stripped from the injected text. Files whose names are not a MigrationKind are ignored.
 */
export function loadPlaybooks(dir: string | URL): Partial<Record<MigrationKind, string>> {
  const path = toPath(dir);
  const playbooks: Partial<Record<MigrationKind, string>> = {};
  if (!existsSync(path)) return playbooks;
  for (const file of readdirSync(path).sort()) {
    if (!file.endsWith('.md')) continue;
    const kind = file.slice(0, -3);
    if (!isMigrationKind(kind)) continue;
    const { body } = parseFrontMatter(readFileSync(join(path, file), 'utf8'));
    if (body) playbooks[kind] = body;
  }
  return playbooks;
}

/** Front matter of every playbook, for review tooling and tests. */
export function loadPlaybookMeta(dir: string | URL): Record<string, FrontMatter> {
  const path = toPath(dir);
  const result: Record<string, FrontMatter> = {};
  if (!existsSync(path)) return result;
  for (const file of readdirSync(path).sort()) {
    if (!file.endsWith('.md')) continue;
    result[file.slice(0, -3)] = parseFrontMatter(readFileSync(join(path, file), 'utf8')).meta;
  }
  return result;
}
