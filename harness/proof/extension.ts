// Browsers: an extension's manifest.json is valid Manifest V3. Chrome stopped running Manifest V2
// extensions in 2024–2025 (https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline).
// Reads files only.
import type { ProofCheck } from './types.ts';
import { lineOf, optString, proofDetail, readRoot, readText, walkFiles } from './util.ts';

export type ManifestReport = { file: string; problems: string[]; notes: string[] };

const HOST_PATTERN = /^(\*|https?|wss?|ftp|file|<all_urls>)(:\/\/|$)|^<all_urls>$/;

// Source: https://developer.chrome.com/docs/extensions/reference/manifest and the MV3 migration checklist.
export function validateManifestV3(
  file: string,
  manifest: Record<string, unknown>,
): ManifestReport {
  const problems: string[] = [];
  const notes: string[] = [];
  if (manifest.manifest_version !== 3)
    problems.push(`manifest_version is ${JSON.stringify(manifest.manifest_version)}, not 3`);
  for (const key of ['name', 'version'])
    if (typeof manifest[key] !== 'string' || !(manifest[key] as string).trim())
      problems.push(`"${key}" is required`);
  if (typeof manifest.version === 'string' && !/^\d+(\.\d+){0,3}$/.test(manifest.version))
    problems.push(`version "${manifest.version}" must be one to four dot-separated integers`);
  for (const key of ['browser_action', 'page_action'])
    if (key in manifest) problems.push(`"${key}" is MV2; use "action"`);
  const background = manifest.background as Record<string, unknown> | undefined;
  if (background && typeof background === 'object') {
    if ('page' in background)
      problems.push('background.page is MV2; use background.service_worker');
    if ('persistent' in background)
      problems.push('background.persistent is MV2; service workers are not persistent');
    if ('scripts' in background && !('service_worker' in background))
      problems.push(
        'background.scripts without background.service_worker does not load in Chrome MV3 (Firefox accepts it)',
      );
    else if ('scripts' in background)
      notes.push('background.scripts is kept for Firefox; Chrome uses service_worker');
  }
  const permissions = Array.isArray(manifest.permissions)
    ? (manifest.permissions as unknown[])
    : [];
  const hosts = permissions.filter(
    (p): p is string => typeof p === 'string' && HOST_PATTERN.test(p),
  );
  if (hosts.length)
    problems.push(
      `host patterns in "permissions" (${hosts.join(', ')}) belong in "host_permissions"`,
    );
  if (permissions.includes('webRequestBlocking'))
    problems.push(
      '"webRequestBlocking" is only for policy-installed extensions in MV3; use declarativeNetRequest',
    );
  if ('content_security_policy' in manifest && typeof manifest.content_security_policy !== 'object')
    problems.push('content_security_policy must be an object ({ "extension_pages": ... }) in MV3');
  const csp = manifest.content_security_policy as Record<string, unknown> | undefined;
  if (csp && typeof csp === 'object') {
    const pages = String(csp.extension_pages ?? '');
    if (/unsafe-eval|https?:\/\//.test(pages))
      problems.push(
        'content_security_policy.extension_pages may not allow unsafe-eval or remote script sources',
      );
  }
  const war = manifest.web_accessible_resources;
  if (Array.isArray(war) && war.some((entry) => typeof entry === 'string'))
    problems.push(
      'web_accessible_resources must be a list of { resources, matches } objects in MV3',
    );
  return { file, problems, notes };
}

// MV2-only APIs in extension code. Hits are pointers for the agent, not verdicts.
const MV2_APIS: { re: RegExp; use: string }[] = [
  { re: /\bchrome\.tabs\.executeScript\b/g, use: 'chrome.scripting.executeScript' },
  { re: /\bchrome\.tabs\.insertCSS\b/g, use: 'chrome.scripting.insertCSS' },
  { re: /\bchrome\.browserAction\b/g, use: 'chrome.action' },
  { re: /\bchrome\.pageAction\b/g, use: 'chrome.action' },
  {
    re: /\bchrome\.extension\.getBackgroundPage\b/g,
    use: 'messaging or chrome.runtime.getContexts',
  },
  { re: /\bchrome\.extension\.(sendRequest|onRequest)\b/g, use: 'chrome.runtime messaging' },
];

export const browserExtensionCheck: ProofCheck = {
  name: 'browser-extension',
  description:
    "Check that a browser extension's manifest.json is valid Manifest V3 and that its scripts call no MV2-only chrome.* APIs. Returns evidence, never blocks.",
  inputSchema: {
    type: 'object',
    properties: {
      manifest: {
        type: 'string',
        description: 'Path to manifest.json. Default: every manifest.json with a manifest_version',
      },
    },
  },
  run: async (input, ctx) => {
    const root = readRoot(ctx);
    const files = await walkFiles(root);
    const given = optString(input, 'manifest');
    const candidates = given ? [given] : files.filter((f) => /(^|\/)manifest\.json$/.test(f));
    const passedItems: string[] = [];
    const failedItems: string[] = [];
    const notes: string[] = [];
    const extensionDirs: string[] = [];
    for (const file of candidates) {
      const text = await readText(root, file);
      if (text === undefined) {
        if (given) failedItems.push(`${file} not found`);
        continue;
      }
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(text) as Record<string, unknown>;
      } catch (error) {
        failedItems.push(
          `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!given && !('manifest_version' in manifest)) continue; // a web app manifest, not an extension
      extensionDirs.push(file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '');
      const report = validateManifestV3(file, manifest);
      if (report.problems.length) failedItems.push(...report.problems.map((p) => `${file}: ${p}`));
      else passedItems.push(`${file} is valid Manifest V3`);
      notes.push(...report.notes.map((n) => `${file}: ${n}`));
    }
    for (const file of files.filter(
      (f) => /\.(m?js|ts|tsx|jsx)$/.test(f) && extensionDirs.some((d) => f.startsWith(d)),
    )) {
      const text = await readText(root, file);
      if (!text) continue;
      for (const { re, use } of MV2_APIS)
        for (const match of text.matchAll(re))
          failedItems.push(
            `${file}:${lineOf(text, match.index ?? 0)} calls ${match[0]}; use ${use}`,
          );
    }
    if (extensionDirs.length === 0 && !given)
      notes.push('no extension manifest (manifest.json with manifest_version) found');
    return proofDetail('browser-extension', {
      passedItems,
      failedItems,
      notes,
      ...(extensionDirs.length === 0 && failedItems.length === 0
        ? { passed: 'unknown' as const }
        : {}),
    });
  },
};
