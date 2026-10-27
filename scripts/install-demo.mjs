// Install-time vendor demo. Reads a real installation delivery of the Refit GitHub App through the
// App deliveries API, re-signs it with this run's webhook secret and replays it into a running
// `refit hosted serve`, then waits for the inventories and watch captures and writes what the
// worker stored: per repository the detected vendors, their labels and the watch targets.
// Private repositories are counted but never named, because demo output may be public.
//
//   GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_FILE=… REFIT_WEBHOOK_SECRET=… REFIT_SERVICE_TOKEN=… \
//   REFIT_DATABASE_URL=… \
//   node scripts/install-demo.mjs --owner <login> --service http://127.0.0.1:8787 \
//     --output demo.json [--summary <markdown file>] [--delivery <id>]
import { createHmac } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const load = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig: false });
const { appJwt, githubAppConfiguration } = await load('../pipeline/github-app.ts');
const { requestGitHub } = await load('../pipeline/github.ts');
const { openHostedPool } = await load('../pipeline/hosted-database.ts');
const { openInventoryStore } = await load('../pipeline/inventory-store.ts');

const INSTALL_EVENTS = new Map([
  ['installation', 'created'],
  ['installation_repositories', 'added'],
]);
const DELIVERY_PAGES = 5;
const POLL_MS = 10_000;
const INVENTORY_TIMEOUT_MS = 20 * 60_000;
const WATCH_TIMEOUT_MS = 15 * 60_000;

const { values } = parseArgs({
  options: {
    owner: { type: 'string' },
    service: { type: 'string' },
    output: { type: 'string' },
    summary: { type: 'string' },
    delivery: { type: 'string' },
  },
});
if (!values.owner || !values.service || !values.output)
  throw new Error('Usage: --owner <login> --service <url> --output <json> [--summary <md>]');
const secret = process.env.REFIT_WEBHOOK_SECRET;
const token = process.env.REFIT_SERVICE_TOKEN;
if (!secret || !token || !process.env.REFIT_DATABASE_URL)
  throw new Error('REFIT_WEBHOOK_SECRET, REFIT_SERVICE_TOKEN and REFIT_DATABASE_URL are required.');
const app = githubAppConfiguration(process.env);

// The newest install delivery for the owner's account, or the one named by --delivery.
async function installDelivery() {
  const jwt = await appJwt(app);
  let cursor = '';
  for (let page = 0; page < DELIVERY_PAGES; page += 1) {
    const response = await fetch(
      `https://api.github.com/app/hook/deliveries?per_page=100${cursor ? `&cursor=${cursor}` : ''}`,
      { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } },
    );
    if (!response.ok) throw new Error(`Listing App deliveries failed with HTTP ${response.status}.`);
    for (const item of await response.json()) {
      if (values.delivery ? String(item.id) !== values.delivery : INSTALL_EVENTS.get(item.event) !== item.action)
        continue;
      const detail = await requestGitHub(jwt, 'GET', `/app/hook/deliveries/${item.id}`);
      const payload = detail.request?.payload;
      if (payload?.installation?.account?.login?.toLowerCase() !== values.owner.toLowerCase()) continue;
      return { id: item.id, guid: item.guid, event: item.event, action: item.action, deliveredAt: item.delivered_at, payload };
    }
    cursor = /[?&]cursor=([^&>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    if (!cursor) break;
  }
  throw new Error(`No installation delivery for ${values.owner} in the App's recent deliveries.`);
}

async function service(path, init) {
  const response = await fetch(`${values.service}${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}: ${body.error ?? ''}`);
  return body;
}
const status = () => service('/status', { headers: { Authorization: `Bearer ${token}` } });

async function until(timeoutMs, done) {
  for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(POLL_MS)) {
    const current = await status();
    if (done(current)) return current;
  }
  throw new Error(`Timed out after ${timeoutMs / 1000} seconds.`);
}

const delivery = await installDelivery();
const named = delivery.payload.repositories ?? delivery.payload.repositories_added ?? [];
const visibility = new Map(named.map((repository) => [repository.full_name.toLowerCase(), !repository.private]));
console.log(
  `Replaying ${delivery.event}.${delivery.action} delivery ${delivery.id} (${delivery.deliveredAt}) for ${values.owner}: ${named.length} repositories, ${[...visibility.values()].filter(Boolean).length} public.`,
);
const body = JSON.stringify(delivery.payload);
const accepted = await service('/github/webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-GitHub-Event': delivery.event,
    'X-GitHub-Delivery': delivery.guid,
    'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  },
  body,
});
console.log(`Worker accepted the delivery: ${JSON.stringify(accepted)}`);

const inventoried = (current) =>
  [...visibility.keys()].every((repository) => {
    const row = current.inventories.find((item) => item.repository === repository);
    return row && row.state === 'idle' && (row.scannedAt || row.error);
  });
const afterInventory = await until(INVENTORY_TIMEOUT_MS, inventoried);
console.log('Every repository the delivery named has an inventory.');
const final = await until(WATCH_TIMEOUT_MS, (current) =>
  current.watch.targets.every((target) => target.captures),
);
console.log(`Every watch target was captured (${final.watch.targets.length}).`);

// Stored inventories are read from the database: `refit hosted inventory` would queue another scan.
const pool = openHostedPool(process.env.REFIT_DATABASE_URL, (error) => console.error(error.message));
const inventories = openInventoryStore(pool);
const targets = new Map(final.watch.targets.map((target) => [target.provider, target]));
const repositories = [];
let withheld = 0;
for (const [repository, open] of visibility) {
  if (!open) {
    withheld += 1;
    continue;
  }
  const [row] = await inventories.read(repository);
  repositories.push({
    repository,
    inventory: { status: row.status, stop: row.stop, error: row.error, revision: row.revision },
    vendors: (row.inventory?.providers ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name,
      status: provider.status,
      watch: provider.watch,
      evidence: {
        packages: provider.packages.length,
        hostnames: provider.hostnames.length,
        references: provider.references.length,
      },
      target: targets.get(provider.id) ?? null,
    })),
  });
}
await pool.end();
const report = {
  formatVersion: 1,
  delivery: { id: delivery.id, event: delivery.event, action: delivery.action, deliveredAt: delivery.deliveredAt },
  owner: values.owner,
  privateRepositoriesWithheld: withheld,
  repositories,
  watchTargets: final.watch.targets.map(({ repositories: users, ...target }) => ({
    ...target,
    repositories: users.filter((repository) => visibility.get(repository)).length,
  })),
  inventoriesCompletedAt: afterInventory.checkedAt ?? new Date().toISOString(),
};
await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);

const capture = (target) =>
  (target?.captures ?? [])
    .map((item) => `${item.kind === 'specification' ? 'OpenAPI' : 'docs'} ${'hash' in item ? item.hash.slice(0, 12) : `failed: ${item.error}`}`)
    .join('; ');
const lines = [
  `## Install-time vendor inventory`,
  '',
  `Replayed \`${delivery.event}.${delivery.action}\` delivery ${delivery.id} (delivered ${delivery.deliveredAt}) for \`${values.owner}\` into \`refit hosted serve\` with PostgreSQL ${process.env.POSTGRES_VERSION ?? ''}.`,
  withheld ? `${withheld} private repositories were inventoried but are not named here.` : '',
  '',
];
for (const entry of repositories) {
  lines.push(`### ${entry.repository}`, '', `Inventory: ${entry.inventory.status ?? 'none'}${entry.inventory.stop ? ` (${entry.inventory.stop})` : ''}${entry.inventory.error ? ` error: ${entry.inventory.error}` : ''}`, '');
  if (!entry.vendors.length) lines.push('No catalog vendor detected.', '');
  else {
    lines.push('| Vendor | Label | Evidence | Watch target |', '| --- | --- | --- | --- |');
    for (const vendor of entry.vendors)
      lines.push(
        `| ${vendor.name} | ${vendor.status} | ${vendor.evidence.packages} packages, ${vendor.evidence.hostnames} hosts, ${vendor.evidence.references} env/other refs | ${vendor.watch.status === 'watched' ? `watched: ${capture(vendor.target)}` : `unwatched: ${vendor.watch.reason}`} |`,
      );
    lines.push('');
  }
}
lines.push('### Watch targets', '', '| Vendor | OpenAPI | Changelog pages | Captured | Error |', '| --- | --- | --- | --- | --- |');
for (const target of final.watch.targets)
  lines.push(
    `| ${target.provider} | ${target.sources.specification ?? '-'} | ${target.sources.documentation.map((page) => page.url).join('<br>') || '-'} | ${capture(target)} | ${target.error ?? ''} |`,
  );
const markdown = `${lines.join('\n')}\n`;
if (values.summary) await appendFile(values.summary, markdown);
console.log(markdown);
