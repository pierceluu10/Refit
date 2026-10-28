// Scores install-time vendor detection (pipeline/agent-catalog.ts scanProviders) against the blind
// labels: each repository is cloned at its labelled commit, scanned and deleted. Nothing in it is
// installed or run, and no vendor is contacted.
// Usage: node scripts/vendor-detection-benchmark.mjs --root <dir> --output <results.json>
import { execFileSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';
import { shallowCheckout } from './ai-app-helpers.mjs';

const load = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const { AGENT_CATALOG, scanProviders } = await load('../pipeline/agent-catalog.ts');

const LABELS = 'docs/benchmarks/2026-10-27-vendor-detection-labels.json';
// Labellers' vendor ids that name a catalog entry under another id.
const LABEL_IDS = { facebook: 'meta-graph' };

const { values } = parseArgs({ options: { root: { type: 'string' }, output: { type: 'string' } } });
if (!values.root || !values.output) throw new Error('Usage: --root <dir> --output <results.json>');
const catalogIds = new Set(AGENT_CATALOG.map((agent) => agent.id));
const { labels } = JSON.parse(await readFile(LABELS, 'utf8'));

const rows = [];
for (const label of labels) {
  const directory = await shallowCheckout(values.root, label.repository, label.commit, label.host);
  try {
    const { detections, vendorScan } = await scanProviders(directory);
    const detected = detections.map((detection) => detection.agent.id);
    const id = (vendor) => LABEL_IDS[vendor] ?? vendor;
    const confirmed = label.vendors.map((vendor) => id(vendor.vendor));
    const uncertain = label.uncertain.map((vendor) => id(vendor.vendor));
    rows.push({
      repository: label.repository,
      batch: label.batch,
      detected,
      truePositives: detected.filter((vendor) => confirmed.includes(vendor)),
      falsePositives: detected.filter(
        (vendor) => !confirmed.includes(vendor) && !uncertain.includes(vendor),
      ),
      missedInCatalog: confirmed.filter((v) => catalogIds.has(v) && !detected.includes(v)),
      missedOutsideCatalog: confirmed.filter((v) => !catalogIds.has(v)),
      vendorScan,
      evidence: Object.fromEntries(
        detections.map((detection) => [
          detection.agent.id,
          [
            ...detection.packages.map((item) => `package ${item.name} ${item.file}`),
            ...detection.hostnames.map((item) => `host ${item.hostname} ${item.file}:${item.line}`),
            ...detection.references.map(
              (item) => `${item.kind} ${item.name} ${item.file}:${item.line}`,
            ),
          ].slice(0, 4),
        ]),
      ),
    });
    console.error(`${label.repository}: ${detected.join(' ')}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function score(subset) {
  const sum = (key) => subset.reduce((total, row) => total + row[key].length, 0);
  const tp = sum('truePositives');
  const fp = sum('falsePositives');
  const missedCatalog = sum('missedInCatalog');
  const outside = sum('missedOutsideCatalog');
  const ratio = (a, b) => (b ? Number((a / b).toFixed(3)) : null);
  return {
    repositories: subset.length,
    truePositives: tp,
    falsePositives: fp,
    missedInCatalog: missedCatalog,
    labelledOutsideCatalog: outside,
    precision: ratio(tp, tp + fp),
    recallCatalogVendors: ratio(tp, tp + missedCatalog),
    recallAllVendors: ratio(tp, tp + missedCatalog + outside),
  };
}
const results = {
  formatVersion: 1,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  labels: LABELS,
  scannedAt: new Date().toISOString(),
  scores: {
    all: score(rows),
    heldOut: score(rows.filter((row) => row.batch === 'a')),
    b: score(rows.filter((row) => row.batch === 'b')),
  },
  rows,
};
await writeFile(values.output, `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results.scores, null, 2));
