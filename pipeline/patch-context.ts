import { resolve } from 'node:path';
import ts from 'typescript-compiler';
import { createSourceImportResolver } from './source-imports.ts';
import { sourceModuleReferences } from './source-modules.ts';
import { PipelineInputError, type Repository } from './types.ts';

// The input limit binds before this does once modules are large (MAX_INPUT_BYTES).
export const MAX_CONTEXT_FILES = 24;

// Imported modules the editable files reach, nearest first. Past MAX_CONTEXT_FILES it refuses,
// unless `nearest`, which keeps the nearest ones and leaves the rest out, and then adds the files
// that import an editable file (its callers), which show where its values come from.
export function buildPatchContext(repository: Repository, editable: Set<string>, nearest = false) {
  const sources = new Map(
    repository.files.map((file) => [resolve(repository.root, file.path), file]),
  );
  const resolution = createSourceImportResolver(repository, sources);
  const references = (file: Repository['files'][number]) => {
    const path = resolve(repository.root, file.path);
    const source = ts.createSourceFile(path, file.content, ts.ScriptTarget.Latest, true);
    return [...sourceModuleReferences(source)].map((name) => {
      const imported = resolution.resolve(name, path);
      return imported && sources.get(imported);
    });
  };
  const pending = repository.files.filter((file) => editable.has(file.path));
  const visited = new Set(pending.map((file) => file.path));
  const context: Repository['files'] = [];
  files: for (let index = 0; index < pending.length; index++) {
    for (const target of references(pending[index])) {
      if (!target || visited.has(target.path)) continue;
      if (context.length >= MAX_CONTEXT_FILES) {
        if (nearest) break files;
        throw new PipelineInputError(
          `AI patch context exceeds ${MAX_CONTEXT_FILES} imported source files; narrow the repository scope.`,
        );
      }
      visited.add(target.path);
      pending.push(target);
      context.push(target);
    }
  }
  // Only the editable files' own imports decide whether alias resolution is trustworthy; a caller
  // whose imports do not resolve is simply not found.
  const unverified = resolution.unverified;
  if (nearest)
    for (const file of repository.files) {
      if (context.length >= MAX_CONTEXT_FILES) break;
      if (visited.has(file.path)) continue;
      if (references(file).some((target) => (target ? editable.has(target.path) : false))) {
        visited.add(file.path);
        context.push(file);
      }
    }
  if (unverified)
    throw new PipelineInputError(
      'AI imported source context has unverified or ambiguous repository alias configuration.',
    );
  return context;
}
