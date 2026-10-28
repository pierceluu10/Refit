// Install-time vendor demo. Reads a real installation delivery of the Refit GitHub App through the
// App deliveries API, re-signs it with this run's webhook secret and replays it into a running
// `refit hosted serve`, then waits for the inventories and watch captures and writes what the
// worker stored: per repository the detected vendors, their labels and the watch targets.
// Private repositories are counted but never named, because demo output may be public.
//
// Two steps, so the worker can be started with the delivery's account allowed:
//
//   GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_FILE=… \
//   node scripts/install-demo.mjs fetch --delivery-file <private json> [--owner <login>] [--delivery <id>]
//   REFIT_WEBHOOK_SECRET=… REFIT_SERVICE_TOKEN=… REFIT_DATABASE_URL=… \
//   node scripts/install-demo.mjs replay --delivery-file <private json> --service http://127.0.0.1:8787 \
//     --output demo.json [--summary <markdown file>]
//
// fetch prints the delivery's account (and writes `account=` to GITHUB_OUTPUT when set). The
// delivery file names private repositories, so it must stay out of public artifacts.
import { createHmac } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const load = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig: false });

const INSTALL_EVENTS = new Map([
  ['installation', 'created'],
  ['installation_repositories', 'added'],
]);
const DELIVERY_PAGES = 20;
const POLL_MS = 10_000;
const INVENTORY_TIMEOUT_MS = 20 * 60_000;
const WATCH_TIMEOUT_MS = 20 * 60_000;

const USAGE =
  'Usage: fetch --delivery-file <json> [--owner <login>] [--delivery <id>]\n' +
  '       replay --delivery-file <json> --service <url> --output <json> [--summary <md>]';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'delivery-file': { type: 'string' },
    owner: { type: 'string' },
    service: { type: 'string' },
    output: { type: 'string' },
    summary: { type: 'string' },
    delivery: { type: 'string' },
  },
});
const command = positionals[0];
if (
  !values['delivery-file'] ||
  !['fetch', 'replay'].includes(command) ||
  (command === 'replay' && (!values.service || !values.output))
)
  throw new Error(USAGE);

// The newest install delivery (for --owner's account when given), or the one named by --delivery.
async function installDelivery() {
  const { appJwt, githubAppConfiguration } = await load('../pipeline/github-app.ts');
  const { requestGitHub } = await load('../pipeline/github.ts');
  const app = githubAppConfiguration(process.env);
  const jwt = await appJwt(app);
  let cursor = '';
  // What the App's delivery log holds, for the error when no delivery fits: events only, no payload.
  const seen = new Map();
  let oldest = null;
  let newest = null;
  for (let page = 0; page < DELIVERY_PAGES; page += 1) {
    const response = await fetch(
      `https://api.github.com/app/hook/deliveries?per_page=100${cursor ? `&cursor=${cursor}` : ''}`,
      { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } },
    );
    if (!response.ok)
      throw new Error(`Listing App deliveries failed with HTTP ${response.status}.`);
    for (const item of await response.json()) {
      const kind = `${item.event}.${item.action ?? '-'}`;
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
      if (!oldest || item.delivered_at < oldest) oldest = item.delivered_at;
      if (!newest || item.delivered_at > newest) newest = item.delivered_at;
      if (
        values.delivery
          ? String(item.id) !== values.delivery
          : INSTALL_EVENTS.get(item.event) !== item.action
      )
        continue;
      const detail = await requestGitHub(jwt, 'GET', `/app/hook/deliveries/${item.id}`);
      const payload = detail.request?.payload;
      const login = payload?.installation?.account?.login;
      if (!login || (values.owner && login.toLowerCase() !== values.owner.toLowerCase())) continue;
      return {
        id: item.id,
        guid: item.guid,
        event: item.event,
        action: item.action,
        deliveredAt: item.delivered_at,
        payload,
      };
    }
    cursor = /[?&]cursor=([^&>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    if (!cursor) break;
  }
  // Read only: whether the App has a webhook URL at all (the URL itself is not printed) and how
  // many installations it has. Nothing in the App's settings is changed.
  const hook = await requestGitHub(jwt, 'GET', '/app/hook/config').catch(() => null);
  const installations = await requestGitHub(jwt, 'GET', '/app/installations?per_page=100').catch(
    () => null,
  );
  console.error(
    `App webhook URL ${hook?.url ? 'set' : 'not set'}; ${Array.isArray(installations) ? installations.length : 'unknown'} installations.`,
  );
  throw new Error(
    `No installation delivery${values.owner ? ` for ${values.owner}` : ''} in the App's recent deliveries. ` +
      `The log holds ${[...seen.values()].reduce((a, b) => a + b, 0)} deliveries` +
      (oldest
        ? ` from ${oldest} to ${newest}: ${[...seen].map(([k, n]) => `${k} ${n}`).join(', ')}.`
        : '.'),
  );
}

const repositoriesOf = (payload) => payload.repositories ?? payload.repositories_added ?? [];

if (command === 'fetch') {
  const delivery = await installDelivery();
  const account = delivery.payload.installation.account.login;
  const named = repositoriesOf(delivery.payload);
  await writeFile(values['delivery-file'], JSON.stringify(delivery), { mode: 0o600 });
  console.log(
    `Found ${delivery.event}.${delivery.action} delivery ${delivery.id} (${delivery.deliveredAt}) for ${account}: ${named.length} repositories, ${named.filter((repository) => !repository.private).length} public.`,
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `account=${account}\n`);
  process.exit(0);
}

const secret = process.env.REFIT_WEBHOOK_SECRET;
const token = process.env.REFIT_SERVICE_TOKEN;
if (!secret || !token || !process.env.REFIT_DATABASE_URL)
  throw new Error('REFIT_WEBHOOK_SECRET, REFIT_SERVICE_TOKEN and REFIT_DATABASE_URL are required.');
const { openHostedPool } = await load('../pipeline/hosted-database.ts');
const { openInventoryStore } = await load('../pipeline/inventory-store.ts');

async function service(path, init) {
  const response = await fetch(`${values.service}${path}`, init);
  const body = await response.json();
  if (!response.ok)
    throw new Error(`${path} answered HTTP ${response.status}: ${body.error ?? ''}`);
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

const delivery = JSON.parse(await readFile(values['delivery-file'], 'utf8'));
const owner = delivery.payload.installation.account.login;
const named = repositoriesOf(delivery.payload);
const visibility = new Map(
  named.map((repository) => [repository.full_name.toLowerCase(), !repository.private]),
);
console.log(
  `Replaying ${delivery.event}.${delivery.action} delivery ${delivery.id} (${delivery.deliveredAt}) for ${owner}: ${named.length} repositories, ${[...visibility.values()].filter(Boolean).length} public.`,
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
// Only the status: the receipt lists enrolled repositories, which may be private.
console.log(`Worker accepted the delivery: ${accepted.status}`);

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
const pool = openHostedPool(process.env.REFIT_DATABASE_URL, (error) =>
  console.error(error.message),
);
const inventories = openInventoryStore(pool);
// Without each target's repository list, which names private repositories too.
const targets = new Map(
  final.watch.targets.map(({ repositories: _users, ...target }) => [target.provider, target]),
);
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
  delivery: {
    id: delivery.id,
    event: delivery.event,
    action: delivery.action,
    deliveredAt: delivery.deliveredAt,
  },
  owner,
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
    .map(
      (item) =>
        `${item.kind === 'specification' ? 'OpenAPI' : 'docs'} ${'hash' in item ? item.hash.slice(0, 12) : `failed: ${item.error}`}`,
    )
    .join('; ');
const lines = [
  `## Install-time vendor inventory`,
  '',
  `Replayed \`${delivery.event}.${delivery.action}\` delivery ${delivery.id} (delivered ${delivery.deliveredAt}) for \`${owner}\` into \`refit hosted serve\` with PostgreSQL ${process.env.POSTGRES_VERSION ?? ''}.`,
  withheld ? `${withheld} private repositories were inventoried but are not named here.` : '',
  '',
];
for (const entry of repositories) {
  lines.push(
    `### ${entry.repository}`,
    '',
    `Inventory: ${entry.inventory.status ?? 'none'}${entry.inventory.stop ? ` (${entry.inventory.stop})` : ''}${entry.inventory.error ? ` error: ${entry.inventory.error}` : ''}`,
    '',
  );
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
lines.push(
  '### Watch targets',
  '',
  '| Vendor | OpenAPI | Changelog pages | Captured | Error |',
  '| --- | --- | --- | --- | --- |',
);
for (const target of final.watch.targets)
  lines.push(
    `| ${target.provider} | ${target.sources.specification ?? '-'} | ${target.sources.documentation.map((page) => page.url).join('<br>') || '-'} | ${capture(target)} | ${target.error ?? ''} |`,
  );
const markdown = `${lines.join('\n')}\n`;
if (values.summary) await appendFile(values.summary, markdown);
console.log(markdown);
