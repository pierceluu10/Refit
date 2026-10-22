// Checks benchmark results against the JSON schemas in docs/benchmarks/schemas (see
// docs/BENCHMARK-HARNESS.md). The schemas use a small subset of JSON Schema 2020-12; a keyword
// outside it is an error, so a schema never checks less than it appears to.
//
//   node scripts/benchmark-results.mjs --committed          every docs/benchmarks/*-results.json
//   node scripts/benchmark-results.mjs <run directory>      a Stripe or Shopify run's output
//   node scripts/benchmark-results.mjs --format <name> <file>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SCHEMA_DIRECTORY = fileURLToPath(
  new URL('../docs/benchmarks/schemas/', import.meta.url),
);
const BENCHMARK_DIRECTORY = fileURLToPath(new URL('../docs/benchmarks/', import.meta.url));
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', 'x-added']);
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  '$defs',
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'enum',
  'const',
  'pattern',
  'minimum',
  'minLength',
  'minItems',
  'anyOf',
]);

const typeOf = (value) =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value;
const matchesType = (value, type) =>
  type === typeOf(value) || (type === 'number' && typeof value === 'number');
const escape = (key) => key.replaceAll('~', '~0').replaceAll('/', '~1');
// Errors from `const` and `enum`. In an `anyOf`, an option that fails one on the value itself or
// on one of its properties does not apply, so its errors do not explain the failure.
const mismatches = new WeakSet();
const discriminates = (error, pointer) =>
  mismatches.has(error) &&
  (error.pointer === (pointer || '/') ||
    (error.pointer.startsWith(`${pointer}/`) &&
      !error.pointer.slice(pointer.length + 1).includes('/')));

// Every `<format>.schema.json` in the directory, by format name.
export function loadSchemas(directory = SCHEMA_DIRECTORY) {
  return new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith('.schema.json'))
      .map((name) => [
        name.slice(0, -'.schema.json'.length),
        JSON.parse(readFileSync(join(directory, name), 'utf8')),
      ]),
  );
}

// Problems with `data` as the given format. A missing property whose schema carries `x-added`
// (the date the harness added it) is listed under `predates`: older results lack it by design.
// Everything else is an error.
export function validate(schemas, format, data) {
  const root = schemas.get(format);
  if (!root) throw new Error(`Unknown results format "${format}".`);
  const errors = [];
  const predates = [];
  check(schemas, root, root, data, '', errors, predates);
  // A value reached through two schemas, such as a property and an `anyOf` option, reports once.
  const unique = (problems) => [
    ...new Map(
      problems.map(({ pointer, message }) => [`${pointer}\0${message}`, { pointer, message }]),
    ).values(),
  ];
  return { errors: unique(errors), predates: unique(predates) };
}

// `#/$defs/<name>` in the same schema, `<format>.schema.json` or `<format>.schema.json#/$defs/<name>`.
function resolveReference(schemas, root, reference) {
  const [file, fragment] = reference.split('#');
  const target = file ? schemas.get(file.replace(/\.schema\.json$/, '')) : root;
  if (!target || (file && !file.endsWith('.schema.json')))
    throw new Error(`Schema reference ${reference} is unknown.`);
  if (!fragment) return { root: target, schema: target };
  const schema = fragment.startsWith('/$defs/')
    ? target.$defs?.[fragment.slice('/$defs/'.length)]
    : undefined;
  if (!schema) throw new Error(`Schema reference ${reference} does not exist.`);
  return { root: target, schema };
}

function check(schemas, root, schema, value, pointer, errors, predates) {
  for (const keyword of Object.keys(schema))
    if (!KEYWORDS.has(keyword)) throw new Error(`Unsupported schema keyword "${keyword}".`);
  const fail = (message) => errors.push({ pointer: pointer || '/', message });
  if (schema.$ref) {
    const target = resolveReference(schemas, root, schema.$ref);
    check(schemas, target.root, target.schema, value, pointer, errors, predates);
  }
  if (schema.type) {
    const types = [schema.type].flat();
    if (!types.some((type) => matchesType(value, type))) {
      fail(`must be ${types.join(' or ')}, not ${typeOf(value)}`);
      return;
    }
  }
  const mismatch = (message) => {
    fail(message);
    mismatches.add(errors.at(-1));
  };
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const))
    mismatch(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)))
    mismatch(`must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      fail(`must match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      fail(`must have at least ${schema.minLength} characters`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum)
    fail(`must be at least ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      fail(`must have at least ${schema.minItems} items`);
    if (schema.items)
      value.forEach((item, index) =>
        check(schemas, root, schema.items, item, `${pointer}/${index}`, errors, predates),
      );
  }
  if (typeOf(value) === 'object') {
    const properties = schema.properties ?? {};
    // A property set to undefined is absent, as it is once the results are written as JSON.
    const present = Object.entries(value).filter(([, item]) => item !== undefined);
    for (const name of schema.required ?? [])
      if (value[name] === undefined || !Object.hasOwn(value, name)) {
        const missing = { pointer: `${pointer}/${escape(name)}`, message: 'is required' };
        if (properties[name]?.['x-added']) predates.push(missing);
        else errors.push(missing);
      }
    for (const [name, item] of present) {
      const path = `${pointer}/${escape(name)}`;
      if (schema.propertyNames)
        check(schemas, root, schema.propertyNames, name, path, errors, predates);
      if (Object.hasOwn(properties, name))
        check(schemas, root, properties[name], item, path, errors, predates);
      else if (schema.additionalProperties === false)
        errors.push({ pointer: path, message: 'is not allowed' });
      else if (typeof schema.additionalProperties === 'object')
        check(schemas, root, schema.additionalProperties, item, path, errors, predates);
    }
  }
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((option) => {
      const attempt = { errors: [], predates: [] };
      check(schemas, root, option, value, pointer, attempt.errors, attempt.predates);
      return attempt;
    });
    const passed = attempts.find((attempt) => !attempt.errors.length);
    if (passed) predates.push(...passed.predates);
    else {
      // The closest option that applies explains the failure best.
      const applies = attempts.filter(
        (attempt) => !attempt.errors.some((error) => discriminates(error, pointer)),
      );
      const closest = (applies.length ? applies : attempts).reduce((best, attempt) =>
        attempt.errors.length < best.errors.length ? attempt : best,
      );
      errors.push(...closest.errors);
    }
  }
}

// The same pointer with array indexes replaced by `*`, so one entry stands for every row.
export const pointerPattern = (pointer) => pointer.replace(/\/\d+(?=\/|$)/g, '/*');

// For summaries: throws unless `data` is valid as `format`. Older results that lack only fields
// the harness added are accepted when `allowPredating` is set, and their predated pointers are
// returned so the caller can say so.
export function assertResults(format, data, { allowPredating = false, schemas } = {}) {
  const { errors, predates } = validate(schemas ?? loadSchemas(), format, data);
  const problems = [...errors, ...(allowPredating ? [] : predates)];
  if (problems.length)
    throw new Error(
      `Results do not match the ${format} schema:\n${problems
        .slice(0, 20)
        .map((problem) => `  ${problem.pointer} ${problem.message}`)
        .join('\n')}${problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : ''}`,
    );
  return { predates: [...new Set(predates.map((item) => pointerPattern(item.pointer)))].sort() };
}

// A run directory holds results.json and the harness.json written when the run started.
export function validateRunDirectory(directory, schemas = loadSchemas()) {
  const harnessPath = join(directory, 'harness.json');
  if (!existsSync(harnessPath))
    return {
      format: undefined,
      errors: [{ pointer: '/', message: `${harnessPath} is missing` }],
      predates: [],
    };
  const harness = JSON.parse(readFileSync(harnessPath, 'utf8'));
  const checked = validate(schemas, 'harness', harness);
  const format = harness.format;
  if (checked.errors.length || !schemas.has(format)) return { format, ...checked };
  const results = validate(
    schemas,
    format,
    JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')),
  );
  return {
    format,
    errors: [...checked.errors, ...results.errors],
    predates: [...checked.predates, ...results.predates],
  };
}

// Every committed results file must be listed in schemas/files.json with its format and the
// fields it predates. A listed predated field that the file actually has, or a predated field
// that is not listed, is an error too, so the record stays exact.
export function validateCommitted(
  benchmarks = BENCHMARK_DIRECTORY,
  schemas = loadSchemas(join(benchmarks, 'schemas')),
) {
  const index = JSON.parse(readFileSync(join(benchmarks, 'schemas', 'files.json'), 'utf8')).files;
  const files = readdirSync(benchmarks)
    .filter((name) => name.endsWith('-results.json'))
    .sort();
  const reports = files.map((file) => {
    const entry = index[file];
    if (!entry)
      return {
        file,
        errors: [{ pointer: '/', message: 'is not listed in schemas/files.json' }],
        predates: [],
      };
    const { errors, predates } = validate(
      schemas,
      entry.format,
      JSON.parse(readFileSync(join(benchmarks, file), 'utf8')),
    );
    const found = [...new Set(predates.map((item) => pointerPattern(item.pointer)))].sort();
    const recorded = [...(entry.predates ?? [])].sort();
    for (const pointer of found.filter((item) => !recorded.includes(item)))
      errors.push({ pointer, message: 'is missing and not recorded as predated in files.json' });
    for (const pointer of recorded.filter((item) => !found.includes(item)))
      errors.push({ pointer, message: 'is recorded as predated in files.json but present' });
    return { file, format: entry.format, errors, predates };
  });
  for (const file of Object.keys(index).filter((name) => !files.includes(name)))
    reports.push({
      file,
      errors: [{ pointer: '/', message: 'is listed in schemas/files.json but missing' }],
      predates: [],
    });
  return reports;
}

function print(label, { format, errors, predates }) {
  const patterns = [...new Set(predates.map((item) => pointerPattern(item.pointer)))];
  const note = patterns.length ? ` (predates ${patterns.join(', ')})` : '';
  if (!errors.length) {
    console.log(`ok       ${label}${format ? ` [${format}]` : ''}${note}`);
    return true;
  }
  console.log(`invalid  ${label}${format ? ` [${format}]` : ''}`);
  for (const error of errors.slice(0, 20))
    console.log(`         ${error.pointer} ${error.message}`);
  if (errors.length > 20) console.log(`         ... and ${errors.length - 20} more`);
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      committed: { type: 'boolean' },
      format: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || (!values.committed && positionals.length !== 1)) {
    console.log(
      'Usage: node scripts/benchmark-results.mjs --committed | <run directory> | --format <name> <file>',
    );
    process.exit(values.help ? 0 : 1);
  }
  let ok;
  if (values.committed) {
    const reports = validateCommitted();
    ok = reports.map((report) => print(report.file, report)).every(Boolean);
    console.log(
      `${reports.filter((report) => !report.errors.length).length}/${reports.length} committed results files valid.`,
    );
  } else if (values.format)
    ok = print(
      positionals[0],
      validate(loadSchemas(), values.format, JSON.parse(readFileSync(positionals[0], 'utf8'))),
    );
  else ok = print(positionals[0], validateRunDirectory(resolve(positionals[0])));
  if (!ok) process.exitCode = 1;
}
