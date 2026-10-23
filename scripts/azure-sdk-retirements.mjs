// Builds data/azure-sdk-retirements.json: the legacy ("track 1") Azure SDK for JavaScript packages
// Microsoft lists as deprecated, with the end-of-life date and replacement Microsoft gives for each.
// The list is Microsoft's release data, `_data/releases/latest/js-packages.csv` in the Azure/azure-sdk
// repository, which renders https://azure.github.io/azure-sdk/releases/deprecated/js.html. A package
// is kept when its row says `deprecated` with an end-of-life date and the whole package was
// retired: an unscoped name (every track-1 package), or an `@azure/` name whose row names a different
// package as its replacement. Rows that retire only old versions of a package that is still
// maintained (such as `@azure/event-hubs` 2.x) would flag current users and are left out. Each kept
// name is checked against the npm registry, and npm's own deprecation notice is recorded.
//
//   curl -o js-packages.csv https://raw.githubusercontent.com/Azure/azure-sdk/<commit>/_data/releases/latest/js-packages.csv
//   node scripts/azure-sdk-retirements.mjs --csv js-packages.csv --commit <commit> \
//     --checked-at 2026-10-22 --output data/azure-sdk-retirements.json
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org';
const CONCURRENCY = 16;
const { values } = parseArgs({
  options: {
    csv: { type: 'string' },
    commit: { type: 'string' },
    'checked-at': { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.csv ||
  !/^[a-f0-9]{40}$/.test(values.commit ?? '') ||
  !/^\d{4}-\d{2}-\d{2}$/.test(values['checked-at'] ?? '') ||
  !values.output
) {
  console.log(
    'Usage: node scripts/azure-sdk-retirements.mjs --csv <js-packages.csv> --commit <azure-sdk commit> --checked-at YYYY-MM-DD --output <file.json>',
  );
  process.exit(values.help ? 0 : 1);
}

// The file quotes every field; quotes inside a field are doubled.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.map((values) => Object.fromEntries(header.map((name, i) => [name, values[i] ?? ''])));
}

// `3/31/2023` -> `2023-03-31`.
function isoDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function replacements(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item !== 'NA');
}

async function registryEntry(name) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`);
    if (response.ok) return response.json();
    if (response.status === 404) return undefined;
    if (attempt >= 3) throw new Error(`${name}: HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
  }
}

const rows = parseCsv(await readFile(values.csv, 'utf8'));
// `depreacted` is Microsoft's own misspelling on at least one row (azure-cognitiveservices-customsearch).
const deprecated = rows.filter((row) => /^depre(?:c|ac)/i.test(row.Support));
const skipped = { noDate: [], versionOnly: [], notOnNpm: [] };
const kept = [];
for (const row of deprecated) {
  const date = isoDate(row.EOLDate);
  if (!date) {
    skipped.noDate.push(row.Package);
    continue;
  }
  const replacement = replacements(row.Replace);
  const whole =
    !row.Package.startsWith('@') ||
    (row.Package.startsWith('@azure') &&
      replacement.length > 0 &&
      !replacement.includes(row.Package));
  if (!whole) {
    skipped.versionOnly.push(row.Package);
    continue;
  }
  kept.push({ name: row.Package, displayName: row.DisplayName, date, replacement, row });
}
for (let start = 0; start < kept.length; start += CONCURRENCY) {
  const batch = kept.slice(start, start + CONCURRENCY);
  const entries = await Promise.all(batch.map((item) => registryEntry(item.name)));
  batch.forEach((item, index) => {
    const entry = entries[index];
    item.npm = entry;
  });
}
const packages = kept
  .filter((item) => {
    if (item.npm) return true;
    skipped.notOnNpm.push(item.name);
    return false;
  })
  .map((item) => {
    const latest = item.npm['dist-tags']?.latest;
    return {
      name: item.name,
      displayName: item.displayName,
      endOfLife: item.date,
      replacement: item.replacement,
      latest: latest ?? null,
      npmDeprecated: (latest && item.npm.versions?.[latest]?.deprecated) || null,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
for (const list of Object.values(skipped)) list.sort();
await writeFile(
  values.output,
  `${JSON.stringify(
    {
      formatVersion: 1,
      generatedBy: 'scripts/azure-sdk-retirements.mjs',
      checkedAt: values['checked-at'],
      source: `https://github.com/Azure/azure-sdk/blob/${values.commit}/_data/releases/latest/js-packages.csv`,
      page: 'https://azure.github.io/azure-sdk/releases/deprecated/js.html',
      skipped,
      packages,
    },
    null,
    2,
  )}\n`,
);
console.error(
  `${deprecated.length} deprecated rows; kept ${packages.length}; skipped ${JSON.stringify(Object.fromEntries(Object.entries(skipped).map(([key, list]) => [key, list.length])))}`,
);
