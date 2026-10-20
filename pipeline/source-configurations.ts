import { dirname, join, resolve } from 'node:path';
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

// Project references (`{"references": [{"path": "./tsconfig.app.json"}]}`) name a file or a
// directory holding tsconfig.json.
export function projectReferences(content: string) {
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', content);
  if (parsed.error || !isObject(parsed.config) || !Array.isArray(parsed.config.references))
    return [];
  return parsed.config.references
    .map((reference) => (isObject(reference) ? reference.path : undefined))
    .filter(
      (path): path is string =>
        typeof path === 'string' && (path.startsWith('./') || path.startsWith('../')),
    );
}

export function configurationTarget(exists: (path: string) => boolean, path: string) {
  return [path, `${path}.json`, join(path, 'tsconfig.json')].find(exists);
}

// A solution configuration (`"files": []` plus references, like Vite's template) compiles nothing
// itself; each source file belongs to the referenced project that includes it. A configuration
// with its own sources and references also owns the files it includes. `paths` is null when a
// reference is not a local path.
function configurationProjects(name: string, content: string) {
  const parsed = ts.parseConfigFileTextToJson(name, content);
  if (parsed.error || !isObject(parsed.config) || parsed.config.references === undefined)
    return undefined;
  const { files, include, references } = parsed.config;
  const paths = projectReferences(content);
  return {
    solution: Array.isArray(files) && !files.length && include === undefined,
    paths: Array.isArray(references) && paths.length === references.length ? paths : null,
  };
}

// Matches TypeScript's include/exclude specs: `**` spans directories, `*` and `?` stay within one,
// and a spec without wildcards names a file or a whole directory.
function specPattern(directory: string, spec: string) {
  const absolute = escapeRegExp(resolve(directory, spec));
  if (!/[*?]/.test(spec)) return new RegExp(`^${absolute}(?:/.*)?$`);
  const pattern = absolute
    .replace(/\\\*\\\*\//g, '(?:[^/]+/)*')
    .replace(/\\\*\\\*$/, '.*')
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '[^/]');
  return new RegExp(`^${pattern}$`);
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function includesFile(name: string, content: string, file: string) {
  const parsed = ts.parseConfigFileTextToJson(name, content);
  if (parsed.error || !isObject(parsed.config)) return false;
  const directory = dirname(name);
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const { files, include, exclude } = parsed.config;
  if (strings(files).some((entry) => resolve(directory, entry) === file)) return true;
  // TypeScript includes everything under the project when neither files nor include is set.
  const includes = include === undefined && files === undefined ? ['**/*'] : strings(include);
  return (
    includes.some((spec) => specPattern(directory, spec).test(file)) &&
    !strings(exclude).some((spec) => specPattern(directory, spec).test(file))
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
      // References do not change resolution options; file membership is decided per source file.
      if (config.compilerOptions !== undefined && !isObject(config.compilerOptions)) invalid = true;
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
        const path = resolve(repository.root, file.path);
        const content = configurations.get(config)!.content;
        const projects = configurationProjects(config, content);
        const targets = projects?.paths?.map((reference) =>
          configurationTarget((name) => configurations.has(name), resolve(directory, reference)),
        );
        if (!projects) options.set(path, parse(config));
        else if (!targets || targets.includes(undefined)) {
          // A missing or non-local referenced project may be the one that compiles this file.
          warnings.add(
            `${configurations.get(config)!.path}: a referenced project is unavailable; source alias resolution is unverified. Shared clients require review.`,
          );
          options.set(path, null);
        } else {
          const owners = [...(projects.solution ? [] : [config]), ...(targets as string[])].filter(
            (name) => includesFile(name, configurations.get(name)!.content, path),
          );
          // A file outside every project compiles with default options in an editor; a mixed
          // configuration keeps the nearest-configuration rule used everywhere else.
          if (owners.length <= 1)
            options.set(
              path,
              owners.length ? parse(owners[0]!) : projects.solution ? {} : parse(config),
            );
          else {
            warnings.add(
              `${configurations.get(config)!.path}: ${file.path} belongs to several referenced projects; source alias resolution is unverified. Shared clients require review.`,
            );
            options.set(path, null);
          }
        }
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
