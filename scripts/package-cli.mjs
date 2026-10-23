import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);
const PACK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const { values } = parseArgs({
  options: { output: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help) console.log('Usage: npm run package:cli -- --output <new-directory>');
else {
  const output = resolve(values.output ?? join(root, 'dist-cli'));
  const stage = await mkdtemp(join(tmpdir(), 'refit-package-'));
  try {
    await mkdir(output, { mode: 0o700 });
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const dependencies = {};
    for (const name of [
      'diff',
      'fast-xml-parser',
      'graphql',
      'parse5',
      'pg',
      'tsx',
      'typescript-compiler',
      'web-tree-sitter',
      'yaml',
    ]) {
      const installed = JSON.parse(
        await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
      );
      dependencies[name] =
        installed.name === name ? installed.version : `npm:${installed.name}@${installed.version}`;
    }
    await writeFile(
      join(stage, 'package.json'),
      `${JSON.stringify({ name: metadata.name, version: metadata.version, description: 'Local API migration agent with reviewable patches and isolated validation', license: metadata.license, private: true, type: 'module', engines: metadata.engines, bin: { refit: 'bin/refit.mjs' }, files: ['bin/', 'pipeline/', 'data/', 'README.md', 'LICENSE', 'docs/', 'examples/', 'public/', '.env.example', 'npm-shrinkwrap.json'], dependencies }, null, 2)}\n`,
    );
    await mkdir(join(stage, 'bin'));
    await copyFile(join(root, 'bin/refit.mjs'), join(stage, 'bin/refit.mjs'));
    await chmod(join(stage, 'bin/refit.mjs'), 0o755);
    await mkdir(join(stage, 'pipeline'));
    for (const name of await readdir(join(root, 'pipeline'))) {
      if ((name.endsWith('.ts') || name.endsWith('.json')) && !name.endsWith('.test.ts'))
        await copyFile(join(root, 'pipeline', name), join(stage, 'pipeline', name));
    }
    // Language tracers and their grammars live in their own directories.
    for (const language of ['python', 'go'])
      await cp(join(root, 'pipeline', language), join(stage, 'pipeline', language), {
        recursive: true,
        filter: (source) => !source.endsWith('.test.ts'),
      });
    await cp(join(root, 'pipeline/fixtures'), join(stage, 'pipeline/fixtures'), {
      recursive: true,
    });
    await cp(join(root, 'examples'), join(stage, 'examples'), { recursive: true });
    await cp(join(root, 'data'), join(stage, 'data'), { recursive: true });
    await copyFile(join(root, 'README.md'), join(stage, 'README.md'));
    await copyFile(join(root, 'LICENSE'), join(stage, 'LICENSE'));
    await copyFile(join(root, '.env.example'), join(stage, '.env.example'));
    // Guides ship; benchmark data and AI evaluation records stay in the repository. They are not read
    // at runtime and include third-party code excerpts.
    const unpackaged = ['benchmarks', 'ai-evals'].map((name) => join(root, 'docs', name));
    await cp(join(root, 'docs'), join(stage, 'docs'), {
      recursive: true,
      filter: (source) => !unpackaged.includes(source),
    });
    await mkdir(join(stage, 'public'));
    await copyFile(
      join(root, 'public/refit-agent-avatar.png'),
      join(stage, 'public/refit-agent-avatar.png'),
    );
    // npm recommends a shrinkwrap for globally installed command-line tools: installs then get the
    // transitive versions this repository locked and tested, not whatever was published since.
    await copyFile(join(root, 'package-lock.json'), join(stage, 'npm-shrinkwrap.json'));
    await execute(
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: stage, timeout: PACK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
    const result = await execute(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', output],
      { cwd: stage, timeout: PACK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
    const [packed] = JSON.parse(result.stdout);
    console.log(
      JSON.stringify(
        {
          archive: join(output, packed.filename),
          version: metadata.version,
          integrity: packed.integrity,
          dependencies,
          files: packed.files.map((file) => file.path),
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
