import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { DEFAULT_DEADLINE_REGISTRY, loadDeadlineRegistry } from './deadline-registry.ts';
import { scanInventory } from './inventory.ts';
import { buildReport, renderReport } from './report.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE = `Usage: refit report [--repository <root>] [--format markdown|json] [--registry <path>]
Prints one report of what a repository depends on and what is coming: each provider integration with its declared and locked package versions and what Refit can do for it, each registry deadline the live code depends on with its date, days left and evidence lines, AI model calls grouped by model, provider hosts Refit does not track, and the next step. It reads files only: nothing runs, installs or contacts a provider.
--format json prints the same report as versioned JSON (see docs/REPORT.md); markdown, the default, fits a GitHub issue and notes what it truncates.`;

const FORMATS = ['markdown', 'json'];

async function revision(directory: string) {
  try {
    const { stdout } = await promisify(execFile)('git', [
      '-c',
      'core.fsmonitor=false',
      '-C',
      directory,
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ]);
    return stdout.trim();
  } catch {
    // Not a git repository, or one without commits: the report names no commit.
    return null;
  }
}

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      format: { type: 'string' },
      registry: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const format = values.format ?? 'markdown';
    if (!FORMATS.includes(format)) throw new Error('--format must be markdown or json.');
    const directory = resolve(values.repository ?? '.');
    const now = new Date();
    const registry = await loadDeadlineRegistry(
      values.registry ? resolve(values.registry) : DEFAULT_DEADLINE_REGISTRY,
      now,
    );
    const report = buildReport({
      inventory: await scanInventory(directory, registry, now),
      registry,
      repository: basename(directory),
      revision: await revision(directory),
      now,
    });
    console.log(format === 'json' ? JSON.stringify(report, null, 2) : renderReport(report));
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}
