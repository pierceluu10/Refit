import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { TEST_PATH } from './source-paths.ts';

// Source and configuration files in any language, environment templates included. Markdown and
// other prose are left out: a vendor named in a README is not a vendor the code uses.
const TEXT_FILE =
  /\.(?:[cm]?[jt]sx?|py|go|rb|php|java|kt|kts|cs|rs|swift|ex|exs|ya?ml|toml|json|ini|cfg|conf|properties|tf|sh)$/i;
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$|\.env$|\.env\.(?:example|sample|template)$/i;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;
// Test files of other languages, by the naming each test runner looks for.
const OTHER_TEST = /(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$|_spec\.rb$/;
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'go.sum',
  'Cargo.lock',
  'composer.lock',
  'packages.lock.json',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'target',
  '.refit',
]);
const MINIFIED = /\.min\.[cm]?js$/i;

// The walk stops (and says so) past these, so one huge repository cannot hold an inventory.
export const VENDOR_SCAN_LIMITS = {
  files: 20_000,
  fileBytes: 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
};

export interface VendorReference {
  file: string;
  line: number;
  kind: 'hostname' | 'env';
  name: string;
}

export interface VendorTerms {
  id: string;
  hostnames: string[];
  envVars: string[];
}

// A name standing alone: OPENAI_API_KEY but not AZURE_OPENAI_API_KEY or OPENAI_API_KEY_2.
function nameIn(line: string, name: string) {
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1))
    if (!/\w/.test(line[at - 1] ?? '') && !/\w/.test(line[at + name.length] ?? '')) return true;
  return false;
}

// A hostname in a line, not as the start of a longer name: `.supabase.co` is in
// `https://abc.supabase.co/rest` but not in `api.supabase.com`.
export function hostnameIn(line: string, hostname: string) {
  for (let at = line.indexOf(hostname); at >= 0; at = line.indexOf(hostname, at + 1))
    if (!/[A-Za-z0-9-]/.test(line[at + hostname.length] ?? '')) return true;
  return false;
}

// Reads source and configuration files of every language for vendor environment variable names,
// and files outside JavaScript and TypeScript for vendor hostnames (detectProviders reads those
// already). Test files, lockfiles, installed packages and build output are skipped; nothing runs.
export async function scanVendorReferences(
  directory: string,
  vendors: VendorTerms[],
  limits = VENDOR_SCAN_LIMITS,
  perVendor = 5,
) {
  const root = await realpath(directory);
  const references = new Map<string, VendorReference[]>();
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const scan = (path: string, content: string) => {
    const script = SCRIPT_FILE.test(path);
    for (const vendor of vendors) {
      const terms = [
        ...vendor.envVars.map((name) => ({ kind: 'env' as const, name })),
        ...(script ? [] : vendor.hostnames.map((name) => ({ kind: 'hostname' as const, name }))),
      ].filter((term) => content.includes(term.name));
      if (!terms.length) continue;
      const found = references.get(vendor.id) ?? [];
      for (const [index, line] of content.split('\n').entries())
        for (const term of terms)
          if (
            found.length < perVendor &&
            (term.kind === 'env' ? nameIn(line, term.name) : hostnameIn(line, term.name))
          )
            found.push({ file: path, line: index + 1, ...term });
      if (found.length) references.set(vendor.id, found);
    }
  };
  const visit = async (folder: string): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (truncated) return;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = relative(root, path).split('\\').join('/');
      if (
        !(TEXT_FILE.test(entry.name) || ENV_FILE.test(entry.name)) ||
        LOCKFILES.has(entry.name) ||
        MINIFIED.test(entry.name) ||
        TEST_PATH.test(file) ||
        OTHER_TEST.test(file)
      )
        continue;
      const size = (await lstat(path)).size;
      if (size > limits.fileBytes) continue;
      if ((files += 1) > limits.files || (bytes += size) > limits.totalBytes) {
        truncated = true;
        return;
      }
      scan(file, await readFile(path, 'utf8'));
    }
  };
  await visit(root);
  return { references, files: Math.min(files, limits.files), truncated };
}
