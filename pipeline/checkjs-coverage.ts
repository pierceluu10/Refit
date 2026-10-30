import { diffWordsWithSpace } from 'diff';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript-compiler';
import { CHECKJS_TSCONFIG } from './check-selection.ts';
import type { Repository } from './types.ts';

const execute = promisify(execFile);

// A checkJs type check (check-selection.ts) counts as evidence only where TypeScript typed the code
// the patch changed: with the target stripe-node installed, every property read whose name the
// patch changed, and every object property whose name or value it changed (a renamed request
// parameter, an `apiVersion` pin), must resolve to a declaration in the stripe package.
// A client TypeScript cannot type (a dynamic require, a wrapper factory it cannot follow, `any`)
// leaves those expressions untyped, so tsc would report nothing about them and the check proves
// nothing; the proof then fails and the check counts for nothing.

const JAVASCRIPT = /\.[cm]?jsx?$/;
// The program the proof builds is the check's own; larger repositories are left unproven.
const MAX_PROOF_FILES = 2_000;
const MAX_LISTED = 5;
const TAR_TIMEOUT_MS = 60_000;

export interface CheckJsSite {
  file: string;
  line: number;
  expression: string;
}
export interface CheckJsCoverage {
  proven: boolean;
  reason: string;
  // The stripe-node release the proof typed against.
  sdk?: string;
  // Changed expressions TypeScript resolved to stripe-node declarations.
  typed: CheckJsSite[];
  // Changed expressions it did not, with what they resolved to instead.
  untyped: (CheckJsSite & { resolved: string })[];
}

const unproven = (reason: string, sdk?: string): CheckJsCoverage => ({
  proven: false,
  reason,
  ...(sdk ? { sdk } : {}),
  typed: [],
  untyped: [],
});

const sites = (entries: CheckJsSite[]) =>
  `${entries
    .slice(0, MAX_LISTED)
    .map((site) => `\`${site.expression}\` (${site.file}:${site.line})`)
    .join(', ')}${entries.length > MAX_LISTED ? ` and ${entries.length - MAX_LISTED} more` : ''}`;

// Offsets in `after` of the words the patch added or changed relative to `before`; whitespace,
// line endings included, is never a change.
export function changedRanges(before: string, after: string) {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (const part of diffWordsWithSpace(before, after)) {
    if (part.removed) continue;
    if (part.added && part.value.trim())
      ranges.push({
        start: offset + part.value.search(/\S/),
        end: offset + part.value.trimEnd().length,
      });
    offset += part.value.length;
  }
  return ranges;
}

type Changed = ts.PropertyAccessExpression | ts.PropertyAssignment | ts.ShorthandPropertyAssignment;

// The expressions a patch changed in `source`: for each changed token (an identifier, a literal,
// a keyword), the innermost property read whose name it is, or object property that holds it.
// Other tokens, such as a variable's name, belong to no such expression and are not counted.
function changedExpressions(source: ts.SourceFile, ranges: { start: number; end: number }[]) {
  const changed = new Set<Changed>();
  const overlaps = (node: ts.Node) =>
    ranges.some((range) => node.getStart(source) < range.end && range.start < node.getEnd());
  const owner = (token: ts.Node) => {
    for (let node: ts.Node | undefined = token; node; node = node.parent) {
      if (ts.isPropertyAccessExpression(node) && node.name === token) return node;
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) return node;
      token = node;
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (!overlaps(node)) return;
    let leaf = true;
    ts.forEachChild(node, (child) => {
      leaf = false;
      visit(child);
    });
    const found = leaf ? owner(node) : undefined;
    if (found) changed.add(found);
  };
  visit(source);
  return [...changed];
}

// Unpacks the stripe package from a prepared dependency archive (dependency-preparation.ts: paths
// relative to the package the check runs in) into `directory`, following a pnpm symlink once.
async function unpackStripe(archive: string, directory: string) {
  const extract = (member: string) =>
    execute('tar', ['-xf', archive, '-C', directory, member], { timeout: TAR_TIMEOUT_MS });
  await extract('node_modules/stripe');
  const link = join(directory, 'node_modules', 'stripe');
  if (lstatSync(link).isSymbolicLink()) {
    const target = posix.normalize(posix.join('node_modules', readlinkSync(link)));
    if (target.startsWith('../') || !target.startsWith('node_modules/'))
      throw new Error(`node_modules/stripe links outside node_modules (${target}).`);
    await extract(target);
  }
  return realpathSync(link);
}

// The TypeScript-visible declarations of a changed expression: the property a read names, or the
// contextual type's property an object literal's key sets (a request parameter, a client option).
function declarationsOf(node: ts.Node, checker: ts.TypeChecker) {
  if (ts.isPropertyAccessExpression(node))
    return checker.getSymbolAtLocation(node.name)?.getDeclarations() ?? [];
  const literal = node.parent;
  if (!ts.isObjectLiteralExpression(literal)) return [];
  const contextual = checker.getContextualType(literal);
  const name = (node as ts.PropertyAssignment | ts.ShorthandPropertyAssignment).name;
  if (!contextual || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) return [];
  const types = contextual.isUnion() ? contextual.types : [contextual];
  return types.flatMap(
    (type) => checker.getPropertyOfType(type, name.text)?.getDeclarations() ?? [],
  );
}

const describe = (node: ts.Node, checker: ts.TypeChecker) => {
  const receiver = ts.isPropertyAccessExpression(node)
    ? checker.getTypeAtLocation(node.expression)
    : checker.getContextualType(node.parent as ts.ObjectLiteralExpression);
  return receiver ? checker.typeToString(receiver) : 'no contextual type';
};

// The coverage proof for a checkJs check: `patched` is the candidate the check ran on, `original`
// the code before the patch, `dependencies` the candidate's own prepared dependency archive with
// the target stripe-node, and `sdk` that target's version.
export async function checkJsCoverage(options: {
  original: Repository;
  patched: Repository;
  command: readonly string[];
  changedFiles: readonly string[];
  dependencies?: string;
  sdk?: string;
  packageDirectory?: string;
}): Promise<CheckJsCoverage> {
  if (!options.dependencies || !options.sdk)
    return unproven(
      'the patch installs no stripe-node upgrade of its own, so the target stripe-node typings are not in the workspace',
    );
  const configuration = options.command.slice(3).find((part) => part.startsWith('{'));
  if (!configuration) return unproven('the check has no generated checkJs configuration');
  const changed = options.changedFiles.filter((path) => /\.[cm]?[jt]sx?$/.test(path));
  const other = changed.filter((path) => !JAVASCRIPT.test(path));
  if (other.length)
    return unproven(`the patch changes ${other.join(', ')}, which a checkJs check does not cover`);
  if (!changed.length) return unproven('the patch changes no JavaScript source');
  if (options.patched.files.length > MAX_PROOF_FILES)
    return unproven(`the repository has more than ${MAX_PROOF_FILES} source files`);
  const root = await mkdtemp(join(tmpdir(), 'refit-checkjs-'));
  try {
    for (const file of [...(options.patched.configurations ?? []), ...options.patched.files]) {
      const path = resolve(root, file.path);
      if (!path.startsWith(`${root}${sep}`)) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    // Node's resolution reads each file's nearest package.json for its module kind (`type`).
    const manifests = new Set(
      options.patched.files.flatMap((file) => {
        const directories: string[] = [];
        for (let directory = dirname(file.path); ; directory = dirname(directory)) {
          directories.push(directory === '.' ? 'package.json' : `${directory}/package.json`);
          if (directory === '.' || directory === '/') break;
        }
        return directories;
      }),
    );
    for (const manifest of manifests) {
      const from = resolve(options.patched.root, manifest);
      if (!existsSync(from)) continue;
      await mkdir(dirname(join(root, manifest)), { recursive: true });
      await writeFile(join(root, manifest), readFileSync(from));
    }
    const checkRoot = join(root, options.packageDirectory ?? '');
    await mkdir(checkRoot, { recursive: true });
    let stripe: string;
    try {
      stripe = await unpackStripe(options.dependencies, checkRoot);
    } catch (error) {
      return unproven(
        `the target stripe-node could not be read from the prepared dependencies (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
      );
    }
    const installed = JSON.parse(readFileSync(join(stripe, 'package.json'), 'utf8')).version;
    if (installed !== options.sdk)
      return unproven(
        `the prepared dependencies install stripe-node ${installed}, not the target ${options.sdk}`,
        installed,
      );
    const parsed = ts.parseJsonConfigFileContent(
      ts.parseConfigFileTextToJson(CHECKJS_TSCONFIG, configuration).config,
      ts.sys,
      checkRoot,
      undefined,
      join(checkRoot, CHECKJS_TSCONFIG),
    );
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    const checker = program.getTypeChecker();
    const stripeRoot = `${stripe}${sep}`;
    const inStripe = (declaration: ts.Declaration) => {
      const path = declaration.getSourceFile().fileName;
      return (existsSync(path) ? realpathSync(path) : path).startsWith(stripeRoot);
    };
    const typed: CheckJsSite[] = [];
    const untyped: CheckJsCoverage['untyped'] = [];
    const missing: string[] = [];
    for (const path of changed) {
      const source = program.getSourceFile(resolve(root, path));
      const before = options.original.files.find((file) => file.path === path)?.content ?? '';
      const after = options.patched.files.find((file) => file.path === path)?.content;
      if (!source || after === undefined) {
        missing.push(path);
        continue;
      }
      for (const node of changedExpressions(source, changedRanges(before, after))) {
        if (ts.isPrivateIdentifier(node.name)) continue;
        const site = {
          file: path,
          line: source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1,
          expression: ts.isPropertyAccessExpression(node)
            ? `.${node.name.text}`
            : node.name.getText(source),
        };
        const declarations = declarationsOf(node, checker);
        if (declarations.length && declarations.every(inStripe)) typed.push(site);
        else
          untyped.push({
            ...site,
            resolved: declarations.length
              ? `declared in ${relative(root, declarations[0].getSourceFile().fileName)}`
              : `untyped on ${describe(node, checker)}`,
          });
      }
    }
    if (missing.length)
      return {
        ...unproven(`the checkJs program does not include ${missing.join(', ')}`, installed),
        typed,
        untyped,
      };
    if (untyped.length)
      return {
        proven: false,
        reason: `TypeScript did not type ${sites(untyped)} as stripe-node ${installed} declarations (${untyped[0].resolved}), so the checkJs check proves nothing about them`,
        sdk: installed,
        typed,
        untyped,
      };
    if (!typed.length)
      return unproven('the patch changes no Stripe property read or request property', installed);
    return {
      proven: true,
      reason: `TypeScript types every changed Stripe expression (${sites(typed)}) with stripe-node ${installed}'s declarations`,
      sdk: installed,
      typed,
      untyped,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
