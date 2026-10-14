import { dirname, resolve } from 'node:path';
import ts from 'typescript-compiler';
import { isObject } from './specifications.ts';
import type { Repository } from './types.ts';

export const SOURCE_CONFIGURATION_NAMES = ['tsconfig.json', 'jsconfig.json'];
const MAX_CONFIGURATION_DEPTH = 16;
const RESOLUTION_OPTIONS = ['paths', 'baseUrl', 'rootDirs', 'moduleSuffixes', 'noResolve'];

export function configurationReferences(content: string) {
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', content);
  if (parsed.error || !isObject(parsed.config)) return [];
  const references = Array.isArray(parsed.config.extends)
    ? parsed.config.extends
    : [parsed.config.extends];
  return references.filter(
    (reference): reference is string =>
      typeof reference === 'string' && (reference.startsWith('./') || reference.startsWith('../')),
  );
}

export function sourceConfigurationOptions(repository: Repository) {
  const configurations = new Map(
    (repository.configurations ?? []).map((file) => [resolve(repository.root, file.path), file]),
  );
  const warnings = new Set<string>();
  const cache = new Map<string, ts.CompilerOptions | null>();
  function parse(path: string) {
    if (cache.has(path)) return cache.get(path)!;
    const visited = new Set<string>();
    const inputs = new Map<string, string>();
    let invalid = false;
    function read(name: string, depth = 0) {
      const file = configurations.get(name);
      if (!file) return;
      if (depth > MAX_CONFIGURATION_DEPTH) {
        invalid = true;
        return;
      }
      if (visited.has(name)) return;
      visited.add(name);
      const result = ts.parseConfigFileTextToJson(name, file.content);
      if (result.error || !isObject(result.config)) {
        invalid = true;
        return;
      }
      const config = result.config;
      if (
        config.references !== undefined ||
        (config.compilerOptions !== undefined && !isObject(config.compilerOptions))
      )
        invalid = true;
      for (const reference of configurationReferences(file.content)) {
        const parent = resolve(dirname(name), reference);
        const target = configurations.has(parent) ? parent : `${parent}.json`;
        read(target, depth + 1);
      }
      const compilerOptions = isObject(config.compilerOptions) ? config.compilerOptions : {};
      inputs.set(
        name,
        JSON.stringify({
          ...(config.extends === undefined ? {} : { extends: config.extends }),
          compilerOptions: Object.fromEntries(
            RESOLUTION_OPTIONS.filter((key) => Object.hasOwn(compilerOptions, key)).map((key) => [
              key,
              compilerOptions[key],
            ]),
          ),
          files: ['.refit-resolution-input.ts'],
        }),
      );
    }
    read(path);
    const input = inputs.get(path);
    const parsed =
      input &&
      ts.parseJsonConfigFileContent(
        JSON.parse(input),
        {
          useCaseSensitiveFileNames: true,
          readDirectory: () => [],
          fileExists: (name) => inputs.has(name),
          readFile: (name) => inputs.get(name),
        },
        dirname(path),
        undefined,
        path,
      );
    const options = parsed ? parsed.options : undefined;
    if (
      invalid ||
      !options ||
      (parsed && parsed.errors.length) ||
      options.rootDirs !== undefined ||
      options.moduleSuffixes !== undefined ||
      options.noResolve
    ) {
      warnings.add(
        `${configurations.get(path)!.path}: source alias resolution is unverified (invalid configuration, unavailable extends, project references or unsupported resolution options). Shared clients require review.`,
      );
      cache.set(path, null);
      return null;
    }
    cache.set(path, options);
    return options;
  }
  const options = new Map<string, ts.CompilerOptions | null>();
  for (const file of repository.files) {
    let directory = dirname(resolve(repository.root, file.path));
    while (true) {
      const config = SOURCE_CONFIGURATION_NAMES.map((name) => resolve(directory, name)).find(
        (name) => configurations.has(name),
      );
      if (config) {
        options.set(resolve(repository.root, file.path), parse(config));
        break;
      }
      if (directory === resolve(repository.root) || directory === dirname(directory)) break;
      directory = dirname(directory);
    }
  }
  return {
    options,
    warnings: [...warnings],
    unverified: [...options.values()].some((value) => value === null),
  };
}
