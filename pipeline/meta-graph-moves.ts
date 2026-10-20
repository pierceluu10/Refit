import ts from 'typescript-compiler';
import { daysUntil, type DeadlineRegistry } from './deadline-registry.ts';
import {
  exported,
  findDeclaration,
  isConst,
  isReference,
  scanGraphCalls,
  unwrap,
  type GraphCall,
} from './meta-graph-calls.ts';
import {
  compareVersions,
  type MetaGraphChange,
  type MetaGraphChanges,
} from './meta-graph-changes.ts';
import { renderPatch } from './patches.ts';
import { readRepository } from './repository.ts';
import { META_SDK } from './deadline-exposure.ts';
import { PipelineInputError, type Repository, type SourceEdit } from './types.ts';

// Review-only Graph API version moves. A version is written once and can serve many requests (a
// base constant feeds every URL built from it), so a move is decided per place the version is
// written: it is proposed only when every request through that place is fully known and the
// reviewed change list shows nothing those requests use changed between the two versions.
// Nothing is applied, validated or published.

const VERSION = /^v\d+\.\d+$/;
const HOST_PREFIX = 'graph.facebook.com/';
const MAX_ALIAS_DEPTH = 3;

export interface VersionMoveRequest {
  file: string;
  line: number;
  method: GraphCall['method'];
  path: string | null;
}

export interface VersionMove {
  // Where the version is written.
  file: string;
  line: number;
  from: string;
  to: string;
  // Versions crossed, each with a reviewed changelog that lists nothing these requests use.
  crossed: string[];
  requests: VersionMoveRequest[];
}

export interface VersionMoveStop {
  // Where the version is written; null for requests with no version in the URL or one built at
  // runtime.
  file: string | null;
  line: number | null;
  from: string | null;
  requests: VersionMoveRequest[];
  // Every reason the move stops, each with its location.
  reasons: string[];
}

export interface VersionMoveProposal {
  target: string;
  moves: VersionMove[];
  stops: VersionMoveStop[];
  // Requests already on the target or a later version.
  current: VersionMoveRequest[];
  // A unified diff of every move; null when there is none. Never applied by Refit.
  patch: string | null;
}

function request(call: GraphCall): VersionMoveRequest {
  return { file: call.file, line: call.line, method: call.method, path: call.path };
}

// Every field name a `fields` value requests, at any depth: `posts{message,from{id}}` names posts,
// message, from and id; `reactions.limit(0).summary(true)` names reactions.
export function fieldNames(fields: string[]) {
  const names = new Set<string>();
  for (const field of fields)
    for (const name of field.replace(/\.\w+\([^)]*\)/g, '').match(/[A-Za-z_][\w]*/g) ?? [])
      names.add(name);
  return names;
}

// Whether a request path starts with a change's path. A runtime segment on either side (`{id}`)
// may hold any node, so it matches any segment.
function pathMatches(path: string, prefix: string) {
  const segments = path.split('/').filter(Boolean);
  const wanted = prefix.split('/').filter(Boolean);
  const runtime = (segment: string) => segment.includes('{');
  return (
    wanted.length <= segments.length &&
    wanted.every(
      (segment, index) =>
        runtime(segment) || runtime(segments[index]) || segment === segments[index],
    )
  );
}

// The change-list entries a request uses: its edge or endpoint, a field it requests, a metric or a
// parameter. A GET that names no fields gets the node's defaults, so any field change counts.
export function changesUsedBy(call: GraphCall, changes: MetaGraphChange[]) {
  const fields = call.fields ? fieldNames(call.fields) : new Set<string>();
  return changes.filter((change) => {
    switch (change.kind) {
      case 'endpoint-removed':
        return (
          (change.edge !== null && change.edge === call.edge) ||
          (change.path !== null && call.path !== null && pathMatches(call.path, change.path))
        );
      case 'edge-removed':
      case 'edge-changed':
        return change.edge === call.edge;
      case 'field-removed':
      case 'field-changed':
        return fields.has(change.name!) || (call.method === 'GET' && call.fields?.length === 0);
      case 'metric-removed':
      case 'metric-changed':
        return call.metrics?.includes(change.name!) ?? false;
      case 'parameter-removed':
      case 'parameter-changed':
        return call.parameters?.includes(change.name!) ?? false;
    }
    return true;
  });
}

// What a request leaves unknown, which stops any move of its version.
function unknownParts(call: GraphCall) {
  const where = `${call.file}:${call.line}`;
  const reasons: string[] = [];
  if (call.kind === 'sdk')
    reasons.push(
      `${META_SDK} requests follow the package's version; a package upgrade is not proposed`,
    );
  else if (call.client === null) reasons.push(`${where}: no request call was traced for this URL`);
  if (call.path === null) reasons.push(`${where}: the path is not known`);
  if (call.method === null) reasons.push(`${where}: the HTTP method is not known`);
  if (call.fields === null) reasons.push(`${where}: the requested fields are not known`);
  if (call.metrics === null) reasons.push(`${where}: the requested metrics are not known`);
  if (call.parameters === null) reasons.push(`${where}: the request parameters are not known`);
  return reasons;
}

interface PinEdit {
  start: number;
  end: number;
  reasons: string[];
}

function nodeAt(source: ts.SourceFile, offset: number) {
  let found: ts.Node = source;
  const visit = (node: ts.Node) => {
    if (offset >= node.getStart(source) && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(source, visit);
  return found;
}

function isStringPiece(node: ts.Node) {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

// The expression a string piece belongs to, climbing through templates, concatenation and
// wrappers, and the variable it initializes, if any.
function holderOf(node: ts.Node): ts.VariableDeclaration | undefined {
  let current: ts.Node = node;
  while (
    current.parent &&
    (ts.isTemplateExpression(current.parent) ||
      ts.isTemplateSpan(current.parent) ||
      (ts.isBinaryExpression(current.parent) &&
        current.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  )
    current = current.parent;
  return ts.isVariableDeclaration(current.parent) && current.parent.initializer === current
    ? current.parent
    : undefined;
}

function references(source: ts.SourceFile, declaration: ts.VariableDeclaration) {
  const name = (declaration.name as ts.Identifier).text;
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      isReference(node) &&
      node !== declaration.name &&
      findDeclaration(name, node) === declaration
    )
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// Whether every use of a variable holding a version or a Graph URL is one the request scan
// follows: the start of a URL, the version segment of a URL, a call argument, `{ url }` in a
// request config, or a file-local `const` alias whose uses qualify in turn.
function untracedUses(
  source: ts.SourceFile,
  declaration: ts.VariableDeclaration,
  kind: 'url' | 'version',
  depth = 0,
): string[] {
  const name = (declaration.name as ts.Identifier).text;
  const reasons: string[] = [];
  for (const reference of references(source, declaration)) {
    let node: ts.Node = reference;
    while (
      ts.isParenthesizedExpression(node.parent) ||
      ts.isAsExpression(node.parent) ||
      ts.isNonNullExpression(node.parent)
    )
      node = node.parent;
    const parent = node.parent;
    const where = `${source.fileName}:${source.getLineAndCharacterOfPosition(reference.getStart(source)).line + 1}`;
    if (ts.isTemplateSpan(parent)) {
      const template = parent.parent;
      const index = template.templateSpans.indexOf(parent);
      const before =
        index === 0 ? template.head.text : template.templateSpans[index - 1].literal.text;
      if (kind === 'url' && index === 0 && before === '') continue;
      if (kind === 'version' && before.endsWith(HOST_PREFIX)) continue;
    } else if (kind === 'url') {
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        parent.left === node
      )
        continue;
      if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) continue;
      if (
        (ts.isShorthandPropertyAssignment(parent) && name === 'url') ||
        (ts.isPropertyAssignment(parent) &&
          parent.initializer === node &&
          ts.isIdentifier(parent.name) &&
          parent.name.text === 'url')
      ) {
        const object = parent.parent;
        if (ts.isCallExpression(object.parent) && object.parent.arguments[0] === object) continue;
      }
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name) &&
        isConst(parent) &&
        !exported(parent) &&
        depth < MAX_ALIAS_DEPTH
      ) {
        reasons.push(...untracedUses(source, parent, kind, depth + 1));
        continue;
      }
    }
    reasons.push(`${where}: \`${name}\` is used in a way the request scan does not follow`);
  }
  return reasons;
}

// Finds the version where a pin writes it, and checks that changing it there changes nothing
// but the requests the scan reported.
function pinEdit(repository: Repository, file: string, line: number, version: string): PinEdit {
  const content = repository.files.find((item) => item.path === file)?.content;
  const where = `${file}:${line}`;
  if (content === undefined) return { start: 0, end: 0, reasons: [`${where}: file not found`] };
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const lineStart = source.getLineStarts()[line - 1];
  const lineText = content.slice(lineStart, source.getLineStarts()[line] ?? content.length);
  // In a URL (`graph.facebook.com/v19.0`) or alone in quotes (`'v19.0'`).
  const inUrl = [
    ...lineText.matchAll(
      new RegExp(
        `${HOST_PREFIX.replace(/\./g, '\\.')}${version.replace('.', '\\.')}(?![\\w.])`,
        'g',
      ),
    ),
  ];
  const quoted = [
    ...lineText.matchAll(new RegExp(`(['"\`])${version.replace('.', '\\.')}\\1`, 'g')),
  ];
  let start: number;
  if (inUrl.length === 1 && !quoted.length) start = lineStart + inUrl[0].index + HOST_PREFIX.length;
  else if (quoted.length === 1 && !inUrl.length) start = lineStart + quoted[0].index + 1;
  else
    return {
      start: 0,
      end: 0,
      reasons: [
        inUrl.length + quoted.length
          ? `${where}: ${version} is written ${inUrl.length + quoted.length} times on this line`
          : `${where}: ${version} is not written on this line`,
      ],
    };
  const end = start + version.length;
  const node = nodeAt(source, start);
  if (!isStringPiece(node))
    return { start, end, reasons: [`${where}: ${version} is not inside a string on this line`] };
  const holder = holderOf(node);
  if (!holder) return { start, end, reasons: [] };
  const name = ts.isIdentifier(holder.name) ? holder.name.text : '';
  if (!name)
    return { start, end, reasons: [`${where}: the version is held in a destructured value`] };
  if (exported(holder))
    return {
      start,
      end,
      reasons: [
        `${where}: the version is in the exported \`${name}\`; other files may use it in ways this check does not follow`,
      ],
    };
  if (!isConst(holder))
    return {
      start,
      end,
      reasons: [`${where}: the version is in \`${name}\`, which is not a const`],
    };
  const initializer = holder.initializer && unwrap(holder.initializer);
  const kind =
    initializer && ts.isStringLiteralLike(initializer) && VERSION.test(initializer.text)
      ? 'version'
      : 'url';
  return { start, end, reasons: untracedUses(source, holder, kind) };
}

// Proposes moving each pinned Graph API version to `target` where the evidence allows, and lists
// every other pin with the exact reasons it stops for review. Never applies the patch.
export async function proposeVersionMoves(
  directory: string,
  target: string,
  changes: MetaGraphChanges,
  registry: DeadlineRegistry,
  now: Date,
): Promise<VersionMoveProposal> {
  if (!VERSION.test(target)) throw new PipelineInputError('--target must look like v24.0.');
  const records = new Map(changes.versions.map((entry) => [entry.version, entry]));
  if (!records.has(target))
    throw new PipelineInputError(
      `${target} has no record in the Meta Graph API change list, so moves to it cannot be checked.`,
    );
  const retiring = registry.deadlines.find(
    (entry) => entry.provider === 'meta-graph' && entry.versions.includes(target),
  );
  if (retiring && daysUntil(retiring.date, now) < 0)
    throw new PipelineInputError(
      `${target} was retired on ${retiring.date}; choose a newer target.`,
    );
  const repository = await readRepository(directory, META_SDK);
  const scan = await scanGraphCalls(directory, { repository });
  // Every version a move could cross: the change list's, the deadline registry's and each whole
  // major version, so a version missing from both lists is still checked.
  const known = new Set([
    ...changes.versions.map((entry) => entry.version),
    ...registry.deadlines
      .filter((entry) => entry.provider === 'meta-graph')
      .flatMap((entry) => entry.versions),
  ]);
  const crossedBetween = (from: string) => {
    const majors = Array.from(
      {
        length: Math.max(
          0,
          Number(target.slice(1).split('.')[0]) - Number(from.slice(1).split('.')[0]),
        ),
      },
      (_, index) => `v${Number(from.slice(1).split('.')[0]) + index + 1}.0`,
    );
    return [...new Set([...known, ...majors])]
      .filter(
        (version) => compareVersions(version, from) > 0 && compareVersions(version, target) <= 0,
      )
      .sort(compareVersions);
  };

  const moves: VersionMove[] = [];
  const stops: VersionMoveStop[] = [];
  const current: VersionMoveRequest[] = [];
  const edits: SourceEdit[] = [];
  // Requests grouped by where their version is written.
  const pins = new Map<string, GraphCall[]>();
  const unpinned: GraphCall[] = [];
  for (const call of scan.calls) {
    if (!call.version || !call.pin) unpinned.push(call);
    else {
      const key = `${call.pin.file}\t${call.pin.line}\t${call.version}`;
      pins.set(key, [...(pins.get(key) ?? []), call]);
    }
  }
  for (const call of unpinned)
    stops.push({
      file: null,
      line: null,
      from: null,
      requests: [request(call)],
      reasons: [
        `${call.file}:${call.line}: ${call.versionSource === 'unversioned' ? 'the URL names no version' : 'the version is built at runtime'}`,
      ],
    });
  for (const [key, calls] of pins) {
    const [file, lineText, from] = key.split('\t');
    const line = Number(lineText);
    if (compareVersions(from, target) >= 0) {
      if (compareVersions(from, target) === 0) current.push(...calls.map(request));
      else
        stops.push({
          file,
          line,
          from,
          requests: calls.map(request),
          reasons: [`${file}:${line}: ${from} is newer than the target ${target}`],
        });
      continue;
    }
    const reasons = calls.flatMap(unknownParts);
    if (calls.every((call) => call.use === 'test'))
      reasons.push(`${file}:${line}: only tests and examples use this version`);
    const crossed = crossedBetween(from);
    const unreviewed = crossed.filter((version) => records.get(version)?.status !== 'reviewed');
    if (unreviewed.length)
      reasons.push(
        `${unreviewed.join(', ')}: ${unreviewed.length === 1 ? 'this changelog is' : 'these changelogs are'} not reviewed in the Meta Graph API change list`,
      );
    const inRange = changes.changes.filter((change) => crossed.includes(change.version));
    for (const call of calls)
      for (const change of changesUsedBy(call, inRange))
        reasons.push(
          `${call.file}:${call.line}: ${change.version} ${change.kind} ${change.id}: ${change.summary}`,
        );
    let edit: PinEdit | undefined;
    if (calls.some((call) => call.kind === 'url')) {
      edit = pinEdit(repository, file, line, from);
      reasons.push(...edit.reasons);
    }
    if (reasons.length || !edit) {
      stops.push({
        file,
        line,
        from,
        requests: calls.map(request),
        reasons: [...new Set(reasons)],
      });
      continue;
    }
    moves.push({ file, line, from, to: target, crossed, requests: calls.map(request) });
    edits.push({
      file,
      start: edit.start,
      end: edit.end,
      replacement: target,
      changeId: `meta-graph-version-${from}-${target}`,
    });
  }
  const byLocation = (a: { file: string | null; line: number | null }, b: typeof a) =>
    (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0);
  return {
    target,
    moves: moves.sort(byLocation),
    stops: stops.sort(byLocation),
    current,
    patch: edits.length ? renderPatch(repository, edits) : null,
  };
}
