import { builtinModules } from 'node:module';
import ts from 'typescript-compiler';
import { generatedImportMap, sandboxTranspile } from './generated-checks.ts';
import { assertRegistryTarball, hasStrongIntegrity, MAX_PACKAGES } from './npm-lock.ts';
import { isObject, parseObject } from './specifications.ts';
import type { Repository } from './types.ts';

// When a repository's dependencies cannot be prepared, behaviour tests can still run on the changed
// Stripe modules if loading them needs nothing but the stripe package: every runtime import they
// reach resolves to a repository file, a node builtin or stripe.
const BUILTINS = new Set(builtinModules);
const TYPESCRIPT = /\.[cm]?tsx?$/;
const MAX_REASONS = 20;
const PACKAGE = 'refit-stripe-only';

// What loading `files` would import beyond repository files, node builtins and stripe; empty when
// they load with only the stripe package installed. TypeScript is read as the sandbox transpiles it,
// so imports used only as types do not count.
export function stripeOnlyImports(repository: Repository, files: readonly string[]) {
  const imports = generatedImportMap(repository);
  const contents = new Map(repository.files.map((file) => [file.path, file.content]));
  const reasons: string[] = [];
  const reached = [...files];
  for (const path of reached) {
    const content = contents.get(path);
    if (content === undefined) {
      reasons.push(`${path} is not a repository source file.`);
      continue;
    }
    const output = TYPESCRIPT.test(path) ? sandboxTranspile(content, path) : content;
    const source = ts.createSourceFile(`${path}.mjs`, output, ts.ScriptTarget.Latest, true);
    const specifier = (text: string) => {
      const target = imports[path]?.[text];
      if (target) {
        if (!reached.includes(target)) reached.push(target);
      } else if (
        text !== 'stripe' &&
        !text.startsWith('node:') &&
        !BUILTINS.has(text) &&
        reasons.length < MAX_REASONS
      )
        reasons.push(
          `${path} imports '${text}', which ${text.startsWith('.') ? 'is not a repository source file' : 'needs the repository dependencies'}.`,
        );
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        specifier(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteralLike(argument)) specifier(argument.text);
        else if (reasons.length < MAX_REASONS)
          reasons.push(`${path} loads a module whose name is computed at runtime.`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return reasons;
}

// A project with only stripe and the dependency closure an npm lockfile (version 2 or 3) records
// for it, with the lockfile's own registry tarballs and integrity, so `npm ci` installs exactly
// those bytes. Stripe must be installed at the root (node_modules/stripe).
export interface StripeOnlyProject {
  version: string;
  integrity: string;
  manifest: Record<string, unknown>;
  lockfile: { packages: Record<string, Record<string, unknown>> } & Record<string, unknown>;
}

export function stripeOnlyProject(lockfile: string): StripeOnlyProject | { reason: string } {
  let lock: Record<string, unknown>;
  try {
    lock = parseObject(lockfile, 'package-lock.json');
  } catch {
    return { reason: 'package-lock.json is not valid JSON.' };
  }
  const packages = lock.packages;
  if (![2, 3].includes(Number(lock.lockfileVersion)) || !isObject(packages))
    return {
      reason: 'Only npm lockfiles of version 2 or 3 record the stripe closure Refit installs.',
    };
  const root = packages['node_modules/stripe'];
  if (!isObject(root) || typeof root.version !== 'string')
    return { reason: 'package-lock.json does not install stripe at node_modules/stripe.' };
  const closure: Record<string, Record<string, unknown>> = {};
  const queue = ['node_modules/stripe'];
  for (const path of queue) {
    if (queue.length > MAX_PACKAGES) return { reason: 'The stripe closure is unexpectedly large.' };
    const entry = packages[path];
    if (!isObject(entry) || entry.link || typeof entry.resolved !== 'string')
      return { reason: `package-lock.json records ${path} without a registry tarball.` };
    try {
      assertRegistryTarball(entry.resolved, path, true);
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
    if (!hasStrongIntegrity(entry.integrity))
      return { reason: `package-lock.json records ${path} without a strong integrity.` };
    const {
      dev: _dev,
      devOptional: _devOptional,
      peer: _peer,
      extraneous: _extraneous,
      ...kept
    } = entry;
    closure[path] = kept;
    const optionalPeers = isObject(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : {};
    for (const [section, required] of [
      ['dependencies', true],
      ['optionalDependencies', false],
      ['peerDependencies', true],
    ] as const) {
      const names = isObject(entry[section]) ? Object.keys(entry[section] as object) : [];
      for (const name of names) {
        // npm resolves a dependency in the nearest node_modules up the dependent's path.
        const chain = path.slice('node_modules/'.length).split('/node_modules/');
        let found: string | undefined;
        for (let depth = chain.length; depth >= 0 && !found; depth--) {
          const candidate = [...chain.slice(0, depth), name]
            .map((part) => `node_modules/${part}`)
            .join('/');
          if (isObject(packages[candidate])) found = candidate;
        }
        const optional =
          !required ||
          (section === 'peerDependencies' &&
            isObject(optionalPeers[name]) &&
            (optionalPeers[name] as Record<string, unknown>).optional === true);
        if (!found && !optional)
          return { reason: `package-lock.json does not install ${name}, which ${path} needs.` };
        if (found && !queue.includes(found)) queue.push(found);
      }
    }
  }
  const version = root.version;
  const dependencies = { stripe: version };
  return {
    version,
    integrity: root.integrity as string,
    manifest: { name: PACKAGE, version: '0.0.0', private: true, dependencies },
    lockfile: {
      name: PACKAGE,
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: PACKAGE, version: '0.0.0', dependencies }, ...closure },
    },
  };
}
