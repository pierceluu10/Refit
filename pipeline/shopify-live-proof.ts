import { Kind, parse, type DocumentNode, type OperationDefinitionNode } from 'graphql';
import { isObject } from './specifications.ts';

// Live proof for Shopify patches (docs/SHOPIFY-PROOF.md): Refit sends each GraphQL operation the
// patched code holds to Refit's own Partner development store, at the original and at the target
// API version, and grants grade A only when every one succeeds on both. The store and its Admin API
// token come only from SHOPIFY_TEST_STORE and SHOPIFY_TEST_TOKEN, never from the repository, and the
// store must report itself as a Partner development store before anything else is sent.
//
// Queries are read-only and always allowed. A mutation runs only on objects the same run created:
// either every root field creates (`…Create`), or every ID it receives is one a setup mutation of
// this run returned. Setup mutations must create; cleanup mutations must delete, and only those IDs.
// The token is sent in a header and never logged; recorded errors are truncated and redacted.

export const SHOPIFY_STORE_VARIABLE = 'SHOPIFY_TEST_STORE';
export const SHOPIFY_TOKEN_VARIABLE = 'SHOPIFY_TEST_TOKEN';
export const SHOPIFY_CLIENT_ID_VARIABLE = 'SHOPIFY_TEST_CLIENT_ID';
export const SHOPIFY_CLIENT_SECRET_VARIABLE = 'SHOPIFY_TEST_CLIENT_SECRET';
const STORE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const TOKEN = /^shp[a-z]{2}_[A-Za-z0-9]{20,64}$/;
// A granted token or a client credential: printable, no whitespace or quotes.
const CREDENTIAL = /^[A-Za-z0-9_.-]{16,256}$/;
const GLOBAL_ID = /gid:\/\/shopify\/[A-Za-z]+\/[^\s"']+/;
const MAX_ERROR = 200;
const REQUEST_TIMEOUT_MS = 30_000;
const THROTTLE_RETRIES = 3;
const THROTTLE_BACKOFF_MS = 2_000;
const DEV_STORE_QUERY = '{ shop { plan { partnerDevelopment } } }';

export interface ShopifyTestStore {
  store: string;
  token: string;
}

export type ShopifyTestStoreSettings =
  ShopifyTestStore | { store: string; clientId: string; clientSecret: string };

// Reads the test store from the environment: a ready Admin API token (SHOPIFY_TEST_TOKEN), else a
// Dev Dashboard app's client credentials, exchanged at run time (shopifyAccessToken). The refusal
// names the check that failed, never any part of a value.
export function shopifyTestStore(
  environment: Record<string, string | undefined>,
): ShopifyTestStoreSettings | { refused: string } | undefined {
  const store = environment[SHOPIFY_STORE_VARIABLE]?.trim();
  const token = environment[SHOPIFY_TOKEN_VARIABLE]?.trim();
  const clientId = environment[SHOPIFY_CLIENT_ID_VARIABLE]?.trim();
  const clientSecret = environment[SHOPIFY_CLIENT_SECRET_VARIABLE]?.trim();
  if (!store && !token && !clientId && !clientSecret) return undefined;
  if (!store || !(token || (clientId && clientSecret)))
    return {
      refused: `Live Shopify proof needs ${SHOPIFY_STORE_VARIABLE} and either ${SHOPIFY_TOKEN_VARIABLE} or both ${SHOPIFY_CLIENT_ID_VARIABLE} and ${SHOPIFY_CLIENT_SECRET_VARIABLE}.`,
    };
  if (!STORE.test(store))
    return {
      refused: `${SHOPIFY_STORE_VARIABLE} must be a bare <name>.myshopify.com domain (${store.length} characters given).`,
    };
  if (token)
    return TOKEN.test(token)
      ? { store, token }
      : {
          refused: `${SHOPIFY_TOKEN_VARIABLE} does not have the shape of a Shopify Admin API access token (${token.length} characters given).`,
        };
  const malformed = [
    [SHOPIFY_CLIENT_ID_VARIABLE, clientId!],
    [SHOPIFY_CLIENT_SECRET_VARIABLE, clientSecret!],
  ].find(([, value]) => !CREDENTIAL.test(value));
  if (malformed)
    return {
      refused: `${malformed[0]} holds characters other than letters, digits, dots, dashes and underscores, or has the wrong length (${malformed[1].length} characters given).`,
    };
  return { store, clientId: clientId!, clientSecret: clientSecret! };
}

// The client credentials grant (shopify.dev/docs/apps/build/authentication-authorization/
// access-tokens/client-credentials-grant, read 2026-10-29): a Dev Dashboard app installed on a store
// in its own organization gets a 24-hour Admin API token with the scopes the installation granted
// (no scope parameter is sent). Errors carry only Shopify's error code, never the secret or token.
export async function shopifyAccessToken(
  settings: ShopifyTestStoreSettings,
  send: typeof fetch = fetch,
): Promise<ShopifyTestStore | { refused: string }> {
  if ('token' in settings) return settings;
  try {
    const response = await send(`https://${settings.store}/admin/oauth/access_token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
      }).toString(),
    });
    const body: unknown = await response.json().catch(() => ({}));
    const token = isObject(body) ? body.access_token : undefined;
    if (response.ok && typeof token === 'string' && CREDENTIAL.test(token))
      return { store: settings.store, token };
    const code = isObject(body) && typeof body.error === 'string' ? body.error : '';
    return {
      refused: `The client credentials grant returned HTTP ${response.status}${/^[a-z_]{1,40}$/.test(code) ? ` (${code})` : ''}; it works only for a Dev Dashboard app installed on a store in the app's own organization.`,
    };
  } catch (error) {
    return {
      refused: `The client credentials grant could not reach the store (${error instanceof Error ? error.name : 'error'}).`,
    };
  }
}

// A reference to a value an earlier step of the same case returned, such as
// `{ "$ref": "setup.0.productCreate.product.id" }` or `{ "$ref": "operation.productCreate.product.id" }`.
type Value = unknown;

export interface ShopifyLiveStep {
  document: string;
  variables: Record<string, Value>;
}

export interface ShopifyLiveCase {
  // The patched document (file:line) and operation this case runs.
  document: string;
  operationName: string | null;
  variables: Record<string, Value>;
  setup: ShopifyLiveStep[];
  cleanup: ShopifyLiveStep[];
}

export interface ShopifyLiveOperation {
  document: string;
  operationName: string | null;
  kind: 'query' | 'mutation' | 'subscription';
  status: 'passed' | 'failed' | 'not-run';
  reason?: string;
  versions?: Record<string, { status: number; error?: string }>;
}

export interface ShopifyLiveProof {
  status: 'passed' | 'failed' | 'not-run';
  reason: string;
  store?: string;
  operations: ShopifyLiveOperation[];
  // Objects the run created and whether cleanup deleted them.
  created: { id: string; deleted: boolean }[];
}

type Fetch = typeof fetch;

function operations(text: string) {
  const ast: DocumentNode = parse(text);
  return ast.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
}

const rootFields = (operation: OperationDefinitionNode) =>
  operation.selectionSet.selections.flatMap((selection) =>
    selection.kind === Kind.FIELD ? [selection.name.value] : ['…'],
  );

const requiredVariables = (operation: OperationDefinitionNode) =>
  (operation.variableDefinitions ?? [])
    .filter((entry) => entry.type.kind === Kind.NON_NULL_TYPE && !entry.defaultValue)
    .map((entry) => entry.variable.name.value);

// Operations live proof cannot send without written inputs: mutations and required variables.
export const needsCase = (text: string) =>
  operations(text).some(
    (operation) => operation.operation === 'mutation' || requiredVariables(operation).length > 0,
  );

// Only the object each root field's payload returns directly (`productCreate.product.id`): IDs of
// existing objects selected deeper in the payload (a location, the shop) never count as created.
function createdIds(data: unknown, operation: OperationDefinitionNode) {
  return rootFields(operation).flatMap((field) => {
    const payload = isObject(data) ? data[field] : undefined;
    return isObject(payload)
      ? Object.values(payload).flatMap((value) =>
          isObject(value) && typeof value.id === 'string' && GLOBAL_ID.test(value.id)
            ? [value.id]
            : [],
        )
      : [];
  });
}

const onlyFields = (operation: OperationDefinitionNode, suffix: string) =>
  rootFields(operation).every((name) => name.endsWith(suffix));

function lookup(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (current, key) => (isObject(current) ? current[key] : undefined),
    value,
  );
}

// Replaces `$ref` objects with the values earlier steps returned, recording each ID used.
function resolve(value: Value, results: Record<string, unknown>, used: Set<string>): Value {
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, results, used));
  if (!isObject(value)) return value;
  if (typeof value.$ref === 'string') {
    const [step, ...path] = value.$ref.split('.');
    const index = step === 'setup' ? path.shift() : undefined;
    const resolved = lookup(results[index === undefined ? step : `setup.${index}`], path);
    if (resolved === undefined) throw new Error(`reference ${value.$ref} resolved to nothing`);
    if (typeof resolved === 'string') used.add(resolved);
    return resolved;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolve(entry, results, used)]),
  );
}

// Every global ID in a value, so mutations can be held to IDs the run created.
function globalIds(value: unknown): string[] {
  if (typeof value === 'string') return GLOBAL_ID.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(globalIds);
  return isObject(value) ? Object.values(value).flatMap(globalIds) : [];
}

// Why a mutation, setup or cleanup step may not run, or undefined when it may.
function mutationRefusal(
  operation: OperationDefinitionNode,
  text: string,
  variables: unknown,
  created: Set<string>,
  role: 'operation' | 'setup' | 'cleanup',
) {
  if (GLOBAL_ID.test(text)) return 'it names a global ID in the document itself';
  if (role === 'setup' && !onlyFields(operation, 'Create'))
    return 'a setup step must only create objects';
  if (role === 'cleanup' && !onlyFields(operation, 'Delete'))
    return 'a cleanup step must only delete objects';
  const foreign = globalIds(variables).filter((id) => !created.has(id));
  if (foreign.length) return `it receives ${foreign[0]}, which this run did not create`;
  if (role === 'operation' && !onlyFields(operation, 'Create') && !globalIds(variables).length)
    return 'it neither creates an object nor targets one this run created';
  return undefined;
}

export async function liveShopifyProof(options: {
  store: ShopifyTestStore;
  versions: { before: string; after: string };
  // Every traced document of the patched code (and the original's, for the original version).
  documents: { id: string; original: string | null; patched: string }[];
  cases?: ShopifyLiveCase[];
  fetch?: Fetch;
}): Promise<ShopifyLiveProof> {
  const send = options.fetch ?? fetch;
  const { store, token } = options.store;
  const redact = (value: string) => value.split(token).join('[redacted]').slice(0, MAX_ERROR);
  const request = async (
    version: string,
    query: string,
    variables: Record<string, unknown>,
    operationName: string | null = null,
  ) => {
    for (let attempt = 0; ; attempt++) {
      const response = await send(`https://${store}/admin/api/${version}/graphql.json`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables, ...(operationName ? { operationName } : {}) }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      const errors = isObject(body) && Array.isArray(body.errors) ? body.errors : [];
      const throttled =
        response.status === 429 ||
        errors.some(
          (error) =>
            isObject(error) && isObject(error.extensions) && error.extensions.code === 'THROTTLED',
        );
      if (throttled && attempt < THROTTLE_RETRIES) {
        await new Promise((done) => setTimeout(done, THROTTLE_BACKOFF_MS * 2 ** attempt));
        continue;
      }
      const data = isObject(body) ? body.data : undefined;
      const userErrors = JSON.stringify(data ?? null).match(/"userErrors":\[\{[^\]]*\]/)?.[0];
      const first = errors[0];
      const error = !response.ok
        ? `HTTP ${response.status}`
        : first
          ? redact(
              isObject(first) && typeof first.message === 'string'
                ? first.message
                : JSON.stringify(first),
            )
          : userErrors
            ? redact(userErrors)
            : undefined;
      return { status: response.status, data, error };
    }
  };
  const created: { id: string; deleted: boolean }[] = [];
  const base = { store, created };
  try {
    const plan = await request(options.versions.after, DEV_STORE_QUERY, {});
    if (plan.error || lookup(plan.data, ['shop', 'plan', 'partnerDevelopment']) !== true)
      return {
        ...base,
        status: 'not-run',
        reason: plan.error
          ? `The test store did not answer the development-store check: ${plan.error}`
          : `${store} is not a Partner development store, so Refit sends it nothing else.`,
        operations: [],
      };
  } catch (error) {
    return {
      ...base,
      status: 'not-run',
      reason: `The test store could not be reached: ${redact(error instanceof Error ? error.message : String(error))}`,
      operations: [],
    };
  }
  const results: ShopifyLiveOperation[] = [];
  for (const document of options.documents) {
    for (const operation of operations(document.patched)) {
      const operationName = operation.name?.value ?? null;
      const kind = operation.operation;
      const entry: ShopifyLiveOperation = {
        document: document.id,
        operationName,
        kind,
        status: 'not-run',
      };
      results.push(entry);
      // The original document's operation of the same kind and name, else the patched one.
      const originalOperation =
        document.original &&
        operations(document.original).find(
          (entry) => entry.operation === kind && (entry.name?.value ?? null) === operationName,
        );
      const original = originalOperation ? document.original! : document.patched;
      const testCase = options.cases?.find(
        (item) => item.document === document.id && item.operationName === operationName,
      );
      if (kind === 'subscription') {
        entry.reason = 'subscriptions are not sent to the store';
        continue;
      }
      const missing = requiredVariables(operation).filter(
        (name) => testCase?.variables[name] === undefined,
      );
      if (missing.length) {
        entry.reason = `no value for required variable $${missing[0]}`;
        continue;
      }
      if (kind === 'mutation' && !testCase) {
        entry.reason = 'a mutation runs only with a case that creates what it changes';
        continue;
      }
      entry.versions = {};
      entry.status = 'passed';
      // Each version gets its own setup, so the target never reads objects the original created.
      for (const version of [options.versions.before, options.versions.after]) {
        const ids = new Set<string>();
        const stepResults: Record<string, unknown> = {};
        const refuse = (reason: string) => {
          entry.status = 'not-run';
          entry.reason = reason;
        };
        try {
          for (const [index, step] of (testCase?.setup ?? []).entries()) {
            const [setup] = operations(step.document);
            const variables = resolve(step.variables, stepResults, new Set()) as Record<
              string,
              unknown
            >;
            const refusal = setup && mutationRefusal(setup, step.document, variables, ids, 'setup');
            if (!setup || setup.operation !== 'mutation' || refusal) {
              refuse(`setup step ${index + 1} refused: ${refusal ?? 'it is not a mutation'}`);
              break;
            }
            const result = await request(version, step.document, variables);
            if (result.error) {
              entry.status = 'failed';
              entry.reason = `setup step ${index + 1} failed on ${version}: ${result.error}`;
              break;
            }
            stepResults[`setup.${index}`] = result.data;
            for (const id of createdIds(result.data, setup)) {
              ids.add(id);
              created.push({ id, deleted: false });
            }
          }
          if (entry.status !== 'passed') break;
          const variables = resolve(testCase?.variables ?? {}, stepResults, new Set()) as Record<
            string,
            unknown
          >;
          const text = version === options.versions.before ? original : document.patched;
          const sent =
            version === options.versions.before && originalOperation
              ? originalOperation
              : operation;
          if (kind === 'mutation') {
            const refusal = mutationRefusal(sent, text, variables, ids, 'operation');
            if (refusal) {
              refuse(`the mutation was refused: ${refusal}`);
              break;
            }
          }
          const result = await request(version, text, { ...variables }, operationName);
          entry.versions[version] = {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
          };
          stepResults.operation = result.data;
          if (kind === 'mutation')
            for (const id of createdIds(result.data, sent))
              if (!ids.has(id)) {
                ids.add(id);
                created.push({ id, deleted: false });
              }
          if (result.error) {
            entry.status = 'failed';
            entry.reason = `failed on ${version}: ${result.error}`;
          }
        } catch (error) {
          refuse(redact(error instanceof Error ? error.message : String(error)));
        } finally {
          for (const step of testCase?.cleanup ?? []) {
            try {
              const [cleanup] = operations(step.document);
              const used = new Set<string>();
              const variables = resolve(step.variables, stepResults, used) as Record<
                string,
                unknown
              >;
              if (!cleanup || mutationRefusal(cleanup, step.document, variables, ids, 'cleanup'))
                continue;
              const result = await request(version, step.document, variables);
              if (!result.error)
                for (const id of used) {
                  const record = created.find((item) => item.id === id);
                  if (record) record.deleted = true;
                }
            } catch {
              // An unresolved cleanup leaves the object on the development store, listed as kept.
            }
          }
        }
        if (entry.status !== 'passed') break;
      }
    }
  }
  const failed = results.find((entry) => entry.status === 'failed');
  const skipped = results.find((entry) => entry.status === 'not-run');
  const label = (entry: ShopifyLiveOperation) =>
    `${entry.document}${entry.operationName ? ` (${entry.operationName})` : ''}`;
  return {
    ...base,
    operations: results,
    ...(failed
      ? { status: 'failed' as const, reason: `${label(failed)} ${failed.reason}.` }
      : skipped || !results.length
        ? {
            status: 'not-run' as const,
            reason: skipped
              ? `${label(skipped)} did not run on the development store: ${skipped.reason}.`
              : 'No GraphQL operation to send to the development store.',
          }
        : {
            status: 'passed' as const,
            reason: `Every GraphQL operation the patched code sends (${results.length}) ran on Refit's Partner development store at Admin API ${options.versions.before} and ${options.versions.after} with no error.`,
          }),
  };
}
