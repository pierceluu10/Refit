import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type ts from 'typescript-compiler';
import { sourceConfigurationOptions } from './source-configurations.ts';
import type { Repository } from './types.ts';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const OUTPUT_EXTENSIONS: Record<string, string> = {
  '.js': '.ts',
  '.jsx': '.tsx',
  '.mjs': '.mts',
  '.cjs': '.cts',
};
// A rooted asset import (`/images/logo.png`) is served by the bundler's public directory; it is
// never a module and TypeScript does not resolve rooted names through paths or baseUrl.
function rootedAsset(name: string) {
  const extension = extname(name);
  return name.startsWith('/') && Boolean(extension) && !SOURCE_EXTENSIONS.includes(extension);
}

function sourceMatches(path: string, sources: ReadonlyMap<string, unknown>) {
  const extension = extname(path);
  // `./shopify.server` or `./stripe.client` name a module whose dotted suffix is not an extension.
  const candidates = SOURCE_EXTENSIONS.includes(extension)
    ? [
        path,
        ...(OUTPUT_EXTENSIONS[extension]
          ? [path.slice(0, -extension.length) + OUTPUT_EXTENSIONS[extension]]
          : []),
      ]
    : [
        ...(extension ? [path] : []),
        ...SOURCE_EXTENSIONS.flatMap((suffix) => [path + suffix, resolve(path, `index${suffix}`)]),
      ];
  return candidates.filter((candidate) => sources.has(candidate));
}

export function resolveSourceImport(
  name: string,
  containingFile: string,
  sources: ReadonlyMap<string, unknown>,
): string | undefined {
  if (!name.startsWith('./') && !name.startsWith('../')) return;
  const matches = sourceMatches(resolve(dirname(containingFile), name), sources);
  return matches.length === 1 ? matches[0] : undefined;
}

function matchingPath(name: string, paths: ts.MapLike<string[]> | undefined) {
  if (!paths) return;
  if (Object.hasOwn(paths, name)) return { targets: paths[name], captured: undefined };
  let longest = -1;
  let match: { targets: string[]; captured: string | undefined } | undefined;
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    if (star < 0 || star <= longest) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      name.startsWith(prefix) &&
      name.endsWith(suffix) &&
      name.length >= prefix.length + suffix.length
    ) {
      longest = star;
      match = { targets, captured: name.slice(star, name.length - suffix.length) };
    }
  }
  return match;
}

export function createSourceImportResolver(
  repository: Repository,
  sources: ReadonlyMap<string, unknown>,
) {
  const configuration = sourceConfigurationOptions(repository);
  const root = resolve(repository.root);
  let unsafe = configuration.unverified;
  const warnings = new Set(configuration.warnings);
  const exclusions = (repository.excludedPaths ?? []).map((name) => resolve(root, name));
  function excludedPath(path: string) {
    return exclusions.some((entry) => path === entry || path.startsWith(entry + '/'));
  }
  function declarationFile(path: string) {
    const declaration = path.replace(/\.(?:[cm]?[jt]sx?)$/, '');
    return exclusions.some(
      (entry) =>
        ['.d.ts', '.d.mts', '.d.cts'].some((suffix) => entry === resolve(path, 'index' + suffix)) ||
        ['.d.ts', '.d.mts', '.d.cts'].some((suffix) => entry === declaration + suffix),
    );
  }
  function excluded(path: string) {
    return excludedPath(path) || declarationFile(path);
  }
  function inside(path: string) {
    const name = relative(root, path);
    return name !== '..' && !name.startsWith('../') && !isAbsolute(name);
  }
  for (const [file, options] of configuration.options) {
    if (!options) continue;
    const base = options.baseUrl ?? options.pathsBasePath;
    if (
      (options.baseUrl && !inside(options.baseUrl)) ||
      (options.paths &&
        Object.entries(options.paths).some(
          ([pattern, targets]) =>
            pattern.split('*').length > 2 ||
            !Array.isArray(targets) ||
            !targets.length ||
            targets.some(
              (target) =>
                typeof target !== 'string' ||
                target.split('*').length > 2 ||
                !base ||
                !inside(resolve(String(base), target)) ||
                excluded(resolve(String(base), target)),
            ),
        ))
    ) {
      configuration.options.set(file, null);
      unsafe = true;
      warnings.add(
        'Source alias resolution requires valid single-wildcard paths and targets inside the scanned repository. Shared clients require review.',
      );
    }
  }
  function resolveImport(name: string, file: string) {
    if (name.startsWith('./') || name.startsWith('../'))
      return resolveSourceImport(name, file, sources);
    const options = configuration.options.get(file);
    if (!options || rootedAsset(name)) return;
    const match = matchingPath(name, options.paths);
    const base = options.baseUrl ?? options.pathsBasePath;
    const targets =
      match && base
        ? match.targets.map((target) =>
            resolve(String(base), match.captured ? target.replace('*', match.captured) : target),
          )
        : [];
    if (options.baseUrl) targets.push(resolve(options.baseUrl, name));
    for (const [index, target] of targets.entries()) {
      const matches = inside(target) ? sourceMatches(target, sources) : [];
      if (matches.length > 1) {
        unsafe = true;
        warnings.add('Ambiguous source alias target; shared clients require review.');
        return;
      }
      // A scanned runtime module wins over a sibling declaration file, as with relative imports.
      if (matches.length === 1) return matches[0];
      // A declaration file beside scanned sources only provides types, unless a later fallback
      // holds a runtime module that a bundler would load instead.
      if (
        inside(target) &&
        !excludedPath(target) &&
        declarationFile(target) &&
        !targets
          .slice(index + 1)
          .some((later) => inside(later) && sourceMatches(later, sources).length)
      )
        return;
      if (!inside(target) || excluded(target)) {
        unsafe = true;
        warnings.add(
          'Source alias import leaves the scanned source set or may resolve through an excluded path; shared clients require review.',
        );
        return;
      }
    }
  }
  return {
    resolve: resolveImport,
    // TypeScript tries each `paths` target and the `baseUrl` lookup, then falls back to
    // node_modules. So a bare name is the installed package when none of those can be a source
    // module: every target is inside the scanned repository, not excluded, and matches no file.
    // A catch-all such as `"*": ["*"]` then still resolves `@anthropic-ai/sdk` to the package.
    external: (name: string, file: string) => {
      const options = configuration.options.get(file);
      if (options === null) return false;
      if (rootedAsset(name)) return true;
      const match = matchingPath(name, options?.paths);
      const base = options?.baseUrl ?? options?.pathsBasePath;
      if (match && !base) return false;
      const targets = match
        ? match.targets.map((target) =>
            resolve(String(base), match.captured ? target.replace('*', match.captured) : target),
          )
        : [];
      if (options?.baseUrl) targets.push(resolve(options.baseUrl, name));
      return targets.every(
        (target) =>
          inside(target) && !excluded(target) && sourceMatches(target, sources).length === 0,
      );
    },
    get unverified() {
      return unsafe;
    },
    // Whether this file's own tsconfig or jsconfig could not be read, so a bare import such as
    // the SDK package may be an alias to something else.
    unverifiedFile: (file: string) => configuration.options.get(file) === null,
    get warnings() {
      return [...warnings];
    },
  };
}
