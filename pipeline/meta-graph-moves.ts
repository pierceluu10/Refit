import ts from 'typescript-compiler';
import { daysUntil, type DeadlineRegistry } from './deadline-registry.ts';
import {
  exported,
  findDeclaration,
  isConst,
  isReference,
  scanGraphCalls,
  unwrap,
  envDefault,
  type GraphCall,
} from './meta-graph-calls.ts';
import {
  compareVersions,
  type MetaGraphChange,
  type MetaGraphChanges,
} from './meta-graph-changes.ts';
import { applyRules, type AppliedRule } from './meta-graph-rule-edits.ts';
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
const HOST_PREFIX = /graph\.(?:facebook|instagram)\.com\/$/;
const MAX_ALIAS_DEPTH = 3;
export const META_GRAPH_VERSION_RULE = 'meta-graph-api-version';

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
  // Documented rules applied with the move, such as a renamed field in a `fields` list.
  rules: string[];
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
  // The edits the patch is made of: version pins and the rule edits that move with them.
  edits: SourceEdit[];
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
// may hold any node, so it matches any segment. A change path that is one placeholder, such as
// `/{offline-event-set-id}`, names a node type an opaque ID cannot reveal: it matches every request
// to a single opaque node (a placeholder or a numeric ID), and never a longer path or a literal one
// such as `/me`.
function pathMatches(path: string, prefix: string) {
  const segments = path.split('/').filter(Boolean);
  const wanted = prefix.split('/').filter(Boolean);
  const runtime = (segment: string) => segment.includes('{');
  // A literal numeric ID, or an ad account ID, is as opaque as a placeholder.
  const opaque = (segment: string) => runtime(segment) || /^(act_)?\d+$/.test(segment);
  if (wanted.length === 1 && runtime(wanted[0]))
    return segments.length === 1 && opaque(segments[0]);
  // A root endpoint such as `/search` or `/instagram_oembed` is one literal word; a request whose
  // path starts with a node ID (`/{pageId}/photos`) is not under it. Paths named like a path, which
  // could hold one, are already unknown in the scan. A longer path such as `/me/accounts` still
  // matches a runtime node, which may be `me`.
  if (wanted.length === 1 && segments.length && runtime(segments[0])) return false;
  return (
    wanted.length <= segments.length &&
    wanted.every(
      (segment, index) =>
        runtime(segment) || runtime(segments[index]) || segment === segments[index],
    )
  );
}

// Whether two request paths name the same endpoint: the same number of segments, each written the
// same or a runtime segment on either side, so `/{userId}/media` describes `/123456/media`.
function samePath(a: string, b: string) {
  const left = a.split('/').filter(Boolean);
  const right = b.split('/').filter(Boolean);
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment === right[index] || segment.includes('{') || right[index].includes('{'),
    )
  );
}

// The change-list entries a request uses: its edge or endpoint, a field it requests, a metric, a
// breakdown or a parameter. A GET that names no fields gets the node's defaults, so any field change
// counts. Webhook changes follow the app's webhook version, not the request's, so no request uses
// them; they stay alerts.
export function changesUsedBy(call: GraphCall, changes: MetaGraphChange[]) {
  const fields = call.fields ? fieldNames(call.fields) : new Set<string>();
  const endpoint = (change: MetaGraphChange) =>
    (change.edge !== null && change.edge === call.edge) ||
    (change.path !== null && call.path !== null && pathMatches(call.path, change.path));
  return changes.filter((change) => {
    switch (change.kind) {
      case 'endpoint-removed':
      case 'endpoint-changed':
      case 'parameter-required':
      case 'error-changed':
      case 'permission-changed':
        return endpoint(change);
      case 'edge-removed':
      case 'edge-changed':
        return change.edge === call.edge;
      case 'field-removed':
      case 'field-changed':
        return fields.has(change.name!) || (call.method === 'GET' && call.fields?.length === 0);
      case 'metric-removed':
      case 'metric-changed':
        // Changelogs print some metric names in capitals; requests use lowercase.
        return (
          call.metrics?.some((metric) => metric.toLowerCase() === change.name!.toLowerCase()) ??
          false
        );
      case 'parameter-removed':
      case 'parameter-changed':
        return call.parameters?.includes(change.name!) ?? false;
      // The values a request breaks down by are not traced, so any breakdown on insights counts.
      case 'breakdown-removed':
        return (
          call.edge === 'insights' &&
          (call.parameters?.some((name) => /^(action_)?breakdowns$/.test(name)) ?? false)
        );
      // A product shutdown names no endpoint a request could match; it stays an alert.
      case 'product-removed':
      case 'webhook-field-removed':
      case 'webhook-field-changed':
        return false;
    }
    return true;
  });
}

// WhatsApp Business Platform and Messenger Platform publish their own changelogs, which the change
// list does not cover, so a request that belongs to either stops any move of its version. A
// request belongs to them by its edge (or root endpoint), or by a parameter only their send APIs
// take.
const SEPARATE_CHANGELOG_EDGES = new Set([
  'messages',
  'message_templates',
  'phone_numbers',
  'whatsapp_business_profile',
  'register',
  'deregister',
  'request_code',
  'verify_code',
  'subscribed_apps',
  'messenger_profile',
  'conversations',
  'pass_thread_control',
  'take_thread_control',
  'request_thread_control',
  'release_thread_control',
  'thread_owner',
  'secondary_receivers',
  'personas',
  'message_attachments',
  'custom_labels',
  'nlp_configs',
  // Found in the WhatsApp and Messenger sample (docs/META-PLATFORM-CHANGELOGS.md): the WhatsApp
  // Calling API, coexistence sync, display-name and two-step PIN, phone-number settings and the
  // template library, and Messenger conversation moderation.
  'calls',
  'smb_app_data',
  'request_display_name',
  'pin',
  'settings',
  'message_template_library',
  'moderate_conversations',
]);
const SEPARATE_CHANGELOG_PARAMETERS = new Set([
  'messaging_product',
  'messaging_type',
  'recipient',
  'sender_action',
  // A WhatsApp media node read names the phone number it belongs to.
  'phone_number_id',
]);

function separateChangelog(call: GraphCall) {
  // A root endpoint such as `/message_template_library` is a path with no node before it.
  const root = call.path !== null && /^\/[a-z_]+$/.test(call.path) ? call.path.slice(1) : null;
  return (call.edge !== null && SEPARATE_CHANGELOG_EDGES.has(call.edge)) ||
    (root !== null && SEPARATE_CHANGELOG_EDGES.has(root)) ||
    (call.parameters ?? []).some((name) => SEPARATE_CHANGELOG_PARAMETERS.has(name))
    ? [
        `${call.file}:${call.line}: WhatsApp Business Platform and Messenger Platform requests follow their own changelogs, which the change list does not cover`,
      ]
    : [];
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

// The expression a string piece belongs to, climbing through templates, concatenation, the fallback
// of `process.env.X || '…'` and wrappers, and the variable it initializes, if any.
function holderOf(node: ts.Node): ts.VariableDeclaration | undefined {
  let current: ts.Node = node;
  while (
    current.parent &&
    ((ts.isBinaryExpression(current.parent) &&
      current.parent.right === current &&
      envDefault(current.parent) !== undefined) ||
      ts.isTemplateExpression(current.parent) ||
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
      if (kind === 'version' && HOST_PREFIX.test(before)) continue;
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
        `(graph\\.(?:facebook|instagram)\\.com/)${version.replace('.', '\\.')}(?![\\w.])`,
        'g',
      ),
    ),
  ];
  const quoted = [
    ...lineText.matchAll(new RegExp(`(['"\`])${version.replace('.', '\\.')}\\1`, 'g')),
  ];
  let start: number;
  if (inUrl.length === 1 && !quoted.length) start = lineStart + inUrl[0].index + inUrl[0][1].length;
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
  const initializer =
    holder.initializer && (envDefault(holder.initializer) ?? unwrap(holder.initializer));
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
  rules: AppliedRule[] = [],
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
  const testPins: { file: string; line: number; from: string; calls: GraphCall[] }[] = [];
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
    // Tests and examples follow the live moves, decided once those are known.
    if (calls.every((call) => call.use === 'test')) {
      testPins.push({ file, line, from, calls });
      continue;
    }
    const reasons = [...calls.flatMap(unknownParts), ...calls.flatMap(separateChangelog)];
    const crossed = crossedBetween(from);
    const unreviewed = crossed.filter((version) => records.get(version)?.status !== 'reviewed');
    if (unreviewed.length)
      reasons.push(
        `${unreviewed.join(', ')}: ${unreviewed.length === 1 ? 'this changelog is' : 'these changelogs are'} not reviewed in the Meta Graph API change list`,
      );
    const inRange = changes.changes.filter(
      (change) => change.version !== null && crossed.includes(change.version),
    );
    const rulesInRange = rules.filter(
      (rule) => rule.version !== null && crossed.includes(rule.version),
    );
    const ruleEdits: SourceEdit[] = [];
    const applied = new Set<string>();
    for (const call of calls) {
      const outcome = applyRules(call, rulesInRange, repository, calls, scan.calls);
      reasons.push(...outcome.reasons);
      ruleEdits.push(...outcome.edits);
      for (const edit of outcome.edits) applied.add(edit.changeId.replace('meta-graph-rule-', ''));
      for (const change of changesUsedBy(call, inRange))
        if (!outcome.covers.includes(change.id))
          reasons.push(
            `${call.file}:${call.line}: ${change.version} ${change.kind} ${change.id}: ${change.summary}`,
          );
    }
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
    moves.push({
      file,
      line,
      from,
      to: target,
      crossed,
      requests: calls.map(request),
      rules: [...applied].sort(),
    });
    for (const edit of ruleEdits)
      if (!edits.some((item) => item.file === edit.file && item.start === edit.start))
        edits.push(edit);
    edits.push({
      file,
      start: edit.start,
      end: edit.end,
      replacement: target,
      changeId: `meta-graph-version-${from}-${target}`,
      rule: META_GRAPH_VERSION_RULE,
    });
  }
  // A pin only tests use, such as a mocked fetch's expected URL, moves with the live requests it
  // describes: every one of its URLs names the path of a moved live request on the same version,
  // and none names the path of a live request that stays. Anything else stops as before.
  for (const pin of testPins) {
    const { file, line, from, calls } = pin;
    const moved = moves.filter((move) => move.from === from).flatMap((move) => move.requests);
    const stayed = stops.filter((stop) => stop.from === from).flatMap((stop) => stop.requests);
    const describes = (requests: VersionMoveRequest[], call: GraphCall) =>
      requests.some((item) => item.path !== null && samePath(call.path!, item.path));
    // A live request on this version whose path is unknown could be any endpoint a test describes.
    const follows =
      !stayed.some((item) => item.path === null) &&
      calls.every(
        (call) => call.path !== null && describes(moved, call) && !describes(stayed, call),
      );
    const edit = follows ? pinEdit(repository, file, line, from) : undefined;
    if (!edit || edit.reasons.length) {
      stops.push({
        file,
        line,
        from,
        requests: calls.map(request),
        reasons: [
          `${file}:${line}: only tests and examples use this version`,
          ...(edit?.reasons ?? []),
        ],
      });
      continue;
    }
    moves.push({
      file,
      line,
      from,
      to: target,
      crossed: crossedBetween(from),
      requests: calls.map(request),
      rules: [],
    });
    edits.push({
      file,
      start: edit.start,
      end: edit.end,
      replacement: target,
      changeId: `meta-graph-version-${from}-${target}`,
      rule: META_GRAPH_VERSION_RULE,
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
    edits,
  };
}
