// Lists every absolute URL host written in a repository's non-test JS/TS source, with up to three
// lines of context each, so a person can label which hosts the code really calls through an HTTP
// client. It uses a plain text search, not the detector, so labels made from it are blind to
// detectApiHosts. Nothing from the repository is run.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TESTS =
  /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|examples?|stories)\/|\.(?:test|spec|e2e|stories|story)\.[cm]?[jt]sx?$|\.d\.ts$/i;
const URL_HOST =
  /https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}|localhost|\d+\.\d+\.\d+\.\d+)/g;

const { values } = parseArgs({ options: { repository: { type: 'string' } } });
if (!values.repository) {
  console.log('Usage: node scripts/api-hosts-label-candidates.mjs --repository <directory>');
  process.exit(1);
}

const hosts = new Map();
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) await visit(path);
    } else if (SOURCE.test(entry.name)) {
      const name = relative(values.repository, path);
      if (TESTS.test(name)) continue;
      const lines = (await readFile(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(URL_HOST)) {
          const host = match[1].toLowerCase();
          const seen = hosts.get(host) ?? [];
          if (seen.length < 3) seen.push(`${name}:${index + 1}: ${line.trim().slice(0, 150)}`);
          hosts.set(host, seen);
        }
      });
    }
  }
}
await visit(values.repository);
for (const [host, seen] of [...hosts].sort((a, b) => a[0].localeCompare(b[0])))
  console.log(`## ${host}\n${seen.join('\n')}`);
