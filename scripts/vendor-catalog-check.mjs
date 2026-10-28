// Re-reads every source in data/vendor-catalog.json: each environment variable name and new vendor
// hostname must appear in the text of its `source` page, each new npm package must exist on the
// registry, each OpenAPI document must download and parse, and each documentation page must
// capture with Refit's own capture. Non-npm package names are checked by
// scripts/catalog-registry-check.mjs. Nothing is installed or run.
//
//   node scripts/vendor-catalog-check.mjs [--output docs/benchmarks/<date>-vendor-catalog-check.json]
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const load = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const { VENDOR_CATALOG: catalog } = await load('../pipeline/agent-catalog.ts');
const { captureSpecification } = await load('../pipeline/openapi-sources.ts');
const { captureDocumentation } = await load('../pipeline/documentation-sources.ts');

const USER_AGENT = 'refit-vendor-catalog-check (https://github.com/pierceluu10/Refit)';
const TIMEOUT_MS = 60_000;
const { values } = parseArgs({ options: { output: { type: 'string' } } });

const pages = new Map();
async function text(url) {
  if (!pages.has(url))
    pages.set(
      url,
      fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(async (response) => ({ status: response.status, body: await response.text() })),
    );
  return pages.get(url);
}

async function contains(url, names) {
  try {
    const { status, body } = await text(url);
    const missing = names.filter((name) => !body.includes(name));
    return { status, ok: status === 200 && !missing.length, missing };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const checks = [];
const record = (vendor, kind, subject, result) => {
  checks.push({ vendor, kind, subject, ...result });
  console.error(
    `${result.ok ? 'ok  ' : 'FAIL'} ${vendor} ${kind} ${subject} ${result.missing?.join(',') ?? result.error ?? ''}`,
  );
};
const entries = [
  ...Object.entries(catalog.sources).map(([id, sources]) => ({ id, ...sources })),
  ...catalog.vendors,
];
for (const entry of entries) {
  for (const group of entry.envVars ?? [])
    record(entry.id, 'envVars', group.source, await contains(group.source, group.names));
  // A leading dot marks a subdomain match; the page names the bare domain.
  for (const group of entry.hostnames ?? [])
    record(
      entry.id,
      'hostnames',
      group.source,
      await contains(
        group.source,
        group.names.map((host) => host.replace(/^\./, '')),
      ),
    );
  if (entry.name) {
    for (const name of entry.packages) {
      const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
      const { status } = await text(url).catch(() => ({ status: 0 }));
      record(entry.id, 'npm', name, { ok: status === 200, status });
    }
  }
  if (entry.specification)
    try {
      const snapshot = await captureSpecification(
        { kind: 'https', url: entry.specification.url },
        entry.id,
      );
      record(entry.id, 'specification', entry.specification.url, {
        ok: true,
        hash: snapshot.hash,
        bytes: Buffer.byteLength(snapshot.content),
      });
    } catch (error) {
      record(entry.id, 'specification', entry.specification.url, {
        ok: false,
        error: error.message,
      });
    }
  for (const page of entry.documentation ?? [])
    try {
      const snapshot = await captureDocumentation({ label: page.label, url: page.url });
      record(entry.id, 'documentation', page.url, {
        ok: true,
        hash: snapshot.hash,
        contentType: snapshot.contentType,
      });
    } catch (error) {
      record(entry.id, 'documentation', page.url, { ok: false, error: error.message });
    }
}
const report = { formatVersion: 1, checkedAt: new Date().toISOString(), checks };
if (values.output) await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
