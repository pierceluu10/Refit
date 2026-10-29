import { readFile } from 'node:fs/promises';
import ts from 'typescript-compiler';
import { daysUntil, type DeadlineRegistry } from './deadline-registry.ts';
import { META_SDK, TEST_PATH } from './deadline-exposure.ts';
import type { GraphReconstruction } from './meta-graph-ai.ts';
import { scanGraphCalls, sourceOf, type GraphCall } from './meta-graph-calls.ts';
import type { MetaGraphChanges } from './meta-graph-changes.ts';
import {
  changesUsedBy,
  fieldNames,
  pathMatches,
  proposeVersionMoves,
  type VersionMoveProposal,
} from './meta-graph-moves.ts';
import type { AppliedRule } from './meta-graph-rule-edits.ts';
import { readRepository } from './repository.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError, type Repository } from './types.ts';

// What Refit can do about a repository's Meta Graph API use, for a target version: the version
// moves with the documented rules they carry, product migrations that need a person (with Meta's
// documented plan), and dated alerts for permission, product and policy changes, which never edit
// code.

export const DEFAULT_META_PLATFORM_ALERTS = new URL(
  '../data/meta-platform-alerts.json',
  import.meta.url,
);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE = /^https:\/\/developers\.facebook\.com\/\S*$/;
const KINDS = ['permission-removed', 'permission-renamed', 'product-shutdown', 'policy'] as const;
const PRODUCTS = ['instagram-basic-display'] as const;

export interface MetaPlatformAlert {
  id: string;
  kind: (typeof KINDS)[number];
  // The day the change takes effect, when Meta's page states one.
  effective: string | null;
  // What identifies affected code: requested permissions, insights metrics, request paths, or a
  // product Refit recognises.
  match: {
    scopes?: string[];
    metrics?: string[];
    paths?: string[];
    products?: (typeof PRODUCTS)[number][];
  };
  replacement: string[] | null;
  summary: string;
  quote: string;
  source: string;
  checkedAt: string;
}

export async function loadMetaPlatformAlerts(
  path: string | URL = DEFAULT_META_PLATFORM_ALERTS,
): Promise<MetaPlatformAlert[]> {
  const value = parseObject(await readFile(path, 'utf8'), 'Meta platform alerts');
  if (value.formatVersion !== 1 || !Array.isArray(value.alerts))
    throw new PipelineInputError('Meta platform alerts need formatVersion 1 and alerts.');
  const ids = new Set<string>();
  return value.alerts.map((entry, index) => {
    const alert = entry as MetaPlatformAlert;
    const where = `Meta platform alert ${index + 1}`;
    const lists = isObject(alert.match) ? Object.entries(alert.match) : [];
    if (
      typeof alert.id !== 'string' ||
      ids.has(alert.id) ||
      !KINDS.includes(alert.kind) ||
      (alert.effective !== null && !ISO_DATE.test(String(alert.effective))) ||
      !lists.length ||
      lists.some(
        ([key, items]) =>
          !['scopes', 'metrics', 'paths', 'products'].includes(key) ||
          !Array.isArray(items) ||
          !items.length ||
          (key === 'products' && items.some((item) => !PRODUCTS.includes(item as never))),
      ) ||
      !SOURCE.test(String(alert.source)) ||
      !alert.quote ||
      !alert.summary ||
      !ISO_DATE.test(String(alert.checkedAt))
    )
      throw new PipelineInputError(
        `${where}: needs a unique id, a known kind, an ISO effective date or null, a match, a summary, the quote, a developers.facebook.com source and checkedAt.`,
      );
    ids.add(alert.id);
    return alert;
  });
}

export interface AlertHit {
  alert: string;
  kind: MetaPlatformAlert['kind'];
  effective: string | null;
  // Whether the change has taken effect on the day of the check.
  status: 'in-effect' | 'upcoming' | 'undated';
  file: string;
  line: number;
  matched: string;
  replacement: string[] | null;
  summary: string;
  source: string;
}

export interface ProductMigration {
  product: (typeof PRODUCTS)[number];
  // Every place the product is used, with what identifies it.
  uses: { file: string; line: number; evidence: string }[];
  // Meta's documented replacement, as steps for whoever makes the change.
  plan: string[];
  sources: string[];
}

// A live request that uses an out-of-cycle change: one Meta made to every version from a date, so
// the request is affected whatever version it pins, and no move fixes it.
export interface OutOfCycleUse {
  file: string;
  line: number;
  change: string;
  summary: string;
  replacement: string | null;
  source: string;
}

export interface MetaGraphFixPlan {
  target: string;
  proposal: VersionMoveProposal;
  migrations: ProductMigration[];
  alerts: AlertHit[];
  outOfCycle: OutOfCycleUse[];
}

// Out-of-cycle changes a live request names explicitly: a field or metric it requests that Meta
// removed or swapped for another identifier, or a parameter it sends that Meta removed, on the
// change's own edge or endpoint when the change names one. Parameter value changes (`VIDEO` no
// longer accepted for `media_type`) need the value, which is not traced; edge and endpoint changes,
// and behaviour changes with no replacement, match too broadly on every version at once. Those stay
// with the version moves and alerts.
function outOfCycleUses(calls: GraphCall[], changes: MetaGraphChanges): OutOfCycleUse[] {
  const always = changes.changes.filter(
    (change) =>
      change.version === null &&
      (/^(field|metric)-removed$/.test(change.kind) ||
        (/^(field|metric)-changed$/.test(change.kind) && change.replacement !== null) ||
        change.kind === 'parameter-removed'),
  );
  return calls
    .filter((call) => call.use === 'live')
    .flatMap((call) =>
      changesUsedBy(call, always)
        .filter(
          (change) =>
            (change.edge === null || change.edge === call.edge) &&
            (change.path === null || (call.path !== null && pathMatches(call.path, change.path))) &&
            (!change.kind.startsWith('field-') ||
              fieldNames(call.fields ?? []).has(change.name ?? '')),
        )
        .map((change) => ({
          file: call.file,
          line: call.line,
          change: change.id,
          summary: change.summary,
          replacement: change.replacement,
          source: change.source,
        })),
    );
}

const CODE = /\.[cm]?[jt]sx?$/;

// String literals and template pieces in code, with their line: where permissions are requested.
function literals(repository: Repository) {
  const found: { file: string; line: number; text: string }[] = [];
  for (const file of repository.files) {
    if (!CODE.test(file.path)) continue;
    if (!/facebook|instagram|\bFB\b|graph|scope/i.test(file.content)) continue;
    const source = sourceOf(file.path, file.content);
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      )
        found.push({
          file: file.path,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          text: node.text,
        });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

// Permission names as separate items: `scope=a,b`, `'a b'`, `['a', 'b']`.
function tokens(text: string) {
  return new Set(text.split(/[^A-Za-z0-9_]+/).filter(Boolean));
}

// Instagram Basic Display used `user_profile` and `user_media`, which no Instagram API with
// Instagram Login permission is named (its permissions are the instagram_business_* values).
const BASIC_DISPLAY_SCOPES = ['user_profile', 'user_media'];
const BASIC_DISPLAY_PLAN = [
  'The Instagram Basic Display API stopped working on 2024-12-04; move to the Instagram API with Instagram Login, which needs an Instagram professional (business or creator) account.',
  'Send users to https://www.instagram.com/oauth/authorize with instagram_business_* permissions, such as instagram_business_basic, in place of user_profile and user_media.',
  'Exchange the code at https://api.instagram.com/oauth/access_token, then for a long-lived token at graph.instagram.com/access_token with grant_type=ig_exchange_token, and refresh it at graph.instagram.com/refresh_access_token with grant_type=ig_refresh_token.',
  'Call graph.instagram.com with a version, such as /vNN.N/me, and check every requested field against the Instagram API with Instagram Login reference.',
];
const BASIC_DISPLAY_SOURCES = [
  'https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api',
  'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login',
];

function basicDisplay(found: ReturnType<typeof literals>): ProductMigration | null {
  const uses = found.flatMap((item) => {
    const names = BASIC_DISPLAY_SCOPES.filter((scope) => tokens(item.text).has(scope));
    return names.length
      ? [{ file: item.file, line: item.line, evidence: `requests ${names.join(', ')}` }]
      : [];
  });
  return uses.length
    ? {
        product: 'instagram-basic-display',
        uses,
        plan: BASIC_DISPLAY_PLAN,
        sources: BASIC_DISPLAY_SOURCES,
      }
    : null;
}

export function alertHits(
  alerts: MetaPlatformAlert[],
  calls: GraphCall[],
  found: ReturnType<typeof literals>,
  migrations: ProductMigration[],
  now: Date,
): AlertHit[] {
  const hits: AlertHit[] = [];
  const live = calls.filter((call) => call.use === 'live');
  for (const alert of alerts) {
    const hit = (file: string, line: number, matched: string) =>
      hits.push({
        alert: alert.id,
        kind: alert.kind,
        effective: alert.effective,
        status:
          alert.effective === null
            ? 'undated'
            : daysUntil(alert.effective, now) <= 0
              ? 'in-effect'
              : 'upcoming',
        file,
        line,
        matched,
        replacement: alert.replacement,
        summary: alert.summary,
        source: alert.source,
      });
    for (const scope of alert.match.scopes ?? [])
      for (const item of found) if (tokens(item.text).has(scope)) hit(item.file, item.line, scope);
    for (const metric of alert.match.metrics ?? [])
      for (const call of live)
        if (call.metrics?.some((item) => item.toLowerCase() === metric))
          hit(call.file, call.line, metric);
    for (const path of alert.match.paths ?? [])
      for (const call of live) if (call.path === path) hit(call.file, call.line, path);
    for (const product of alert.match.products ?? [])
      for (const migration of migrations.filter((item) => item.product === product))
        for (const use of migration.uses) hit(use.file, use.line, use.evidence);
  }
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.alert}\t${hit.file}\t${hit.line}\t${hit.matched}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function planMetaGraphFixes(
  directory: string,
  target: string,
  options: {
    changes: MetaGraphChanges;
    registry: DeadlineRegistry;
    rules: AppliedRule[];
    alerts: MetaPlatformAlert[];
    now: Date;
    reconstructions?: GraphReconstruction[];
  },
): Promise<MetaGraphFixPlan> {
  const proposal = await proposeVersionMoves(
    directory,
    target,
    options.changes,
    options.registry,
    options.now,
    options.rules,
    options.reconstructions,
  );
  const repository = await readRepository(directory, META_SDK);
  const scan = await scanGraphCalls(directory, {
    repository,
    reconstructions: options.reconstructions,
  });
  const found = literals(repository).filter((item) => !TEST_PATH.test(item.file));
  const migrations = [basicDisplay(found)].filter((item) => item !== null);
  return {
    target,
    proposal,
    migrations,
    alerts: alertHits(options.alerts, scan.calls, found, migrations, options.now),
    outOfCycle: outOfCycleUses(scan.calls, options.changes),
  };
}
