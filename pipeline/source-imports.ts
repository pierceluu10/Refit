import { dirname, extname, resolve } from 'node:path';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const OUTPUT_EXTENSIONS: Record<string, string> = {
  '.js': '.ts',
  '.jsx': '.tsx',
  '.mjs': '.mts',
  '.cjs': '.cts',
};

export function resolveSourceImport(
  name: string,
  containingFile: string,
  sources: ReadonlyMap<string, unknown>,
): string | undefined {
  if (!name.startsWith('./') && !name.startsWith('../')) return;
  const path = resolve(dirname(containingFile), name);
  const extension = extname(path);
  const candidates = extension
    ? [
        path,
        ...(OUTPUT_EXTENSIONS[extension]
          ? [path.slice(0, -extension.length) + OUTPUT_EXTENSIONS[extension]]
          : []),
      ]
    : SOURCE_EXTENSIONS.flatMap((suffix) => [path + suffix, resolve(path, `index${suffix}`)]);
  const matches = candidates.filter((candidate) => sources.has(candidate));
  return matches.length === 1 ? matches[0] : undefined;
}
