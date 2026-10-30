import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocumentationSnapshots, type CapturedDocumentation } from './documentation-sources.ts';
import { saveStripeContract, stripeContractVersions } from './enrollment-contracts.ts';
import { compareOpenApi } from './openapi-diff.ts';
import { parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

const DIFF_TIMEOUT_MS = 10 * 60_000;

// Saved Stripe changelog pages, one directory per API version (or release) they belong to.
export const STRIPE_PAGES = fileURLToPath(
  new URL('../docs/benchmarks/stripe-changelog/pages/', import.meta.url),
);

// The pinned API version before `version` in data/stripe-openapi-versions.json.
export function previousStripeVersion(version: string) {
  const versions = stripeContractVersions().map((entry) => entry.version);
  const index = versions.indexOf(version);
  if (index < 1)
    throw new PipelineInputError(
      `${version} has no earlier pinned Stripe contract in data/stripe-openapi-versions.json.`,
    );
  return versions[index - 1];
}

// Both pinned contracts of a version change, read from (or saved to) the contracts directory with
// their recorded hashes checked, and the oasdiff changelog between them.
export async function versionEvidence(version: string, contracts: string) {
  const previous = previousStripeVersion(version);
  const [before, after] = await Promise.all(
    [previous, version].map(async (name) => {
      const { path, content } = await saveStripeContract(contracts, name);
      return parseObject(parseObject(content, path).content as string, path);
    }),
  );
  const diff = await compareOpenApi(before, after, { timeoutMs: DIFF_TIMEOUT_MS });
  return { previous, before, after, diff: diff.changes, oasdiff: diff.version };
}

// Every saved changelog page, by its URL without `.md`, each checked against its recorded hash.
export async function capturedPages(directory = STRIPE_PAGES) {
  const paths: string[] = [];
  for (const group of await readdir(directory, { withFileTypes: true }))
    if (group.isDirectory())
      for (const file of await readdir(join(directory, group.name)))
        if (file.endsWith('.json')) paths.push(join(directory, group.name, file));
  const pages = new Map<string, CapturedDocumentation>();
  // readDocumentationSnapshots reads at most 8 at a time.
  for (let index = 0; index < paths.length; index += 8)
    for (const page of await readDocumentationSnapshots(paths.slice(index, index + 8)))
      pages.set(page.url.replace(/\.md$/, ''), page);
  return pages;
}
