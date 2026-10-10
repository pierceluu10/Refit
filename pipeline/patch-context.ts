import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { resolveSourceImport } from './source-imports.ts';
import { PipelineInputError, type Repository } from './types.ts';

const MAX_CONTEXT_FILES = 12;

export function buildPatchContext(repository: Repository, editable: Set<string>) {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file]),
  );
  const pending = repository.files.filter((file) => editable.has(file.path));
  const visited = new Set(pending.map((file) => file.path));
  const context: Repository['files'] = [];
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index];
    const path = resolve(repository.root, file.path);
    const source = ts.createSourceFile(path, file.content, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const imported = resolveSourceImport(statement.moduleSpecifier.text, path, sources);
      const target = imported && sources.get(imported);
      if (!target || visited.has(target.path)) continue;
      if (context.length >= MAX_CONTEXT_FILES)
        throw new PipelineInputError(
          'AI patch context exceeds 12 imported source files; narrow the repository scope.',
        );
      visited.add(target.path);
      pending.push(target);
      context.push(target);
    }
  }
  return context;
}
