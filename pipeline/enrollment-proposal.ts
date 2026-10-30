import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript-compiler';
import { scaffoldChecks } from './agent-catalog.ts';
import { analyzeRepository, SourceParseError } from './analyzer.ts';
import { selectCheck } from './check-selection.ts';
import {
  validateApiVersion,
  type ApiVersionDeclaration,
  type ApiVersionSource,
} from './api-version.ts';
import {
  latestStripeContract,
  stripeContractFile,
  stripeContractVersion,
  stripeContractVersions,
} from './enrollment-contracts.ts';
import { PNPM_LOCKFILE } from './pnpm-lock.ts';
import { STRIPE } from './providers.ts';
import { readRepository } from './repository.ts';
import { NO_OP_CHECK } from './review.ts';
import { configurationTarget } from './source-configurations.ts';
import { isObject, parseObject } from './specifications.ts';
import { STRIPE_SDK_RELEASES } from './stripe-package-upgrade.ts';
import { PipelineInputError, type Location, type Repository } from './types.ts';
import { NODE_22_IMAGE } from './validation-runtime.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';
import { YARN_LOCKFILE } from './yarn-lock.ts';

export const STRIPE_INTEGRATION = 'stripe';
const MANIFEST = 'package.json';
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
// stripe-node 12 is the first major that sends its own API version (pipeline/api-version.ts).
const FIRST_PINNING_MAJOR = 12;
const MAX_PLACES = 3;
const MAX_QUOTED = 60;
// Stops after which a configuration can still run (owner decision 1, #300), each a reason every
// draft is titled [Needs review]: without a lockfile preparation fails, without checks the command
// is a no-op, and an API version Refit cannot read, or several, is assumed or moved together.
const REVIEWED_STOPS = new Set([
  'no-lockfile',
  'no-checks',
  'api-version-unreadable',
  'stripe-not-locked',
  'api-version-account-default',
  'api-version-several',
  'api-version-assumed',
]);

// Why Refit cannot propose a configuration: one plain sentence and what Refit could not do.
export interface EnrollmentStop {
  id: string;
  detail: string;
  action: string;
}

export interface StripeProposal {
  // The .refit.json Refit uses when the repository commits none.
  configuration: { formatVersion: 2; integrations: Record<string, unknown>[] };
  apiVersion: { value: string; source: string };
  target: string;
  checks: { kind: 'tests' | 'typecheck' | 'none'; source: string; reason: string };
  // Why each draft under this configuration needs review; empty unless allowUntested proposed it.
  reviews: EnrollmentStop[];
}

const at = (location: Location) => `${location.file}:${location.line}`;

// Names at most a few places, so a proposal over many clients stays one readable line.
export function listed(names: string[]) {
  if (names.length > MAX_PLACES)
    return `${names.slice(0, MAX_PLACES).join(', ')} and ${names.length - MAX_PLACES} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

const places = (locations: Location[]) => listed(locations.map(at));

const release = (version: string) => RELEASE.exec(version)?.slice(1).map(Number);

function compareReleases(left: number[], right: number[]) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

// The API version a stripe-node release sends when the client sets none: the API version of the
// first recorded release at or after it in the same major. Refit knows the last release of each API
// version, so a release in a major the table skips, or before 12, has no known default.
export function stripeNodeDefaultVersion(locked: string) {
  const version = release(locked);
  if (!version || version[0] < FIRST_PINNING_MAJOR) return undefined;
  const match = Object.entries(STRIPE_SDK_RELEASES)
    .map(([apiVersion, published]) => ({ apiVersion, published: release(published)! }))
    .sort((left, right) => compareReleases(left.published, right.published))
    .find((entry) => compareReleases(entry.published, version) >= 0);
  return match?.published[0] === version[0] ? match.apiVersion : undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression)
    ? unwrap(expression.expression)
    : expression;
}

// The code a stop names, on one line and cut short.
function quoted(node: ts.Node, source: ts.SourceFile) {
  const text = node.getText(source).replace(/\s+/g, ' ');
  return text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED - 1)}…` : text;
}

// The client creation or request call the tracer reported at a declaration's location.
function declaredCall(files: Repository['files'], declaration: ApiVersionDeclaration) {
  const file = files.find((entry) => entry.path === declaration.file);
  if (!file) return undefined;
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const position = source.getPositionOfLineAndCharacter(
    declaration.line - 1,
    declaration.column - 1,
  );
  let call: ts.NewExpression | ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (call || node.getEnd() < position || node.getStart(source) > position) return;
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      node.getStart(source) === position
    )
      call = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return call && { call, source };
}

// Where the source creates a Stripe client, read from each file alone: `new X(...)` or `X(...)` on
// a binding imported or required from stripe, or `require('stripe')(...)`. It names the clients a
// stop is about when the tracer follows none of them.
function writtenClients(files: Repository['files']) {
  const clients: Location[] = [];
  const quotedPackage = new RegExp(`['"]${STRIPE.packageName}['"]`);
  for (const file of files) {
    if (!quotedPackage.test(file.content)) continue;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const isPackage = (node: ts.Node) =>
      ts.isStringLiteralLike(node) && node.text === STRIPE.packageName;
    const required = (node: ts.Node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      isPackage(node.arguments[0]);
    const bindings = new Set<string>();
    const creations: (ts.NewExpression | ts.CallExpression)[] = [];
    const visit = (node: ts.Node) => {
      const clause =
        ts.isImportDeclaration(node) && isPackage(node.moduleSpecifier) && node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) bindings.add(clause.name.text);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const element of clause.namedBindings.elements)
            if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'Stripe')
              bindings.add(element.name.text);
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        isPackage(node.moduleReference.expression)
      )
        bindings.add(node.name.text);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        required(unwrap(node.initializer))
      )
        bindings.add(node.name.text);
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) creations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const creation of creations) {
      const callee = unwrap(creation.expression);
      if ((ts.isIdentifier(callee) && bindings.has(callee.text)) || required(callee)) {
        const { line, character } = source.getLineAndCharacterOfPosition(creation.getStart(source));
        clients.push({ file: file.path, line: line + 1, column: character + 1 });
      }
    }
  }
  return clients;
}

const UNREAD = 'its apiVersion is not a string literal Refit can read';

// The apiVersion written where a client is created, for a constructor the tracer could not follow
// to every use (an exported client, one handed to a plugin, one created lazily). Only a string
// literal in the options object, or no option at all, is read; anything else is named as unread.
function writtenVersion(
  files: Repository['files'],
  declaration: ApiVersionDeclaration,
): { value: string } | 'absent' | { unread: string } {
  const found = declaredCall(files, declaration);
  if (!found) return { unread: UNREAD };
  const { call: creation, source } = found;
  const spread = creation.arguments?.find(ts.isSpreadElement);
  if (spread)
    return {
      unread: `its arguments include ${quoted(spread, source)}, which Refit cannot trace to an apiVersion`,
    };
  const argument = creation.arguments?.[STRIPE.apiVersion!.constructorArgument];
  if (!argument) return 'absent';
  const options = unwrap(argument);
  if (!ts.isObjectLiteralExpression(options))
    return {
      unread: `its options are ${quoted(options, source)}, which Refit cannot trace to an apiVersion`,
    };
  const other = options.properties.find((property) => !ts.isPropertyAssignment(property));
  if (other)
    return { unread: `its options include ${quoted(other, source)}, which may set apiVersion` };
  const computed = options.properties.find(
    (property) => property.name && ts.isComputedPropertyName(property.name),
  );
  if (computed)
    return { unread: `its options include ${quoted(computed, source)}, which may set apiVersion` };
  const named = options.properties
    .filter(ts.isPropertyAssignment)
    .filter(
      (property) =>
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === STRIPE.apiVersion!.property,
    );
  // The runtime sends the last of repeated keys; Refit does not guess which one was meant.
  if (named.length > 1) return { unread: `its options set apiVersion ${named.length} times` };
  const [option] = named;
  if (!option) return 'absent';
  const value = unwrap(option.initializer);
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))
    return {
      unread: `its apiVersion is ${quoted(value, source)}, which Refit cannot trace to one version`,
    };
  try {
    return { value: validateApiVersion(value.text)! };
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return { unread: `its apiVersion ${quoted(value, source)} is not a Stripe API version` };
  }
}

// What keeps Refit from seeing whether a request overrides the client's version: the first
// argument where stripe-node takes request options that is not an object literal Refit reads, or
// an apiVersion option that is not a string literal.
function requestOptions(files: Repository['files'], declaration: ApiVersionDeclaration) {
  const found = declaredCall(files, declaration);
  for (const [index, argument] of found?.call.arguments?.entries() ?? []) {
    if (!ts.isSpreadElement(argument) && !STRIPE.apiVersion!.requestArguments.includes(index))
      continue;
    const options = unwrap(argument);
    if (!ts.isObjectLiteralExpression(options))
      return { text: quoted(options, found!.source), sets: false };
    for (const property of options.properties) {
      if (!ts.isPropertyAssignment(property))
        return { text: quoted(property, found!.source), sets: false };
      if (
        property.name.getText(found!.source).replace(/['"]/g, '') === STRIPE.apiVersion!.property &&
        !ts.isStringLiteralLike(unwrap(property.initializer))
      )
        return { text: quoted(property, found!.source), sets: true };
    }
  }
  return undefined;
}

// A request whose options Refit cannot read. When every client sends one version, the fix names it.
function unreadableRequest(
  files: Repository['files'],
  request: ApiVersionDeclaration,
  used: string[],
): EnrollmentStop {
  const options = requestOptions(files, request);
  const uses = `Refit cannot tell which Stripe API version the request at ${at(request)} uses`;
  if (!options || options.sets)
    return {
      id: 'api-version-unreadable',
      detail: `${uses}: ${options ? `it sets ${options.text}, which Refit cannot trace to one version` : UNREAD}.`,
      action: `Refit cannot read the request's apiVersion at ${at(request)} as one version; check which version that request sends before merging a draft.`,
    };
  return {
    id: 'api-version-unreadable',
    detail: `${uses}: it passes ${options.text}, and Refit cannot tell whether that sets apiVersion.`,
    action: `If ${options.text} sets no apiVersion, the request sends ${used.length === 1 ? `${used[0]}, the version the clients send` : 'the version the clients send'}; check this before merging a draft.`,
  };
}

// The package.json that decides the stripe-node release a file loads: the nearest one above it
// that declares stripe, as Node resolves it from that package's node_modules.
function stripeOwner(dependencies: Repository['dependencies']) {
  const packages = [...dependencies].sort(
    (left, right) => dirname(right.file).length - dirname(left.file).length,
  );
  return (file: string) =>
    packages.find(
      (dependency) =>
        dirname(dependency.file) === '.' || file.startsWith(`${dirname(dependency.file)}/`),
    );
}

// Each tsconfig `extends` Refit does not follow: one named by package (a workspace's shared
// tsconfig or an npm base), or a file the repository does not commit (.nuxt/tsconfig.json, which a
// build writes). Refit cannot tell how imports resolve under it.
function unreadableExtends(configurations: Repository['files']) {
  const committed = new Set(configurations.map((file) => file.path));
  return configurations.flatMap((file) => {
    const { config } = ts.parseConfigFileTextToJson(file.path, file.content);
    return [isObject(config) ? config.extends : undefined]
      .flat()
      .filter(
        (parent): parent is string =>
          typeof parent === 'string' &&
          (!/^\.\.?\//.test(parent) ||
            !configurationTarget((name) => committed.has(name), join(dirname(file.path), parent))),
      )
      .map((parent) => ({ file: file.path, parent }));
  });
}

// The reason and fix a person reads when a tsconfig `extends` Refit does not read is why it stops.
export function unreadableExtendsReason(configurations: Repository['files']) {
  const unreadable = unreadableExtends(configurations);
  if (!unreadable.length) return null;
  return {
    files: unreadable.map(({ file }) => file),
    named: `${listed(unreadable.map(({ file, parent }) => `${file} extends ${parent}`))}, which Refit does not read`,
    action: `Nothing in your code needs to change: Refit reads only committed tsconfig files that an extends names by a relative path, so it stops here until it can read ${listed([...new Set(unreadable.map(({ parent }) => parent))])}.`,
  };
}

// With allowUntested (owner decision 1) a version Refit cannot read, or several versions, is a
// reason each draft needs review, not a refusal; the configuration takes the oldest version the
// code sends, else the locked stripe-node default, else the oldest contract Refit has.
function applicationVersion(
  declarations: ApiVersionDeclaration[],
  repository: Repository,
  allowUntested = false,
): { value: string; source: string; reviews: EnrollmentStop[] } | EnrollmentStop[] {
  const reviews: EnrollmentStop[] = [];
  // Clients whose version Refit cannot read; only allowUntested gets past them.
  const unread: Location[] = [];
  const owner = stripeOwner(repository.dependencies);
  const unreadable = unreadableExtendsReason(repository.configurations ?? []);
  const creates = (found: ApiVersionDeclaration[]) =>
    found.some((declaration) => declaration.kind === 'constructor');
  if (!creates(declarations)) {
    // A tsconfig is the cause only when tracing the imports Refit cannot verify finds a client.
    const traced = analyzeRepository(repository, [], STRIPE, {}, [], [], [], [], {
      traceUnverifiedPackageImports: true,
    });
    const unverified = [
      ...new Set(traced.sourceWarnings.map((warning) => warning.slice(0, warning.indexOf(':')))),
    ];
    if (creates(traced.apiVersionDeclarations) && (unreadable || unverified.length))
      return [
        unreadable
          ? {
              id: 'source-resolution',
              detail: `Refit found no Stripe client it can follow, because ${unreadable.named}, so it cannot tell how imports resolve.`,
              action: unreadable.action,
            }
          : {
              id: 'source-resolution',
              detail: `Refit found no Stripe client it can follow, because it cannot verify how imports resolve under ${listed(unverified)}.`,
              action: `Nothing in your code needs to change: Refit stops here until it can verify how ${listed(unverified)} ${unverified.length === 1 ? 'resolves' : 'resolve'} imports.`,
            },
      ];
    const written = writtenClients(repository.files);
    return [
      written.length
        ? {
            id: 'no-stripe-client',
            detail: `Refit sees ${written.length === 1 ? 'a Stripe client' : 'Stripe clients'} created at ${places(written)}, but cannot follow ${written.length === 1 ? 'it' : 'them'} to the calls that use ${written.length === 1 ? 'it' : 'them'}.`,
            action: `Nothing in your code needs to change: Refit follows a client created directly in a const declaration, such as const stripe = new Stripe(secretKey, { apiVersion: '<your API version>' }), so it stops here until it can follow ${written.length === 1 ? 'this one' : 'these'}.`,
          }
        : {
            id: 'no-stripe-client',
            detail: 'Refit found no new Stripe(...) client in this repository that it can follow.',
            action: `Refit follows a client created with new Stripe(secretKey, { apiVersion: '<your API version>' }), so it has no Stripe calls to check here.`,
          },
    ];
  }
  const pinned: (Location & { value: string })[] = [];
  const absent: Location[] = [];
  const unfollowed: Location[] = [];
  const requests: ApiVersionDeclaration[] = [];
  for (const declaration of declarations) {
    if (declaration.value !== null) pinned.push({ ...declaration, value: declaration.value });
    else if (declaration.absent) absent.push(declaration);
    else if (declaration.status === 'unknown' && declaration.kind === 'request')
      requests.push(declaration);
    else if (declaration.status === 'unknown') {
      const written = writtenVersion(repository.files, declaration);
      if (written !== 'absent' && 'unread' in written) {
        const unreadable = {
          id: 'api-version-unreadable',
          detail: `Refit cannot tell which Stripe API version the client at ${at(declaration)} uses: ${written.unread}.`,
          action: `Refit reads an apiVersion only as a string literal, such as new Stripe(secretKey, { apiVersion: '<your API version>' }); check the version the client at ${at(declaration)} sends before merging a draft.`,
        };
        if (!allowUntested) return [unreadable];
        reviews.push(unreadable);
        unread.push(declaration);
        continue;
      }
      unfollowed.push(declaration);
      if (written === 'absent') absent.push(declaration);
      else pinned.push({ ...declaration, value: written.value });
    }
  }
  const defaults: (Location & { release: string; value: string })[] = [];
  for (const client of absent) {
    const dependency = owner(client.file);
    const release = dependency?.lock.status === 'locked' ? dependency.lock.version : null;
    const value = release ? stripeNodeDefaultVersion(release) : undefined;
    const unknown = !release
      ? dependency && dependency.file !== MANIFEST
        ? {
            id: 'stripe-not-locked',
            detail: `The Stripe client at ${at(client)} sets no apiVersion, and Refit reads only the root lockfile, which does not install ${dependency.file}, so it cannot tell which stripe-node release sends the default.`,
            action: `Refit cannot tell which API version the client at ${at(client)} sends; check it before merging a draft.`,
          }
        : {
            id: 'stripe-not-locked',
            detail: `The Stripe client at ${at(client)} sets no apiVersion, and no committed lockfile records which stripe-node release sends the default.`,
            action: `Without a lockfile Refit cannot tell which API version the client at ${at(client)} sends; check it before merging a draft.`,
          }
      : !value
        ? Number(RELEASE.exec(release)?.[1] ?? 0) >= FIRST_PINNING_MAJOR
          ? {
              id: 'api-version-account-default',
              detail: `The Stripe client at ${at(client)} sets no apiVersion, so it sends the API version stripe-node ${release} pins, and Refit's table of stripe-node releases does not record which one that is.`,
              action: `Refit cannot tell which version stripe-node ${release} pins for the client at ${at(client)} (its changelog names it); check it before merging a draft.`,
            }
          : {
              id: 'api-version-account-default',
              detail: `The Stripe client at ${at(client)} sets no apiVersion, and Refit does not know which version stripe-node ${release} sends by default, so requests may use your Stripe account's default version.`,
              action: `Refit cannot tell which version the client at ${at(client)} sends, which may be the Stripe account's default; check it before merging a draft.`,
            }
        : undefined;
    if (unknown && !allowUntested) return [unknown];
    if (unknown) {
      reviews.push(unknown);
      unread.push(client);
    } else defaults.push({ ...client, release: release!, value: value! });
  }
  const used = [...new Set([...pinned, ...defaults].map((client) => client.value))];
  const oldest = [...used].sort()[0];
  // Checked after the clients, so the fix can name the one version they all send.
  const stops = requests.length ? [unreadableRequest(repository.files, requests[0], used)] : [];
  if (used.length > 1)
    stops.push({
      id: 'api-version-several',
      detail: `This repository sends more than one Stripe API version (${used
        .map((version) =>
          [
            ...(pinned.some((pin) => pin.value === version)
              ? [`${version} at ${places(pinned.filter((pin) => pin.value === version))}`]
              : []),
            ...[
              ...new Set(
                defaults
                  .filter((client) => client.value === version)
                  .map((client) => client.release),
              ),
            ].map(
              (release) =>
                `stripe-node ${release}'s default ${version} at ${places(defaults.filter((client) => client.release === release))}`,
            ),
          ].join(', '),
        )
        .join(
          '; ',
        )})${allowUntested ? `. The configuration starts from the oldest, ${oldest}, and each draft moves every pin it can trace to ${latestStripeContract().version} and lists them` : ', and Refit moves one version at a time'}.`,
      action: allowUntested
        ? 'Check each pin the draft lists before merging it.'
        : 'Refit moves one API version at a time, so it cannot move these clients and requests together.',
    });
  if (!allowUntested && stops.length) return stops;
  reviews.push(...stops);
  const releases = [...new Set(defaults.map((client) => client.release))];
  const sources = [
    ...(pinned.length ? [`set at ${places(pinned)}`] : []),
    ...(releases.length
      ? [`the default of stripe-node ${listed(releases)}, which the lockfile records`]
      : []),
  ];
  const source = `${used.length > 1 ? 'the oldest version ' : ''}${sources.join(', and ')}${unfollowed.length ? `; Refit cannot follow every use of the client at ${places(unfollowed)}, so check that no request there sends another version` : ''}`;
  if (!unread.length && !requests.length) return { value: oldest, source, reviews };
  // Only with allowUntested. A client whose version Refit cannot read may still send its
  // stripe-node default (an unset environment variable), when one lockfile installs them all.
  const projects = [...new Set(unread.map((client) => owner(client.file)))];
  const lock = projects.length === 1 ? projects[0]?.lock : undefined;
  const release = lock?.status === 'locked' ? lock.version : undefined;
  const fallback = release ? stripeNodeDefaultVersion(release) : undefined;
  const [value, why] = used.length
    ? [oldest, `the oldest version Refit can read (${source})`]
    : fallback
      ? [
          fallback,
          `the version stripe-node ${release} sends by default, which the lockfile records`,
        ]
      : [stripeContractVersions()[0].version, 'the oldest version Refit has a contract for'];
  reviews.push({
    id: 'api-version-assumed',
    detail: `Refit could not read ${used.length ? 'every' : 'which'} Stripe API version this code sends, so the configuration assumes ${value}, ${why}. Refit compares the ${value} contract with ${latestStripeContract().version}; if the code sends another version, what needs migrating can differ.`,
    action: 'Check the version the code and Stripe account use before merging a draft.',
  });
  return { value, source: used.length ? source : `assumed: ${why}`, reviews };
}

// Proposes the Stripe configuration a repository without a .refit.json gets, from its committed
// files only: the API version its code sends, the contracts for that version and Refit's newest,
// and the checks the Stripe benchmark runs. Every reason it cannot is returned, never guessed.
// With allowUntested, a missing lockfile or missing checks no longer stop it; they stay as reasons.
export async function proposeStripeConfiguration(
  directory: string,
  options: { allowUntested?: boolean } = {},
) {
  const stops: EnrollmentStop[] = [];
  const blocking = () =>
    stops.filter((stop) => !options.allowUntested || !REVIEWED_STOPS.has(stop.id));
  const repository = await readRepository(directory, STRIPE.packageName);
  const manifest = existsSync(join(directory, MANIFEST))
    ? parseObject(await readFile(join(directory, MANIFEST), 'utf8'), MANIFEST)
    : undefined;
  const declared = {
    ...(manifest?.dependencies as Record<string, unknown> | undefined),
    ...(manifest?.devDependencies as Record<string, unknown> | undefined),
  };
  const { lockfile } = await scaffoldChecks(directory);
  const rooted = Boolean(declared[STRIPE.packageName]);
  if (!rooted) {
    const nested = [...new Set(repository.dependencies.map((dependency) => dependency.file))];
    if (!nested.length)
      return {
        proposal: null,
        stops: [
          manifest
            ? {
                id: 'no-stripe-dependency',
                detail: 'The root package.json does not declare the stripe package.',
                action:
                  'Refit found no stripe dependency in the root package.json, so it has no Stripe code to check here.',
              }
            : {
                id: 'no-package-json',
                detail:
                  'This repository has no package.json at its root, so Refit cannot tell how to install and check it.',
                action:
                  'Refit installs and checks only from a package.json at the root, so it cannot check this repository.',
              },
        ],
      };
  }
  // A package the root lockfile installs is a workspace Refit prepares and checks from the root;
  // any other package.json that declares stripe is a project of its own. Beside a root that declares
  // stripe it is named with the checks, as configured repositories have always been run.
  const outside = repository.dependencies
    .filter((dependency) => !manifest || (lockfile && dependency.lock.status !== 'locked'))
    .filter((dependency) => dependency.file !== MANIFEST)
    .map((dependency) => dependency.file);
  if (outside.length && !rooted) {
    const projects = outside.length === 1 ? 'that project' : 'those projects';
    return {
      proposal: null,
      stops: [
        {
          id: 'nested-project',
          detail: `stripe is declared in ${listed(outside)}, ${manifest ? `which the root lockfile does not install, so Refit cannot prepare ${projects}` : 'and this repository has no package.json at its root'}.`,
          action: `Refit installs and checks only from the root package.json and its lockfile, so it cannot prepare or check ${projects}.`,
        },
      ],
    };
  }
  if (!lockfile)
    stops.push({
      id: 'no-lockfile',
      detail:
        'Refit installs dependencies only from a committed lockfile, and this repository has none at its root.',
      action:
        'Without a committed lockfile Refit cannot install dependencies, so it cannot run the checks on a draft.',
    });
  const manager = existsSync(join(directory, PNPM_LOCKFILE))
    ? 'pnpm'
    : existsSync(join(directory, YARN_LOCKFILE))
      ? 'yarn'
      : 'npm';
  const check = await selectCheck(repository);
  if (!check.kind)
    stops.push({
      id: 'no-checks',
      detail:
        'This repository has no test script and no TypeScript type check, so Refit has nothing that shows a change still works.',
      action:
        'Refit has no test script or type check to run, so a draft is untested; check its changes before merging.',
    });
  let analysis: ReturnType<typeof analyzeRepository>;
  try {
    analysis = analyzeRepository(repository, [], STRIPE);
  } catch (error) {
    if (!(error instanceof SourceParseError)) throw error;
    stops.push({
      id: 'source-does-not-parse',
      detail: `${error.file} imports stripe but does not parse (${error.diagnostic}), so Refit cannot read its Stripe calls or the API version it sends.`,
      action: `Refit cannot read the Stripe calls in ${error.file} until it parses, so it stops here.`,
    });
    return { proposal: null, stops };
  }
  // Generation never takes a version from the environment (owner decision, P3): a default behind
  // a variable stays unreadable here, though a run moves it like a literal pin.
  const version = applicationVersion(
    analysis.apiVersionDeclarations.map(({ environment, ...declaration }) =>
      environment ? { ...declaration, status: 'unknown' as const, value: null } : declaration,
    ),
    repository,
    options.allowUntested,
  );
  if (Array.isArray(version)) stops.push(...version);
  else stops.push(...version.reviews);
  if (!Array.isArray(version) && !stripeContractVersion(version.value))
    stops.push({
      id: 'api-version-no-contract',
      detail: `Your code uses Stripe API version ${version.value}, and Refit has no contract for it.`,
      action: `Without a contract for ${version.value} Refit cannot compare it with ${latestStripeContract().version}, so it stops here.`,
    });
  // Generation for stripe only in workspace packages is withheld under the decision bar (P5, #270):
  // no measured repository generates this way, nothing shows the root check covers the package, and
  // the stripe-node upgrade edits only the root package.json.
  if (!rooted && !blocking().length)
    stops.push({
      id: 'workspace-package',
      detail: `stripe is declared in ${listed([...new Set(repository.dependencies.map((dependency) => dependency.file))])}, not in the root package.json, and Refit does not yet generate a configuration that checks a workspace package from the root.`,
      action: "Refit cannot run that package's tests from the root, so it stops here.",
    });
  if (blocking().length || Array.isArray(version)) return { proposal: null, stops };
  const target = latestStripeContract().version;
  const typeChecked =
    check.typeCheck === 'project'
      ? 'tsc over tsconfig.json, failing only on new type errors'
      : check.typeCheck === 'scoped'
        ? 'tsc over the Stripe code, failing only on new type errors'
        : check.typeCheck === 'checkjs'
          ? 'tsc with checkJs over the JavaScript Stripe code, counted only where TypeScript types the changed Stripe calls'
          : undefined;
  // Owner decision 1: without any check the command is a no-op the draft names (untested).
  const checked = check.kind
    ? [
        check.kind === 'tests' ? `the test script in ${MANIFEST}, run with ${manager}` : undefined,
        typeChecked,
      ]
        .filter(Boolean)
        .join(', then ')
    : `${NO_OP_CHECK}, which tests nothing`;
  const proposal: StripeProposal = {
    configuration: {
      formatVersion: 2,
      integrations: [
        {
          id: STRIPE_INTEGRATION,
          before: `./${stripeContractFile(version.value)}`,
          after: `./${stripeContractFile(target)}`,
          apiVersion: version.value,
          image: NODE_22_IMAGE,
          prepareDependencies: true,
          command: check.command ?? NO_OP_CHECK.split(' '),
          ...(check.compareTypeErrors ? { compareTypeErrors: true } : {}),
        },
      ],
    },
    apiVersion: { value: version.value, source: version.source },
    target,
    checks: {
      kind: check.kind ?? 'none',
      source: `${checked}${outside.length ? `; Refit does not install ${listed(outside)}, which the root lockfile leaves out` : ''}`,
      reason: check.reason,
    },
    reviews: stops,
  };
  return { proposal, stops };
}

// How Refit checked the code against a generated configuration's version, which nobody pinned by
// hand, so the operator-pin wording of committed configurations does not apply.
export function generatedVersionCheck(source: ApiVersionSource) {
  if (source.status === 'verified')
    return 'Every Stripe client and request override Refit traced sends it.';
  if (source.status === 'unknown')
    return 'Refit could not read it at every client or request; check by hand the places the generated configuration names.';
  return source.reason;
}

// One sentence a person reads before approving or running a generated configuration.
export function proposalSummary(proposal: StripeProposal) {
  const reviews = proposal.reviews.map((stop) => `${stop.detail} ${stop.action}`).join(' ');
  return `No ${REPOSITORY_CONFIGURATION} is committed, so Refit generated one: Stripe API version ${proposal.apiVersion.value} (${proposal.apiVersion.source}), moving to ${proposal.target}, checked by ${proposal.checks.source}. ${proposal.checks.reason}${reviews ? ` Each draft Refit opens with it is titled [Needs review]: ${reviews}` : ''}`;
}

export function proposalContent(proposal: StripeProposal) {
  return `${JSON.stringify(proposal.configuration, null, 2)}\n`;
}

export class EnrollmentStopError extends PipelineInputError {
  override name = 'EnrollmentStopError';
  constructor(readonly stops: EnrollmentStop[]) {
    super(stops.map((stop) => `${stop.detail} ${stop.action}`).join(' '));
  }
}
