import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validDate } from './deadline-registry.ts';
import { PROOF_APIS, type ProofApi } from './model-request-proofs.ts';
import { isObject, parseObject } from './specifications.ts';
import { PipelineInputError } from './types.ts';

// What a replacement model renames, rejects or changes about a request parameter, each change
// quoted verbatim from an official page saved in docs/benchmarks/parameter-pages/. `rename` and
// `remove` are applied together with the model swap, only when a caller passes the table (off by
// default; owner decision pending, see docs/proposals/ai-model-parameters.md); `stop` always
// lists the request for review with the note.
export const DEFAULT_PARAMETER_CHANGES = new URL(
  '../data/model-parameter-changes.json',
  import.meta.url,
);
export const PARAMETER_PAGES = new URL('../docs/benchmarks/parameter-pages/', import.meta.url);

export interface ParameterChange {
  id: string;
  provider: 'openai' | 'anthropic';
  apis: ProofApi[];
  // Final replacement models the page's statement covers; `*` for every model.
  models: string[];
  parameters: string[];
  action: 'rename' | 'remove' | 'stop';
  to?: string;
  // Request parameters whose presence the statement depends on: the request stops instead.
  stopIfPresent?: string[];
  page: string;
  quote: string;
  checkedAt: string;
  // What the customer should know about the change; it goes into the draft.
  note: string;
}

export interface ParameterChangeTable {
  formatVersion: 1;
  changes: ParameterChange[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// Shape problems and quotes that are not on their saved page reject the whole table.
export function checkParameterChanges(
  value: unknown,
  pages: Record<string, { text: string; sha256: string }>,
): { errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value) || value.formatVersion !== 1 || !Array.isArray(value.changes))
    return { errors: ['Parameter changes require formatVersion: 1 and a changes array.'] };
  const seen = new Set<string>();
  value.changes.forEach((change, index) => {
    const label = `change ${index}`;
    if (!isObject(change)) return errors.push(`${label}: must be an object.`);
    const id = typeof change.id === 'string' ? change.id : label;
    if (!/^[a-z0-9-]+$/.test(id) || seen.has(id)) errors.push(`${label}: id must be unique.`);
    seen.add(id);
    if (change.provider !== 'openai' && change.provider !== 'anthropic')
      errors.push(`${id}: provider must be openai or anthropic.`);
    if (
      !Array.isArray(change.apis) ||
      !change.apis.length ||
      change.apis.some((api) => !PROOF_APIS.includes(api as ProofApi))
    )
      errors.push(`${id}: apis must name request families.`);
    if (
      !Array.isArray(change.models) ||
      !change.models.length ||
      change.models.some(
        (model) =>
          typeof model !== 'string' || !(model === '*' || /^[a-z0-9][a-z0-9.-]*$/.test(model)),
      )
    )
      errors.push(`${id}: models must be model IDs or *.`);
    for (const key of ['parameters', 'stopIfPresent'] as const)
      if (
        (key === 'parameters' || Object.hasOwn(change, key)) &&
        (!Array.isArray(change[key]) ||
          !change[key].length ||
          change[key].some((name) => typeof name !== 'string' || !IDENTIFIER.test(name)))
      )
        errors.push(`${id}: ${key} must be parameter names.`);
    if (change.action !== 'rename' && change.action !== 'remove' && change.action !== 'stop')
      errors.push(`${id}: action must be rename, remove or stop.`);
    if (
      change.action === 'rename'
        ? typeof change.to !== 'string' ||
          !IDENTIFIER.test(change.to) ||
          !Array.isArray(change.parameters) ||
          change.parameters.length !== 1
        : Object.hasOwn(change, 'to')
    )
      errors.push(`${id}: a rename names one parameter and its new name; nothing else has to.`);
    if (typeof change.note !== 'string' || !change.note.trim())
      errors.push(`${id}: note is required.`);
    if (!validDate(change.checkedAt)) errors.push(`${id}: checkedAt must be YYYY-MM-DD.`);
    const page = typeof change.page === 'string' ? pages[change.page] : undefined;
    if (!page) errors.push(`${id}: page must be a saved page in docs/benchmarks/parameter-pages.`);
    else if (createHash('sha256').update(page.text).digest('hex') !== page.sha256)
      errors.push(`${id}: ${change.page} does not match its recorded SHA-256.`);
    else if (
      typeof change.quote !== 'string' ||
      change.quote.length < 20 ||
      !page.text.includes(change.quote)
    )
      errors.push(`${id}: the quote is not on ${change.page} verbatim.`);
  });
  return { errors };
}

export async function readParameterPages() {
  const index = parseObject(
    await readFile(new URL('index.json', PARAMETER_PAGES), 'utf8'),
    'Parameter page index',
  );
  const pages: Record<string, { text: string; sha256: string; url: string }> = {};
  for (const item of Array.isArray(index.pages) ? index.pages : [])
    if (isObject(item) && typeof item.file === 'string' && /^[a-z0-9-]+\.md$/.test(item.file))
      pages[item.file] = {
        text: await readFile(new URL(item.file, PARAMETER_PAGES), 'utf8'),
        sha256: String(item.sha256),
        url: String(item.url),
      };
  return pages;
}

export async function loadParameterChanges(path: string | URL = DEFAULT_PARAMETER_CHANGES) {
  const value = parseObject(await readFile(path, 'utf8'), 'Parameter changes');
  const { errors } = checkParameterChanges(value, await readParameterPages());
  if (errors.length)
    throw new PipelineInputError(`Parameter changes are invalid: ${errors.slice(0, 5).join(' ')}`);
  return value as unknown as ParameterChangeTable;
}

// The change that covers one parameter of a request to `model` through `api`, if any.
export function parameterChange(
  table: ParameterChangeTable,
  provider: string,
  model: string,
  api: ProofApi | null,
  parameter: string,
) {
  return table.changes.find(
    (change) =>
      change.provider === provider &&
      api !== null &&
      change.apis.includes(api) &&
      (change.models.includes('*') || change.models.includes(model)) &&
      change.parameters.includes(parameter),
  );
}
