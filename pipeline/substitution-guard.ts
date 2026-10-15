import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import type { ProviderAdapter } from './providers.ts';
import { findAddedProperties, isObject } from './specifications.ts';
import { PipelineInputError, type Finding, type Removal, type Repository } from './types.ts';

export interface FieldSubstitution {
  kind: 'pre-existing' | 'type-mismatch' | 'fallback';
  schema: string;
  property: string;
  removed: string[];
  file: string;
  line: number;
  message: string;
}

// Rejects AI patches that replace removed fields without evidence; see docs/AI-PATCH-GUARD.md.
export class FieldSubstitutionError extends PipelineInputError {
  constructor(
    readonly substitutions: FieldSubstitution[],
    readonly proposal: Record<string, unknown>,
  ) {
    super(substitutions.map((substitution) => substitution.message).join(' '));
  }
}

// Fields of each affected schema that survive the change; removed fields come from `changes`.
function preExistingFields(changes: Removal[], schemas: Record<string, unknown>): Removal[] {
  const fields: Removal[] = [];
  for (const schema of [...new Set(changes.map((change) => change.schema))]) {
    const definition = schemas[schema];
    if (!isObject(definition) || !isObject(definition.properties)) continue;
    const removed = new Set(changes.filter((c) => c.schema === schema).map((c) => c.property));
    for (const property of Object.keys(definition.properties))
      if (!removed.has(property))
        fields.push({
          id: `substitution-guard:${schema}:${property}`,
          schema,
          property,
          pointer: `/components/schemas/${schema}/properties/${property}`,
        });
  }
  return fields;
}

// Reads of pre-existing fields that are not inside the arguments of a traced SDK call.
function substituteReads(
  repository: Repository,
  fields: Removal[],
  provider: ProviderAdapter,
  schemas: Record<string, unknown>,
  files: Set<string>,
): Finding[] {
  const analysis = analyzeRepository(repository, fields, provider, schemas);
  const argumentRanges = new Map<string, Array<[number, number]>>();
  const sources = new Map<string, ts.SourceFile>();
  for (const file of repository.files) {
    if (!files.has(file.path)) continue;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    sources.set(file.path, source);
    const callStarts = new Set(
      analysis.sdkCalls
        .filter((call) => call.file === file.path)
        .map((call) => source.getPositionOfLineAndCharacter(call.line - 1, call.column - 1)),
    );
    const ranges: Array<[number, number]> = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && callStarts.has(node.getStart()))
        ranges.push([node.arguments.pos, node.arguments.end]);
      ts.forEachChild(node, visit);
    };
    visit(source);
    argumentRanges.set(file.path, ranges);
  }
  // Only reads traced to the field's own object can substitute for it; same-named reads on
  // unresolved receivers prove nothing.
  return analysis.findings.filter((finding) => {
    if (finding.confidence !== 'confirmed') return false;
    const source = sources.get(finding.file);
    if (!source) return false;
    const position = source.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
    return !argumentRanges
      .get(finding.file)!
      .some(([start, end]) => position >= start && position < end);
  });
}

export function findFieldSubstitutions(
  original: Repository,
  modified: Repository,
  changes: Removal[],
  provider: ProviderAdapter,
  schemas: Record<string, unknown>,
  editedFiles: Set<string>,
): FieldSubstitution[] {
  const fields = preExistingFields(changes, schemas);
  if (!fields.length) return [];
  const before = substituteReads(original, fields, provider, schemas, editedFiles);
  const after = substituteReads(modified, fields, provider, schemas, editedFiles);
  const substitutions: FieldSubstitution[] = [];
  for (const field of fields)
    for (const file of editedFiles) {
      const matches = (finding: Finding) => finding.file === file && finding.changeId === field.id;
      // Counting per file and field ignores existing reads that merely moved lines.
      const added = after.filter(matches);
      if (added.length <= before.filter(matches).length) continue;
      const originalLines = new Set(
        original.files
          .find((candidate) => candidate.path === file)
          ?.content.split('\n')
          .map((line) => line.trim()),
      );
      const modifiedLines =
        modified.files.find((candidate) => candidate.path === file)?.content.split('\n') ?? [];
      const introduced =
        added.find((finding) => !originalLines.has(modifiedLines[finding.line - 1]?.trim())) ??
        added[0];
      const removed = changes.filter((c) => c.schema === field.schema).map((c) => c.property);
      substitutions.push({
        kind: 'pre-existing',
        schema: field.schema,
        property: field.property,
        removed,
        file,
        line: introduced.line,
        message: `AI replacement substitutes pre-existing field ${field.schema}.${field.property} for removed ${removed.map((name) => `${field.schema}.${name}`).join(', ')} in ${file}:${introduced.line}. Pre-existing fields may only be passed as arguments to SDK calls.`,
      });
    }
  return substitutions;
}

function propertyType(schemas: Record<string, unknown>, schema: string, property: string) {
  const definition = schemas[schema];
  if (!isObject(definition) || !isObject(definition.properties)) return undefined;
  const value = definition.properties[property];
  return isObject(value) && typeof value.type === 'string' ? value.type : undefined;
}

function readsByFile(findings: Finding[], file: string, changeId: string) {
  return findings.filter((finding) => finding.file === file && finding.changeId === changeId);
}

// Rule 4: an added field must have a removed field's type unless documented as its replacement.
// Rule 5: an edited file may not keep reading a removed field without reading any added field.
export function findUnsafeReplacements(
  original: Repository,
  modified: Repository,
  changes: Removal[],
  provider: ProviderAdapter,
  beforeSchemas: Record<string, unknown>,
  afterSchemas: Record<string, unknown>,
  editedFiles: Set<string>,
  notes: readonly string[],
): FieldSubstitution[] {
  const added = findAddedProperties(beforeSchemas, afterSchemas, changes);
  const addedFields: Removal[] = added.map((entry) => ({
    id: `added-field-guard:${entry.schema}:${entry.property}`,
    schema: entry.schema,
    property: entry.property,
    pointer: `/components/schemas/${entry.schema}/properties/${entry.property}`,
  }));
  const before = analyzeRepository(original, addedFields, provider, afterSchemas).findings;
  const after = analyzeRepository(modified, addedFields, provider, afterSchemas).findings;
  const remaining = analyzeRepository(modified, changes, provider, beforeSchemas).findings;
  const violations: FieldSubstitution[] = [];
  for (const file of editedFiles) {
    const introduced = addedFields.filter(
      (field) =>
        readsByFile(after, file, field.id).length > readsByFile(before, file, field.id).length,
    );
    for (const field of introduced) {
      const entry = added.find(
        (candidate) => candidate.schema === field.schema && candidate.property === field.property,
      )!;
      const removed = changes.filter((change) => change.schema === field.schema);
      const removedTypes = removed.map((change) =>
        propertyType(beforeSchemas, change.schema, change.property),
      );
      if (!entry.type || removedTypes.some((type) => !type || type === entry.type)) continue;
      const documented = removed.some(
        (change) =>
          entry.description?.includes(change.property) ||
          notes.some((note) => note.includes(change.property) && note.includes(field.property)),
      );
      if (documented) continue;
      const line = readsByFile(after, file, field.id)[0].line;
      violations.push({
        kind: 'type-mismatch',
        schema: field.schema,
        property: field.property,
        removed: removed.map((change) => change.property),
        file,
        line,
        message: `AI replacement reads added field ${field.schema}.${field.property} (${entry.type}) in place of removed ${removed.map((change, index) => `${change.schema}.${change.property} (${removedTypes[index]})`).join(', ')} in ${file}:${line}. Added fields must have the removed field's type unless the contract or a vendor note documents the replacement.`,
      });
    }
    // Only traced reads on lines the model wrote count; untouched reads elsewhere in the file are
    // other findings, not a fallback it introduced.
    const originalLines = new Set(
      original.files
        .find((candidate) => candidate.path === file)
        ?.content.split('\n')
        .map((line) => line.trim()),
    );
    const modifiedLines =
      modified.files.find((candidate) => candidate.path === file)?.content.split('\n') ?? [];
    const leftover = remaining.find(
      (finding) =>
        finding.file === file &&
        finding.confidence === 'confirmed' &&
        !originalLines.has(modifiedLines[finding.line - 1]?.trim()) &&
        changes.some((change) => change.id === finding.changeId),
    );
    if (leftover && !introduced.length) {
      const change = changes.find((candidate) => candidate.id === leftover.changeId)!;
      violations.push({
        kind: 'fallback',
        schema: change.schema,
        property: change.property,
        removed: [change.property],
        file,
        line: leftover.line,
        message: `AI replacement still reads removed field ${change.schema}.${change.property} in ${file}:${leftover.line} without reading any added field. A fallback on a removed field hides the break instead of migrating it.`,
      });
    }
  }
  return violations;
}
