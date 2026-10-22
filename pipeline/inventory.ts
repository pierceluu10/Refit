import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-compiler';
import { detectProviders } from './agent-catalog.ts';
import { analyzeRepository } from './analyzer.ts';
import {
  configuredIntegrations,
  scanDeadlines,
  TEST_PATH,
  type DeadlineScan,
} from './deadline-exposure.ts';
import type { DeadlineRegistry } from './deadline-registry.ts';
import { authenticateGitHubRead, type GitHubAppConfiguration } from './github-app.ts';
import { withGitHubCheckout } from './github-checkout.ts';
import { GitHubRequestError, requestGitHub } from './github.ts';
import { MODEL_CALLS } from './model-retirements.ts';
import { readProviderAdapter, STRIPE } from './providers.ts';
import { readRepository } from './repository.ts';
import { confirmRepositoryAccess } from './service-worker.ts';
import { digest, isObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

export const INVENTORY_FORMAT_VERSION = 1;
const KILOBYTE = 1024;
const MILLISECONDS_PER_SECOND = 1000;
const REVISION = /^[a-f0-9]{40}$/;

// GitHub's `size` counts the whole repository in kilobytes, history included, so it is checked
// before anything is fetched; the checkout itself is counted again on disk.
export const INVENTORY_LIMITS = {
  repositoryKilobytes: 1_000_000,
  checkoutFiles: 50_000,
  checkoutBytes: 512 * 1024 * 1024,
  seconds: 300,
};
export type InventoryLimits = typeof INVENTORY_LIMITS;

// Why an inventory ended without findings. Each one is a deliberate limit, not a failure:
// - unavailable: GitHub reports the repository archived, disabled or not readable by the App;
// - empty: the default branch has no commit;
// - repository-too-large: GitHub's size for the repository is over the cap;
// - checkout-too-large: the checked-out files are over the file-count or byte cap;
// - unreadable: a scanner refused the files, such as Refit's own scan limits or a malformed
//   manifest, with its message;
// - timeout: the whole inventory took longer than the time cap.
export type InventoryStop =
  | 'unavailable'
  | 'empty'
  | 'repository-too-large'
  | 'checkout-too-large'
  | 'unreadable'
  | 'timeout';

// AI providers whose SDK calls carry a `model`, traced with the same adapters model fixes use.
const MODEL_ADAPTERS = [
  { provider: 'openai', adapter: new URL('../examples/openai.provider.json', import.meta.url) },
  {
    provider: 'anthropic',
    adapter: new URL('../examples/anthropic.provider.json', import.meta.url),
  },
] as const;

export interface InventoryModelCall {
  provider: 'openai' | 'anthropic';
  file: string;
  line: number;
  call: string;
  // The model when the call passes it as a string literal; null when it is computed.
  model: string | null;
  test: boolean;
}

export interface Inventory {
  formatVersion: typeof INVENTORY_FORMAT_VERSION;
  providers: {
    id: string;
    name: string;
    // Whether Refit ships a reviewed agent for this provider.
    agent: boolean;
    packages: { file: string; name: string; version: string; locked: string | null }[];
    hostnames: { file: string; line: number; hostname: string }[];
  }[];
  integrations: Awaited<ReturnType<typeof configuredIntegrations>>;
  // Stripe API versions the code pins on its clients or requests: literal, or `unknown` when
  // computed. Requests that inherit their client's version are left out.
  apiVersions: {
    provider: 'stripe';
    file: string;
    line: number;
    kind: 'constructor' | 'request';
    value: string | null;
    status: 'literal' | 'unknown';
  }[];
  deadlines: DeadlineScan;
  models: InventoryModelCall[];
}

export type InventoryResult =
  | {
      outcome: 'complete';
      base: string;
      revision: string;
      inventory: Inventory;
    }
  | {
      outcome: 'stopped';
      base: string | null;
      revision: string | null;
      stop: InventoryStop;
      message: string;
    }
  | { outcome: 'unchanged'; base: string; revision: string };

export class InventoryStopError extends PipelineInputError {
  override name = 'InventoryStopError';
  constructor(
    readonly stop: InventoryStop,
    message: string,
  ) {
    super(message);
  }
}

// The literal `model` of a call's first argument, as in `create({ model: 'gpt-4o', ... })`.
function literalModel(source: ts.SourceFile, line: number, column: number) {
  const position = source.getPositionOfLineAndCharacter(line - 1, column - 1);
  let model: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.getStart(source) === position) {
      const [argument] = node.arguments;
      if (argument && ts.isObjectLiteralExpression(argument))
        for (const property of argument.properties)
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'model' &&
            ts.isStringLiteralLike(property.initializer)
          )
            model = property.initializer.text;
      return;
    }
    if (node.pos <= position && position < node.end) ts.forEachChild(node, visit);
  };
  visit(source);
  return model;
}

async function modelCalls(directory: string, detected: Set<string>) {
  const calls: InventoryModelCall[] = [];
  for (const { provider, adapter: path } of MODEL_ADAPTERS) {
    if (!detected.has(provider)) continue;
    const adapter = await readProviderAdapter(fileURLToPath(path));
    const repository = await readRepository(directory, adapter.packageName);
    const sources = new Map<string, ts.SourceFile>();
    for (const call of analyzeRepository(repository, [], adapter).sdkCalls) {
      const name = `${call.resource}.${call.method}`;
      if (!MODEL_CALLS[provider].has(name)) continue;
      let source = sources.get(call.file);
      if (!source) {
        const content = repository.files.find((file) => file.path === call.file)!.content;
        source = ts.createSourceFile(call.file, content, ts.ScriptTarget.Latest, true);
        sources.set(call.file, source);
      }
      calls.push({
        provider,
        file: call.file,
        line: call.line,
        call: name,
        model: literalModel(source, call.line, call.column),
        test: TEST_PATH.test(call.file),
      });
    }
  }
  return calls;
}

// Builds the inventory of a local directory from Refit's existing static scanners. Nothing in the
// directory is installed or executed, and no provider or model is contacted.
export async function scanInventory(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
  signal?: AbortSignal,
): Promise<Inventory> {
  const detections = await detectProviders(directory);
  signal?.throwIfAborted();
  const detected = new Set(detections.map((detection) => detection.agent.id));
  const integrations = await configuredIntegrations(directory);
  const deadlines = await scanDeadlines(directory, registry, now);
  signal?.throwIfAborted();
  const apiVersions = detected.has('stripe')
    ? analyzeRepository(await readRepository(directory, 'stripe'), [], STRIPE)
        .apiVersionDeclarations
    : [];
  signal?.throwIfAborted();
  const models = await modelCalls(directory, detected);
  signal?.throwIfAborted();
  return {
    formatVersion: INVENTORY_FORMAT_VERSION,
    providers: detections.map(({ agent, packages, hostnames }) => ({
      id: agent.id,
      name: agent.name,
      agent: agent.adapter !== null,
      packages,
      hostnames,
    })),
    integrations,
    apiVersions: apiVersions.flatMap(({ file, line, kind, value, status }) =>
      status === 'inherited'
        ? []
        : [{ provider: 'stripe' as const, file, line, kind, value, status }],
    ),
    deadlines,
    models,
  };
}

// Counts checked-out files and bytes outside .git, stopping as soon as either cap is passed.
async function measureCheckout(directory: string, limits: InventoryLimits) {
  let files = 0;
  let bytes = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (path === directory && entry.name === '.git') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else {
        files += 1;
        bytes += (await lstat(child)).size;
      }
      if (files > limits.checkoutFiles || bytes > limits.checkoutBytes)
        throw new InventoryStopError(
          'checkout-too-large',
          `Checkout is over the inventory limit of ${limits.checkoutFiles} files and ${limits.checkoutBytes / KILOBYTE / KILOBYTE} MiB.`,
        );
    }
  };
  await visit(directory);
}

async function defaultRevision(app: GitHubAppConfiguration, repository: string, base: string) {
  const { token } = await authenticateGitHubRead(app, repository);
  let reference;
  try {
    reference = await requestGitHub(
      token,
      'GET',
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(base)}`,
    );
  } catch (error) {
    // GitHub answers 409 for a repository without commits and 404 for a branch without one.
    if (error instanceof GitHubRequestError && (error.status === 409 || error.status === 404))
      throw new InventoryStopError('empty', `The default branch ${base} has no commit.`);
    throw error;
  }
  if (
    !isObject(reference) ||
    !isObject(reference.object) ||
    reference.object.type !== 'commit' ||
    typeof reference.object.sha !== 'string' ||
    !REVISION.test(reference.object.sha)
  )
    throw new PipelineInputError('GitHub default branch does not reference a commit.');
  return reference.object.sha;
}

// What an inventory found, without evidence lines, so a status listing stays small.
export function inventorySummary(inventory: Inventory) {
  return {
    providers: inventory.providers.map((provider) => provider.id),
    deadlines: inventory.deadlines.exposures.map((exposure) => ({
      id: exposure.deadline.id,
      date: exposure.deadline.date,
      live: exposure.evidence.length + exposure.more,
    })),
    mentions: inventory.deadlines.mentions.map((mention) => mention.deadline.id),
    apiVersions: [...new Set(inventory.apiVersions.flatMap((pin) => pin.value ?? []))],
    models: [...new Set(inventory.models.flatMap((call) => (call.test ? [] : (call.model ?? []))))],
    modelCalls: inventory.models.length,
  };
}

export function registryDigest(registry: DeadlineRegistry) {
  return digest(JSON.stringify(registry));
}

// Takes a read-only inventory of an installed repository's default branch from a fresh
// App-managed checkout, which is deleted afterwards. A revision already scanned against the same
// registry is not checked out again. Limits end the inventory with a named stop.
export async function refreshInventory(options: {
  app: GitHubAppConfiguration;
  // An empty directory for the checkout, removed when the inventory ends.
  directory: string;
  installationId: number;
  repository: string;
  registry: DeadlineRegistry;
  previous: { revision: string | null; registry: string | null } | null;
  now?: Date;
  signal: AbortSignal;
  limits?: InventoryLimits;
  onProgress?: (message: string) => void;
}): Promise<InventoryResult> {
  const limits = options.limits ?? INVENTORY_LIMITS;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(limits.seconds * MILLISECONDS_PER_SECOND),
  ]);
  let base: string | null = null;
  let revision: string | null = null;
  try {
    let access;
    try {
      access = await confirmRepositoryAccess(options.app, options.repository);
    } catch (error) {
      if (!(error instanceof PipelineInputError)) throw error;
      throw new InventoryStopError('unavailable', error.message);
    }
    if (access.installationId !== options.installationId)
      throw new InventoryStopError(
        'unavailable',
        'Repository now belongs to another App installation.',
      );
    if (
      typeof access.defaultBranch !== 'string' ||
      !access.defaultBranch ||
      !Number.isSafeInteger(access.size)
    )
      throw new PipelineInputError('GitHub did not report the default branch and size.');
    base = access.defaultBranch;
    if (Number(access.size) > limits.repositoryKilobytes)
      throw new InventoryStopError(
        'repository-too-large',
        `GitHub reports ${access.size} KB, over the inventory limit of ${limits.repositoryKilobytes} KB.`,
      );
    revision = await defaultRevision(options.app, options.repository, base);
    signal.throwIfAborted();
    const registry = registryDigest(options.registry);
    if (options.previous?.revision === revision && options.previous.registry === registry) {
      options.onProgress?.(`Inventory unchanged at ${revision.slice(0, 12)}; not scanned again.`);
      return { outcome: 'unchanged', base, revision };
    }
    const target = { repository: options.repository, base, app: options.app };
    return await withGitHubCheckout(
      {
        directory: join(options.directory, 'github'),
        target,
        signal,
        onProgress: options.onProgress,
      },
      async (checkout) => {
        revision = checkout.revision;
        await measureCheckout(checkout.directory, limits);
        signal.throwIfAborted();
        let inventory;
        try {
          inventory = await scanInventory(
            checkout.directory,
            options.registry,
            options.now ?? new Date(),
            signal,
          );
        } catch (error) {
          if (error instanceof PipelineInputError && !(error instanceof InventoryStopError))
            throw new InventoryStopError('unreadable', error.message);
          throw error;
        }
        return { outcome: 'complete' as const, base: checkout.base, revision, inventory };
      },
    );
  } catch (error) {
    if (error instanceof InventoryStopError)
      return { outcome: 'stopped', base, revision, stop: error.stop, message: error.message };
    if (signal.aborted && !options.signal.aborted)
      return {
        outcome: 'stopped',
        base,
        revision,
        stop: 'timeout',
        message: `Inventory took longer than ${limits.seconds} seconds.`,
      };
    throw error;
  } finally {
    await rm(options.directory, { recursive: true, force: true });
  }
}
