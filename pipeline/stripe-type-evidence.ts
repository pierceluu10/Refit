import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { labelReads, SOURCE, stripeTypesEntry } from './stripe-ground-truth.ts';
import type { Finding, Removal, Repository } from './types.ts';

// Removed-field reads whose receiver TypeScript's checker resolves to a Stripe object, using the
// application's own stripe type definitions and the ground-truth oracle's resolver. Type evidence
// only confirms that code reads a removed field; casts can lie, so these findings carry
// `typeEvidence` and stop automatic migration for review (pipeline/migration-review.ts).

// The checker builds a full program per tsconfig project; larger repositories are left to the
// analyzer's own evidence.
const MAX_TYPED_FILES = 2_000;

const metadata = JSON.parse(
  readFileSync(new URL('./stripe-sdk-metadata.json', import.meta.url), 'utf8'),
) as { classes: Record<string, string> };
const classSchemas = new Map(Object.entries(metadata.classes));

// An explicit stripe package directory, else the one the repository has installed.
export function stripePackageDirectory(repositoryRoot: string, explicit?: string) {
  const directory = explicit ?? join(repositoryRoot, 'node_modules', 'stripe');
  if (!existsSync(join(directory, 'package.json'))) return undefined;
  try {
    const entry = stripeTypesEntry(directory);
    return existsSync(entry.ambient ?? entry.module) ? directory : undefined;
  } catch {
    return undefined;
  }
}

export function addTypeEvidence(
  repository: Repository,
  changes: Removal[],
  findings: Finding[],
  stripePackage: string,
) {
  const files = repository.files
    .map((file) => file.path)
    .filter((path) => SOURCE.test(path) && !path.endsWith('.d.ts'));
  if (!files.length || files.length > MAX_TYPED_FILES) return;
  const removed = new Map<string, Set<string>>();
  for (const change of changes)
    removed.set(change.property, (removed.get(change.property) ?? new Set()).add(change.schema));
  const reads = labelReads({
    repository: repository.root,
    stripePackage,
    removed,
    classSchemas,
    files: files.map((path) => resolve(repository.root, path)),
  });
  for (const read of reads) {
    if (read.label !== 'breaking') continue;
    for (const change of changes) {
      if (change.property !== read.property || !read.schemas.includes(change.schema)) continue;
      const existing = findings.find(
        (finding) =>
          finding.file === read.file &&
          finding.line === read.start.line &&
          finding.column === read.start.column &&
          finding.changeId === change.id &&
          finding.expression === `.${read.property}`,
      );
      if (existing?.confidence === 'confirmed') continue;
      const typeEvidence = {
        receiverTypes: read.receiverTypes,
        ...(read.asserted ? { asserted: true as const } : {}),
      };
      const reason = `TypeScript resolves this receiver to ${read.receiverTypes.join(' | ')}, whose ${change.schema}.${change.property} the target API version removes${read.asserted ? '; the type comes from a type assertion, which may not match the runtime object' : ''}. Type evidence does not establish SDK or incoming-event provenance; inspect manually.`;
      if (existing) {
        existing.confidence = 'confirmed';
        existing.typeEvidence = typeEvidence;
        existing.reason = reason;
        delete existing.untraced;
      } else
        findings.push({
          file: read.file,
          line: read.start.line,
          column: read.start.column,
          changeId: change.id,
          expression: `.${read.property}`,
          confidence: 'confirmed',
          typeEvidence,
          reason,
        });
    }
  }
}
