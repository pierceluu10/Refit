// A version move reaches every call in the repo, not only the lines the list names. Plain code runs
// the provider's validator over the repo's GraphQL documents, so the session starts from facts: told
// only to look, it skipped the search and wrote that the repo had none (round 7, ksyp-7).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolPack } from '../shared/types.ts';
import type { Sandbox } from './types.ts';

const MAX_FILES = 200;
// The other errors can come from a stripped interpolation, such as a fragment or a variable's value.
const GONE = /does not exist|^Unknown (type|argument)/;
// shortcut: template literals only. A .graphql file or a concatenated document is the session's to find.
const DOCUMENT = /(storefront\.)?graphql\(\s*`([\s\S]*?)`|`\s*#graphql([\s\S]*?)`/g;
const FILES = [
  `grep -rlE '#graphql|graphql\\(' .`,
  ...['ts', 'tsx', 'js', 'jsx', 'mjs'].map((type) => `--include='*.${type}'`),
  ...['node_modules', 'build', 'dist', '.next', 'types'].map((dir) => `--exclude-dir=${dir}`),
].join(' ');

// A Storefront query is left out: the validators read the Admin schema, which can't judge it.
export function graphqlDocuments(text: string): string[] {
  return [...text.matchAll(DOCUMENT)]
    .filter(([, storefront]) => !storefront)
    .map(([, , called, tagged]) => (called ?? tagged ?? '').replace('#graphql', ''))
    .map((document) => document.replace(/\$\{[^}]*\}/g, ''))
    .filter((document) => /\b(query|mutation)\b|^\s*\{/.test(document));
}

export async function deadDocuments(sandbox: Sandbox, toolPack: ToolPack): Promise<string[]> {
  const validator = toolPack.tools.find((tool) => tool.name.endsWith('_validate_graphql'));
  if (!validator) return [];
  const found = await sandbox.exec(FILES, { timeoutMs: 60_000 });
  const dead = new Set<string>();
  for (const file of found.stdout.split('\n').filter(Boolean).slice(0, MAX_FILES)) {
    const text = await readFile(path.join(sandbox.dir, file), 'utf8').catch(() => '');
    for (const query of graphqlDocuments(text)) {
      const report = await validator.run({ query }, { repoDir: sandbox.dir });
      for (const line of report.split('\n')) {
        const error = line.match(/\berror: (.+)$/)?.[1];
        if (error && GONE.test(error)) dead.add(`${path.normalize(file)}: ${error}`);
      }
    }
  }
  return [...dead];
}
