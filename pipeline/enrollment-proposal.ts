import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript-compiler';
import { scaffoldChecks } from './agent-catalog.ts';
import { analyzeRepository } from './analyzer.ts';
import { selectCheck } from './check-selection.ts';
import { validateApiVersion, type ApiVersionDeclaration } from './api-version.ts';
import {
  latestStripeContract,
  stripeContractFile,
  stripeContractVersion,
} from './enrollment-contracts.ts';
import { PNPM_LOCKFILE } from './pnpm-lock.ts';
import { STRIPE } from './providers.ts';
import { readRepository } from './repository.ts';
import { parseObject } from './specifications.ts';
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
const OWN_CONFIGURATION = `or commit a ${REPOSITORY_CONFIGURATION} that sets it (docs/REPOSITORY-SETUP.md)`;

// Why Refit cannot propose a configuration: one plain sentence and the exact change that fixes it.
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
  checks: { kind: 'tests' | 'typecheck'; source: string; reason: string };
}

const at = (location: Location) => `${location.file}:${location.line}`;

// Names at most a few places, so a proposal over many clients stays one readable line.
function places(locations: Location[]) {
  const named = locations.slice(0, MAX_PLACES).map(at).join(', ');
  return locations.length > MAX_PLACES
    ? `${named} and ${locations.length - MAX_PLACES} more`
    : named;
}

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

// The apiVersion written where a client is created, for a constructor the tracer could not follow
// to every use (an exported client, one handed to a plugin, one created lazily). Only a string
// literal in the options object, or no option at all, is read; anything else stays unreadable.
function writtenVersion(
  files: Repository['files'],
  declaration: ApiVersionDeclaration,
): { value: string } | 'absent' | null {
  const file = files.find((entry) => entry.path === declaration.file);
  if (!file) return null;
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const position = source.getPositionOfLineAndCharacter(
    declaration.line - 1,
    declaration.column - 1,
  );
  let creation: ts.NewExpression | ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (creation || node.getEnd() < position || node.getStart(source) > position) return;
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      node.getStart(source) === position
    )
      creation = node;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  if (!creation || creation.arguments?.some(ts.isSpreadElement)) return null;
  const argument = creation.arguments?.[STRIPE.apiVersion!.constructorArgument];
  if (!argument) return 'absent';
  const options = unwrap(argument);
  if (
    !ts.isObjectLiteralExpression(options) ||
    options.properties.some((property) => !ts.isPropertyAssignment(property))
  )
    return null;
  const option = options.properties
    .filter(ts.isPropertyAssignment)
    .find(
      (property) =>
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === STRIPE.apiVersion!.property,
    );
  if (!option) return 'absent';
  const value = unwrap(option.initializer);
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) return null;
  try {
    return { value: validateApiVersion(value.text)! };
  } catch (error) {
    if (!(error instanceof PipelineInputError)) throw error;
    return null;
  }
}

function applicationVersion(
  declarations: ApiVersionDeclaration[],
  files: Repository['files'],
  locked: string | null,
): { value: string; source: string } | EnrollmentStop {
  if (!declarations.some((declaration) => declaration.kind === 'constructor'))
    return {
      id: 'no-stripe-client',
      detail: 'Refit found no new Stripe(...) client in this repository that it can follow.',
      action: `Create the client with new Stripe(secretKey, { apiVersion: '<your API version>' }) in your server code, ${OWN_CONFIGURATION}.`,
    };
  const pinned: (Location & { value: string })[] = [];
  const absent: Location[] = [];
  const unfollowed: Location[] = [];
  for (const declaration of declarations) {
    if (declaration.value !== null) pinned.push({ ...declaration, value: declaration.value });
    else if (declaration.absent) absent.push(declaration);
    else if (declaration.status === 'unknown') {
      const written =
        declaration.kind === 'constructor' ? writtenVersion(files, declaration) : null;
      if (!written)
        return {
          id: 'api-version-unreadable',
          detail: `Refit cannot tell which Stripe API version the ${declaration.kind === 'constructor' ? 'client' : 'request'} at ${at(declaration)} uses: its apiVersion is not a string literal Refit can read.`,
          action:
            declaration.kind === 'constructor'
              ? `Write the apiVersion at ${at(declaration)} as a string literal, for example new Stripe(secretKey, { apiVersion: '<your API version>' }), ${OWN_CONFIGURATION}.`
              : `Write the request's apiVersion at ${at(declaration)} as a string literal, or remove it so the request uses the client's version, ${OWN_CONFIGURATION}.`,
        };
      unfollowed.push(declaration);
      if (written === 'absent') absent.push(declaration);
      else pinned.push({ ...declaration, value: written.value });
    }
  }
  const fallback = absent.length && locked ? stripeNodeDefaultVersion(locked) : undefined;
  if (absent.length && !fallback)
    return locked
      ? {
          id: 'api-version-account-default',
          detail: `The Stripe client at ${at(absent[0])} sets no apiVersion, and Refit does not know which version stripe-node ${locked} sends by default, so requests may use your Stripe account's default version.`,
          action: `Set apiVersion at ${at(absent[0])} to the version your account uses, ${OWN_CONFIGURATION}.`,
        }
      : {
          id: 'stripe-not-locked',
          detail: `The Stripe client at ${at(absent[0])} sets no apiVersion, and no committed lockfile records which stripe-node release sends the default.`,
          action: `Set apiVersion at ${at(absent[0])}, or commit your lockfile.`,
        };
  const used = [...new Set([...pinned.map((pin) => pin.value), ...(fallback ? [fallback] : [])])];
  if (used.length > 1)
    return {
      id: 'api-version-several',
      detail: `This repository sends more than one Stripe API version (${used
        .map((version) =>
          version === fallback && !pinned.some((pin) => pin.value === version)
            ? `stripe-node's default ${version} at ${places(absent)}`
            : `${version} at ${places(pinned.filter((pin) => pin.value === version))}`,
        )
        .join('; ')}), and Refit moves one version at a time.`,
      action:
        'Use the same apiVersion for every Stripe client and request, then Refit moves them together.',
    };
  const sources = [
    ...(pinned.length ? [`set at ${places(pinned)}`] : []),
    ...(fallback ? [`the default of stripe-node ${locked}, which the lockfile records`] : []),
  ];
  return {
    value: used[0],
    source: `${sources.join(' and ')}${unfollowed.length ? `; Refit cannot follow every use of the client at ${places(unfollowed)}, so check that no request there sends another version` : ''}`,
  };
}

// Proposes the Stripe configuration a repository without a .refit.json gets, from its committed
// files only: the API version its code sends, the contracts for that version and Refit's newest,
// and the checks the Stripe benchmark runs. Every reason it cannot is returned, never guessed.
export async function proposeStripeConfiguration(directory: string) {
  const stops: EnrollmentStop[] = [];
  const repository = await readRepository(directory, STRIPE.packageName);
  const manifest = existsSync(join(directory, MANIFEST))
    ? parseObject(await readFile(join(directory, MANIFEST), 'utf8'), MANIFEST)
    : undefined;
  const declared = {
    ...(manifest?.dependencies as Record<string, unknown> | undefined),
    ...(manifest?.devDependencies as Record<string, unknown> | undefined),
  };
  if (!declared[STRIPE.packageName]) {
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
                  'Add stripe to the root package.json dependencies if this repository calls Stripe from Node.',
              }
            : {
                id: 'no-package-json',
                detail:
                  'This repository has no package.json at its root, so Refit cannot tell how to install and check it.',
                action: `Commit the package.json at the root, ${OWN_CONFIGURATION} with the checks to run.`,
              },
        ],
      };
    return {
      proposal: null,
      stops: [
        {
          id: 'workspace-package',
          detail: `stripe is declared in ${nested.join(', ')}, not in the root package.json, and Refit runs checks only from the root.`,
          action: `Commit a ${REPOSITORY_CONFIGURATION} whose checks run that package's tests from the root (docs/REPOSITORY-SETUP.md).`,
        },
      ],
    };
  }
  const { lockfile } = await scaffoldChecks(directory);
  if (!lockfile)
    stops.push({
      id: 'no-lockfile',
      detail:
        'Refit installs dependencies only from a committed lockfile, and this repository has none at its root.',
      action:
        'Run npm install, pnpm install or yarn install once and commit the lockfile it writes.',
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
        'Add a "test" script to package.json, or a tsconfig.json with typescript in devDependencies.',
    });
  const root = repository.dependencies.find((dependency) => dependency.file === MANIFEST);
  const version = applicationVersion(
    analyzeRepository(repository, [], STRIPE).apiVersionDeclarations,
    repository.files,
    root?.lock.status === 'locked' ? root.lock.version : null,
  );
  if ('id' in version) stops.push(version);
  else if (!stripeContractVersion(version.value))
    stops.push({
      id: 'api-version-no-contract',
      detail: `Your code uses Stripe API version ${version.value}, and Refit has no contract for it.`,
      action: `Move the client to ${latestStripeContract().version} yourself, ${OWN_CONFIGURATION} with contracts for ${version.value}.`,
    });
  if (stops.length || 'id' in version || !check.kind) return { proposal: null, stops };
  const target = latestStripeContract().version;
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
          command: check.command,
          ...(check.compareTypeErrors ? { compareTypeErrors: true } : {}),
        },
      ],
    },
    apiVersion: version,
    target,
    checks:
      check.kind === 'tests'
        ? {
            kind: 'tests',
            source: `the test script in ${MANIFEST}, run with ${manager}`,
            reason: check.reason,
          }
        : {
            kind: 'typecheck',
            source: 'tsc over tsconfig.json, failing only on new type errors',
            reason: check.reason,
          },
  };
  return { proposal, stops };
}

// One sentence a person reads before approving or running a generated configuration.
export function proposalSummary(proposal: StripeProposal) {
  return `No ${REPOSITORY_CONFIGURATION} is committed, so Refit generated one: Stripe API version ${proposal.apiVersion.value} (${proposal.apiVersion.source}), moving to ${proposal.target}, checked by ${proposal.checks.source}. ${proposal.checks.reason}`;
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
