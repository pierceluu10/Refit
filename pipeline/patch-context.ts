import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { createSourceImportResolver } from './source-imports.ts';
import { sourceModuleReferences } from './source-modules.ts';
import { PipelineInputError, type Repository } from './types.ts';

const MAX_CONTEXT_FILES = 12;

export function buildPatchContext(repository: Repository, editable: Set<string>) {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file]),
  );
  const resolution = createSourceImportResolver(repository, sources);
  const pending = repository.files.filter((file) => editable.has(file.path));
  const visited = new Set(pending.map((file) => file.path));
  const context: Repository['files'] = [];
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index];
    const path = resolve(repository.root, file.path);
    const source = ts.createSourceFile(path, file.content, ts.ScriptTarget.Latest, true);
    for (const name of sourceModuleReferences(source)) {
      const imported = resolution.resolve(name, path);
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
  if (resolution.unverified)
    throw new PipelineInputError(
      'AI imported source context has unverified or ambiguous repository alias configuration.',
    );
  return context;
}
