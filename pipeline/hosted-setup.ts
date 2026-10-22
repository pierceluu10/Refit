import type { IncomingMessage, ServerResponse } from 'node:http';
import { appInstallation, type GitHubAppConfiguration } from './github-app.ts';
import type { HostedTenancy } from './hosted-tenancy.ts';
import { PipelineInputError } from './types.ts';

export const SETUP_ROUTES = {
  setup: '/github/setup',
  uninstalled: '/github/uninstalled',
  security: ['/.well-known/security.txt', '/security.txt'],
};
// The account is named only shortly after GitHub's redirect, so the page cannot be used to find
// out which accounts installed Refit from old installation IDs.
const NAMING_WINDOW_MS = 60 * 60 * 1000;
// Each lookup signs an App JWT and calls GitHub, so unauthenticated visits get a bounded number.
const LOOKUPS_PER_WINDOW = 30;
const LOOKUP_WINDOW_MS = 60 * 1000;
// RFC 9116 asks for an expiry less than a year ahead; the worker states its contact for 180 days.
const SECURITY_EXPIRY_MS = 180 * 24 * 60 * 60 * 1000;
const INSTALLATION_ID = /^[1-9]\d{0,15}$/;
const CONTACT = /^(?:mailto:[^\s"'<>&]+@[^\s"'<>&]+|https:\/\/[^\s"'<>&]+)$/;
const HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  Connection: 'close',
};

export interface HostedSetup {
  app: GitHubAppConfiguration;
  tenancy: HostedTenancy;
  // What this worker does for approved repositories, so the page states its real settings.
  publishDraft: boolean;
  aiPatch: boolean;
  // Where to ask for data deletion and report security issues (REFIT_HOSTED_CONTACT).
  contact?: string;
  onProgress?: (message: string) => void;
}

// A mailto: or https: URI for REFIT_HOSTED_CONTACT, or undefined when it is not set.
export function hostedContact(value: string | undefined) {
  if (value === undefined || value === '') return undefined;
  if (!CONTACT.test(value))
    throw new PipelineInputError('REFIT_HOSTED_CONTACT must be a mailto: or https: URI.');
  return value;
}

const html = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function page(title: string, sections: string[]) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${html(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #1f2328; background: #fff; }
h1 { font-size: 1.5rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } a { color: #4493f8; } }
</style>
</head>
<body>
<h1>${html(title)}</h1>
${sections.join('\n')}
</body>
</html>
`;
}

function deletion(contact: string | undefined) {
  return contact
    ? `To have Refit delete what it stored, write to <a href="${html(contact)}">${html(contact.replace(/^mailto:/, ''))}</a>.`
    : 'To have Refit delete what it stored, ask the operator of this Refit service.';
}

type Installation = Awaited<ReturnType<typeof appInstallation>>;

function uninstallLink(installation: Installation) {
  if (!installation)
    return 'GitHub settings, under Applications (or your organization’s GitHub Apps)';
  const path =
    installation.accountType === 'Organization'
      ? `organizations/${installation.account}/settings/installations/${installation.id}`
      : `settings/installations/${installation.id}`;
  return `<a href="https://github.com/${html(path)}">this installation’s settings on GitHub</a>`;
}

export function setupPage(
  setup: Pick<HostedSetup, 'tenancy' | 'publishDraft' | 'aiPatch' | 'contact'>,
  installation: Installation,
) {
  const allowed = installation
    ? setup.tenancy.accounts.includes(installation.account.toLowerCase())
    : undefined;
  const intro = !installation
    ? '<p>If you just installed Refit Agent, this is what happens next.</p>'
    : allowed
      ? `<p>Refit Agent is installed on <strong>${html(installation.account)}</strong>.</p>`
      : `<p>Refit Agent is installed on <strong>${html(installation.account)}</strong>, but this account is not enabled on this Refit service yet. Refit recorded the installation and the repositories you selected. It does not read, clone or run anything in them until the operator enables the account.</p>`;
  if (allowed === false)
    return page('Refit Agent is installed', [
      intro,
      '<h2>Uninstall</h2>',
      `<p>Uninstall Refit Agent or remove repositories from ${uninstallLink(installation)}. ${deletion(setup.contact)}</p>`,
    ]);
  return page('Refit Agent is installed', [
    intro,
    '<h2>1. Inventory</h2>',
    '<p>For each repository you selected, Refit takes a read-only inventory from a fresh checkout: the provider SDKs and API versions it uses, the AI models it calls and the deadlines that apply. It reads files only. It does not run your code, install dependencies or use AI, and it deletes the checkout afterwards.</p>',
    '<h2>2. Approval</h2>',
    '<p>Refit runs nothing else in a repository until its configuration is approved. The configuration is a committed <code>.refit.json</code> that names the API contracts and the checks to run. The operator of this Refit service reviews it, including the exact files and their hashes, and stores the approval. A later change to those files stops Refit until it is approved again.</p>',
    '<h2>3. After approval</h2>',
    `<p>Refit checks out the repository, finds code affected by API changes and runs the approved checks in an offline container. If the configuration asks for it, dependencies are first installed from the package registry, with install scripts disabled. ${setup.publishDraft ? 'When a migration passes its checks, Refit opens a draft pull request for you to review. It never merges.' : 'This service does not open pull requests; results stay with the operator.'} ${setup.aiPatch ? 'It may ask an AI model to propose a patch, using the operator’s own key and a capped budget.' : 'It does not use AI.'}</p>`,
    '<h2>Uninstall</h2>',
    `<p>Uninstall Refit Agent or remove repositories from ${uninstallLink(installation)}. Refit cancels queued and running work for those repositories at once and deletes their inventories. ${deletion(setup.contact)}</p>`,
  ]);
}

export function uninstalledPage(contact: string | undefined) {
  return page('Refit Agent was uninstalled', [
    '<p>When GitHub tells Refit about the uninstall, Refit cancels queued and running work for your repositories and deletes their inventories. It can no longer read those repositories.</p>',
    `<p>The approved configuration record, job results, validation evidence and the copy of each approved repository that Refit checked out stay with the operator of this Refit service. ${deletion(contact)}</p>`,
    '<p>This page collects nothing about your visit.</p>',
  ]);
}

export function securityText(contact: string, now: Date) {
  return `Contact: ${contact}\nExpires: ${new Date(now.getTime() + SECURITY_EXPIRY_MS).toISOString()}\nPreferred-Languages: en\n`;
}

// A fixed window of lookups; beyond it, visitors get the page without the account named.
function lookupBudget() {
  let start = 0;
  let used = 0;
  return () => {
    const now = Date.now();
    if (now - start >= LOOKUP_WINDOW_MS) {
      start = now;
      used = 0;
    }
    return ++used <= LOOKUPS_PER_WINDOW;
  };
}

// The installation named in the redirect, only when GitHub confirms it belongs to this App and it
// was installed or changed within the naming window. Anything else gets the generic page.
async function confirmedInstallation(setup: HostedSetup, url: URL, allowLookup: () => boolean) {
  const id = url.searchParams.get('installation_id');
  if (!id || !INSTALLATION_ID.test(id) || !allowLookup()) return null;
  try {
    const installation = await appInstallation(setup.app, Number(id));
    const changed = installation
      ? Math.max(Date.parse(installation.createdAt), Date.parse(installation.updatedAt))
      : 0;
    return installation && !installation.suspended && Date.now() - changed <= NAMING_WINDOW_MS
      ? installation
      : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    setup.onProgress?.(`Setup page lookup failed: ${error.name}: ${error.message}`);
    return null;
  }
}

function send(response: ServerResponse, status: number, type: string, body: string) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { ...HEADERS, 'Content-Type': type });
  response.end(body);
}

// Serves the App's Setup URL, the uninstall page and security.txt. Returns false for other routes.
export function hostedPages(setup: HostedSetup) {
  const allowLookup = lookupBudget();
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'GET') return false;
    const url = new URL(request.url ?? '/', 'http://refit.invalid');
    if (url.pathname === SETUP_ROUTES.setup) {
      const installation = await confirmedInstallation(setup, url, allowLookup);
      send(response, 200, 'text/html; charset=utf-8', setupPage(setup, installation));
      return true;
    }
    if (url.pathname === SETUP_ROUTES.uninstalled) {
      send(response, 200, 'text/html; charset=utf-8', uninstalledPage(setup.contact));
      return true;
    }
    if (SETUP_ROUTES.security.includes(url.pathname)) {
      if (setup.contact)
        send(response, 200, 'text/plain; charset=utf-8', securityText(setup.contact, new Date()));
      else send(response, 404, 'text/plain; charset=utf-8', 'No security contact is configured.\n');
      return true;
    }
    return false;
  };
}
