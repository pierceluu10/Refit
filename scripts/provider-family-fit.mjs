// Classifies every breaking change Refit has recorded for a provider without a built-in adapter by
// what it would take to handle: an existing rule-pack edit family, a provider-independent mechanism,
// a review stop that a pack can already express, or new code. Reads only committed files under
// data/, each generated from or checked against a provider page; it never fetches anything.
// Methodology and the ranked result: docs/PROVIDER-FAMILY-FIT.md.
//
//   node scripts/provider-family-fit.mjs             # counts per provider, ranked
//   node scripts/provider-family-fit.mjs --changes   # also every classified change
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AGENT_CATALOG } from '../pipeline/agent-catalog.ts';

// Built-in adapters with their own packs; they are the reference, not candidates.
const BUILT_IN = new Set(['stripe', 'shopify']);

// The same test as MODEL_ID in pipeline/model-retirements.ts: a registry replacement the
// model-retirement rule can write as a literal (pinned by pipeline/provider-family-fit.test.ts).
export const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;

// The model-retirement rule edits only text-generation calls (MODEL_CALLS in
// pipeline/model-retirements.ts); embeddings, images, audio, video, moderation and legacy
// completions change formats or endpoints with the model. The registry does not record a model's
// modality, so its ID decides.
export const NON_TEXT_MODEL =
  /embed|imagen|veo|image|dall-e|tts|whisper|transcribe|audio|realtime|live|moderation|instruct|^babbage|^davinci|omni/;

// GitHub's REST breaking changes are prose titles; these patterns, in order, give each its shape.
export const GITHUB_REST_TITLES = [
  [/^(Change|Updates?)\b|media type/i, 'semantic-change'],
  [/^Remove deprecated \/\S+ endpoint$/i, 'endpoint-removed'],
  [/\benum\b/i, 'semantic-change'],
  // "request" but not "pull request", and no response side: only the request lost the parameter.
  [/^Remove\b(?!.*\bresponses?\b).*(?<!pull )\brequest\b/i, 'request-parameter-removed'],
  [/^(Remove|Deprecate)\b|\bremoves\b/i, 'field-removed'],
];

// One rule per change shape. `category` is what the change needs: `mechanism` (provider-independent
// edit code), `review` (a stop that existing code or a pack entry already expresses) or `new-code`.
// No rule reaches the pack edit families (moved-value, moved-id, period-helper, request-rename,
// request-wrap): each needs a removed field or parameter with a recorded replacement path of the
// same value, and no data file outside Stripe records one.
export const RULES = {
  'model-replacement': {
    category: 'mechanism',
    family: 'model-retirement',
    rule: 'A retired text-generation model whose registry replacement is a concrete model ID: the model-retirement rule rewrites the literal.',
  },
  'model-stop': {
    category: 'review',
    family: 'model-stops',
    rule: 'A retired model with no concrete replacement, or one that is not text generation: refit deadlines reports the literal and nothing edits it.',
  },
  'same-operation': {
    category: 'mechanism',
    family: 'operationReplacements',
    rule: 'An SDK member removed while the same data records another member that serves the same operation (same HTTP method and path, or the same resource under a new parent): an adapter operationReplacements entry renames the call, after its contract check.',
  },
  'sdk-member': {
    category: 'review',
    family: 'symbolReviews',
    rule: 'An SDK member removed or deprecated with no recorded member serving the same operation: uses of the identifier stop with the reason.',
  },
  'endpoint-with-member': {
    category: 'review',
    family: 'symbolReviews',
    rule: 'An endpoint removed or deprecated that a recorded SDK member of the latest release calls: uses of that member stop with the reason.',
  },
  'field-removed': {
    category: 'review',
    family: 'readReviews',
    rule: 'A response field removed with no recorded replacement of the same value: reads stop with the reason.',
  },
  'request-parameter-removed': {
    category: 'review',
    family: 'request-removals',
    rule: 'A request parameter removed: a traced call that still sends it stops (pipeline/request-removals.ts, once both contracts are recorded).',
  },
  'request-review': {
    category: 'new-code',
    family: 'request-review',
    rule: 'An endpoint, edge or request value removed with no SDK member recorded for it: stopping needs a family keyed by HTTP method and path that no pack has.',
  },
  'semantic-change': {
    category: 'new-code',
    family: 'semantic-change',
    rule: 'Same name, different behaviour, type, status or enum values: no family can rewrite it, and a stop needs request-level review code.',
  },
  'graphql-document': {
    category: 'new-code',
    family: 'graphql-documents',
    rule: 'A GraphQL schema change: found by validating query documents, which only Shopify has, as Shopify code.',
  },
  'version-pin': {
    category: 'new-code',
    family: 'version-pin',
    rule: 'An API version retired: moving the pin is provider code for Stripe and Shopify, not a family.',
  },
  'sdk-replacement': {
    category: 'new-code',
    family: 'sdk-replacement',
    rule: 'An SDK package or major retired: the replacement changes call shapes or the lockfile, which only provider code (stripe-node, Shopify SDK upgrades) does.',
  },
  'feature-retirement': {
    category: 'new-code',
    family: 'feature-retirement',
    rule: 'A credential, key or product feature retired: there is no SDK call to rewrite.',
  },
  'runtime-flag': {
    category: 'new-code',
    family: 'runtime-flag',
    rule: 'A Workers compatibility flag that turns on by compatibility date: runtime behaviour, not an API call.',
  },
};

// Picks the rule for one normalized change. Every collector below produces these shapes.
export function classify(change) {
  switch (change.shape) {
    case 'model-retired':
      return MODEL_ID.test(change.replacement ?? '') && !NON_TEXT_MODEL.test(change.key)
        ? 'model-replacement'
        : 'model-stop';
    case 'sdk-member-removed':
      return change.sameOperation ? 'same-operation' : 'sdk-member';
    case 'endpoint-removed':
      return change.member ? 'endpoint-with-member' : 'request-review';
    case 'request-value-removed':
      return 'request-review';
    case 'field-removed':
    case 'request-parameter-removed':
    case 'semantic-change':
    case 'graphql-document':
    case 'version-pin':
    case 'sdk-replacement':
    case 'feature-retirement':
    case 'runtime-flag':
      return change.shape;
    default:
      throw new Error(`Unknown change shape ${change.shape} for ${change.provider} ${change.key}.`);
  }
}

// `GET /a/{id}` and `GET /a/{order_id}` are the same operation.
const route = (method, path) => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`;
const lastRelease = (range) => range.split('..').at(-1);

function deadlineChanges(deadlines, owners) {
  const shapes = {
    'api-version': 'version-pin',
    sdk: 'sdk-replacement',
    feature: 'feature-retirement',
    field: 'graphql-document',
  };
  return deadlines.flatMap((entry) =>
    entry.versions.map((version) => {
      const base = { provider: entry.provider, source: `deadlines.json#${entry.id}` };
      if (entry.kind === 'model')
        return { ...base, key: version, shape: 'model-retired', replacement: entry.replacement };
      if (entry.kind === 'endpoint') {
        const [method, path] = version.split(' ');
        return path
          ? endpointChange(
              entry.provider,
              owners[entry.provider] ?? new Map(),
              method,
              path,
              base.source,
            )
          : { ...base, key: version, shape: 'endpoint-removed', member: null };
      }
      // Slack's retired methods, which the SDK data records too.
      if (entry.kind === 'method')
        return { ...base, key: version, shape: 'sdk-member-removed', sameOperation: false };
      if (entry.kind === 'field')
        return { ...base, key: `graphql:${version}`, shape: shapes[entry.kind] };
      if (!shapes[entry.kind])
        throw new Error(`Unknown deadline kind ${entry.kind} in ${entry.id}.`);
      return { ...base, key: version, shape: shapes[entry.kind] };
    }),
  );
}

const callRoute = (call) =>
  call.route ? route(...call.route.split(' ')) : route(call.method, call.path);

// Each route an SDK has called, from `{ member: [{ route | method+path, releases }] }`, mapped to
// the member that calls it, preferring one the latest release still has.
function routeMembers(members, latest) {
  const found = new Map();
  for (const [member, calls] of Object.entries(members))
    for (const call of calls) {
      const key = callRoute(call);
      const live = lastRelease(call.releases) === latest;
      if (!found.has(key) || (live && !found.get(key).live)) found.set(key, { member, live });
    }
  return found;
}

function removedMembers(provider, file, members, latest) {
  const owners = routeMembers(members, latest);
  return Object.entries(members)
    .filter(([, calls]) => !calls.some((call) => lastRelease(call.releases) === latest))
    .map(([member, calls]) => {
      const live = calls.map((call) => owners.get(callRoute(call))).find((owner) => owner.live);
      return {
        provider,
        key: member,
        shape: 'sdk-member-removed',
        sameOperation: Boolean(live),
        replacement: live?.member ?? null,
        source: `${file}#${member}`,
      };
    });
}

// A removed endpoint is the change to the SDK member that calls it, when one ever did, so it merges
// with that member's removal instead of being counted twice.
function endpointChange(provider, owners, method, path, source) {
  const owner = owners.get(route(method, path));
  return {
    provider,
    key: owner?.member ?? route(method, path),
    shape: 'endpoint-removed',
    member: owner?.member ?? null,
    source,
  };
}

function githubChanges(github, owners) {
  const titleShape = (title) => GITHUB_REST_TITLES.find(([pattern]) => pattern.test(title))?.[1];
  return [
    ...removedMembers('github', 'github-api.json', github.octokit.methods, github.octokit.latest),
    ...github.openapi.deprecated.map((operation) =>
      endpointChange(
        'github',
        owners,
        operation.method,
        operation.path,
        'github-api.json#openapi.deprecated',
      ),
    ),
    ...Object.entries(github.rest.breakingChanges).flatMap(([version, changes]) =>
      changes.map((change) => ({
        provider: 'github',
        key: change.title,
        shape: titleShape(change.title) ?? 'semantic-change',
        source: `github-api.json#rest.breakingChanges.${version}`,
      })),
    ),
    ...github.graphql.changes.map((change) => ({
      provider: 'github',
      key: `graphql:${change.location}`,
      shape: 'graphql-document',
      source: 'github-api.json#graphql.changes',
    })),
  ];
}

function cloudflareChanges(cloudflare, owners) {
  const { sdk, openapi, announcements, compatibilityFlags } = cloudflare;
  const endpoint = (method, path, source) =>
    endpointChange('cloudflare', owners, method, path, source);
  return [
    ...removedMembers('cloudflare', 'cloudflare-endpoints.json', sdk.properties, sdk.latest),
    ...openapi.deprecated.map((operation) =>
      endpoint(operation.method, operation.path, 'cloudflare-endpoints.json#openapi.deprecated'),
    ),
    ...announcements.entries.flatMap((entry) => {
      const source = `cloudflare-endpoints.json#announcements.${entry.title}`;
      if (!entry.endpoints.length)
        return [{ provider: 'cloudflare', key: entry.title, shape: 'semantic-change', source }];
      return entry.endpoints.map((item) =>
        item.change === 'deprecated'
          ? endpoint(item.method, item.path, source)
          : {
              provider: 'cloudflare',
              key: `${entry.title}: ${route(item.method, item.path)}`,
              shape: 'semantic-change',
              source,
            },
      );
    }),
    // Flags without an enable date are opt-in, and experimental ones never turn on by date.
    ...compatibilityFlags.flags
      .filter((flag) => flag.enableDate && !flag.experimental)
      .map((flag) => ({
        provider: 'cloudflare',
        key: `flag:${flag.enableFlag}`,
        shape: 'runtime-flag',
        source: 'cloudflare-endpoints.json#compatibilityFlags',
      })),
  ];
}

function slackChanges(slack) {
  const { webApi, nodeSdk } = slack;
  const removed = new Map(nodeSdk.removed.map((item) => [item.method, item]));
  return Object.entries(webApi.properties)
    .filter(
      ([name, item]) =>
        item.deprecated !== null || !item.releases.includes(webApi.latest) || removed.has(name),
    )
    .map(([name]) => ({
      provider: 'slack',
      key: name,
      shape: 'sdk-member-removed',
      // Slack's data records no routes, so no replacement can be shown to be the same operation.
      sameOperation: false,
      replacement: removed.get(name)?.replacement ?? null,
      source: `slack-methods.json#webApi.properties.${name}`,
    }));
}

function paypalChanges(paypal) {
  const controllers = Object.fromEntries(
    Object.entries(paypal.server.controllers).flatMap(([controller, methods]) =>
      Object.entries(methods).map(([name, call]) => [
        `${controller}.${name}`,
        [{ ...call, releases: call.releases.at(-1) }],
      ]),
    ),
  );
  return [
    ...removedMembers('paypal', 'paypal-requests.json', controllers, paypal.server.releases.at(-1)),
    // The deprecated SDK's request classes become controller calls in another package.
    ...Object.values(paypal.checkout.requests).flatMap((classes) =>
      Object.keys(classes).map((name) => ({
        provider: 'paypal',
        key: name,
        shape: 'sdk-replacement',
        source: `paypal-requests.json#checkout.requests.${name}`,
      })),
    ),
  ];
}

function metaChanges(meta) {
  const shapes = {
    'field-removed': 'field-removed',
    'parameter-removed': 'request-parameter-removed',
    'metric-removed': 'request-value-removed',
    'edge-removed': 'endpoint-removed',
    'endpoint-removed': 'endpoint-removed',
    'field-changed': 'semantic-change',
    'parameter-changed': 'semantic-change',
    'edge-changed': 'semantic-change',
  };
  return meta.changes.map((change) => {
    if (!shapes[change.kind]) throw new Error(`Unknown Meta change kind ${change.kind}.`);
    return {
      provider: 'meta-graph',
      key: change.id,
      shape: shapes[change.kind],
      source: `meta-graph-changes.json#${change.id}`,
    };
  });
}

function messagingChanges(messaging, endpoints) {
  const providers = {
    twilio: 'twilio',
    'mailgun.js': 'mailgun',
    sendgrid: 'sendgrid',
    'mailgun-js': 'mailgun',
  };
  const lastSegment = (path) => path.split('.').at(-1);
  return [
    ...Object.entries(messaging.sdks).flatMap(([name, sdk]) =>
      sdk.members.map((member) => ({
        provider: providers[name],
        key: member.path,
        shape: 'sdk-member-removed',
        // Twilio's deprecated getters are the same resource reached through a new parent.
        sameOperation:
          Boolean(member.replacement) &&
          lastSegment(member.replacement) === lastSegment(member.path),
        replacement: member.replacement,
        source: `messaging-deprecations.json#sdks.${name}`,
      })),
    ),
    ...Object.keys(messaging.retired).map((name) => ({
      provider: providers[name],
      key: name,
      shape: 'sdk-replacement',
      source: `messaging-deprecations.json#retired.${name}`,
    })),
    ...endpoints.endpoints.map((item) => ({
      provider: item.provider,
      key: item.path,
      shape: 'endpoint-removed',
      source: 'messaging-endpoints.json',
    })),
  ];
}

const cloudSdkChanges = (aws, azure) => [
  ...Object.values(aws.clients).map((client) => ({
    provider: 'aws',
    key: `aws-sdk/${client.serviceId}`,
    shape: 'sdk-replacement',
    source: 'aws-sdk-v2-clients.json',
  })),
  ...azure.packages.map((item) => ({
    provider: 'azure',
    key: item.name,
    shape: 'sdk-replacement',
    source: 'azure-sdk-retirements.json',
  })),
];

// Each provider's changes from every file, one per provider and key. Specific files come before
// the deadline registry, so a registry entry for the same key only adds its source.
export function collectChanges(read) {
  const github = read('github-api.json');
  const cloudflare = read('cloudflare-endpoints.json');
  const owners = {
    github: routeMembers(github.octokit.methods, github.octokit.latest),
    cloudflare: routeMembers(cloudflare.sdk.properties, cloudflare.sdk.latest),
  };
  const all = [
    ...githubChanges(github, owners.github),
    ...cloudflareChanges(cloudflare, owners.cloudflare),
    ...slackChanges(read('slack-methods.json')),
    ...paypalChanges(read('paypal-requests.json')),
    ...metaChanges(read('meta-graph-changes.json')),
    ...messagingChanges(read('messaging-deprecations.json'), read('messaging-endpoints.json')),
    ...cloudSdkChanges(read('aws-sdk-v2-clients.json'), read('azure-sdk-retirements.json')),
    ...deadlineChanges(read('deadlines.json').deadlines, owners),
  ].filter((change) => !BUILT_IN.has(change.provider));
  const unique = new Map();
  for (const change of all) {
    const id = `${change.provider}\u0000${change.key}`;
    const found = unique.get(id);
    if (found) found.sources.push(change.source);
    else {
      const { source, ...rest } = change;
      unique.set(id, { ...rest, sources: [source] });
    }
  }
  return [...unique.values()].map((change) => {
    const rule = classify(change);
    return { ...change, rule, category: RULES[rule].category, family: RULES[rule].family };
  });
}

const share = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

// Counts per provider, ranked by changes handled without new code, then by automatic edits.
// Catalog providers with no recorded change are listed as unknown.
export function rankProviders(changes, providerIds) {
  const rows = providerIds.map((provider) => {
    const own = changes.filter((change) => change.provider === provider);
    const count = (category) => own.filter((change) => change.category === category).length;
    const families = {};
    for (const change of own) families[change.family] = (families[change.family] ?? 0) + 1;
    const edits = count('mechanism');
    const covered = edits + count('review');
    return {
      provider,
      recorded: own.length,
      edits,
      review: count('review'),
      covered,
      coveredPercent: share(covered, own.length),
      editPercent: share(edits, own.length),
      newCode: count('new-code'),
      families,
      sources: [
        ...new Set(own.flatMap((change) => change.sources.map((source) => source.split('#')[0]))),
      ].sort(),
    };
  });
  const known = rows
    .filter((row) => row.recorded)
    .sort(
      (a, b) => b.covered - a.covered || b.edits - a.edits || a.provider.localeCompare(b.provider),
    );
  return { ranked: known, unknown: rows.filter((row) => !row.recorded).map((row) => row.provider) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { changes: { type: 'boolean' } } });
  const read = (name) =>
    JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
  const changes = collectChanges(read);
  const candidates = AGENT_CATALOG.map((agent) => agent.id).filter((id) => !BUILT_IN.has(id));
  const outside = [...new Set(changes.map((change) => change.provider))].filter(
    (id) => !candidates.includes(id),
  );
  if (outside.length)
    throw new Error(`Changes for providers outside the catalog: ${outside.join(', ')}.`);
  const result = { rules: RULES, ...rankProviders(changes, candidates) };
  console.log(JSON.stringify(values.changes ? { ...result, changes } : result, null, 2));
}
