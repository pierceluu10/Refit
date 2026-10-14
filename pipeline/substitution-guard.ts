import ts from 'typescript-compiler';
import { analyzeRepository } from './analyzer.ts';
import type { ProviderAdapter } from './providers.ts';
import { isObject } from './specifications.ts';
import { PipelineInputError, type Finding, type Removal, type Repository } from './types.ts';

export interface FieldSubstitution {
  schema: string;
  property: string;
  removed: string[];
  file: string;
  line: number;
}

export class FieldSubstitutionError extends PipelineInputError {
  constructor(
    readonly substitutions: FieldSubstitution[],
    readonly proposal: Record<string, unknown>,
  ) {
    super(
      substitutions
        .map(
          (s) =>
            `AI replacement substitutes pre-existing field ${s.schema}.${s.property} for removed ${s.removed.map((name) => `${s.schema}.${name}`).join(', ')} in ${s.file}:${s.line}.`,
        )
        .join(' ') + ' Pre-existing fields may only be passed as arguments to SDK calls.',
    );
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
  return analysis.findings.filter((finding) => {
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
      substitutions.push({
        schema: field.schema,
        property: field.property,
        removed: changes.filter((c) => c.schema === field.schema).map((c) => c.property),
        file,
        line: introduced.line,
      });
    }
  return substitutions;
}
