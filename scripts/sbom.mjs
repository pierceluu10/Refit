// Writes a CycloneDX 1.5 SBOM for the packed CLI or the hosted image, using only npm, tar and Docker.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  debianComponents,
  describeArchive,
  imageBom,
  npmGlobalComponents,
} from './sbom-helpers.mjs';

const execute = promisify(execFile);
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const USAGE = `Usage: node scripts/sbom.mjs cli --archive <refit-X.Y.Z.tgz> --output <new-file.json>
       node scripts/sbom.mjs image --image <local-image> --output <new-file.json>
cli reads the tarball's npm-shrinkwrap.json without installing or downloading anything.
image runs the local image (never pulled) with no network and lists what is installed in it.`;
const NPM_SBOM = ['sbom', '--omit=dev', '--sbom-format=cyclonedx', '--sbom-type=application'];
const options = { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    archive: { type: 'string' },
    image: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const [command] = positionals;
if (values.help || !command) console.log(USAGE);
else {
  if (positionals.length !== 1 || !values.output || !['cli', 'image'].includes(command))
    throw new Error(USAGE);
  let bom;
  if (command === 'cli') {
    if (!values.archive) throw new Error(USAGE);
    const archive = resolve(values.archive);
    const stage = await mkdtemp(join(tmpdir(), 'refit-sbom-'));
    try {
      await execute('tar', ['-xzf', archive, '-C', stage], options);
      const directory = join(stage, 'package');
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const { stdout } = await execute('npm', [...NPM_SBOM, '--package-lock-only', '--offline'], {
        ...options,
        cwd: directory,
      });
      bom = describeArchive(JSON.parse(stdout), {
        name: metadata.name,
        version: metadata.version,
        license: metadata.license,
        sha256: createHash('sha256')
          .update(await readFile(archive))
          .digest('hex'),
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } else {
    if (!values.image) throw new Error(USAGE);
    const imageId = (
      await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', values.image], options)
    ).stdout.trim();
    const run = async (script) =>
      (
        await execute(
          'docker',
          [
            'run',
            '--rm',
            '--pull',
            'never',
            '--network',
            'none',
            '--entrypoint',
            'sh',
            imageId,
            '-c',
            script,
          ],
          options,
        )
      ).stdout;
    const distribution = (await run('. /etc/os-release && printf %s "$ID"')).trim();
    const debian = await run("dpkg-query -W -f '${Package}\\t${Version}\\t${Architecture}\\n'");
    const node = (await run('node --version')).trim().replace(/^v/, '');
    const oasdiff = /\d+\.\d+\.\d+/.exec(await run('oasdiff --version'))?.[0];
    if (!oasdiff) throw new Error('The image has no oasdiff version.');
    const globals = JSON.parse(await run('npm ls --global --depth=0 --json'));
    // The installed tree itself, not a lockfile: this is what the image runs.
    const refit = JSON.parse(
      await run(`cd "$(npm root --global)/refit" && npm ${NPM_SBOM.join(' ')}`),
    );
    bom = imageBom({
      image: values.image,
      imageId,
      debian: debianComponents(debian, distribution),
      node,
      oasdiff,
      globals: npmGlobalComponents(globals, ['refit']),
      refit,
      timestamp: new Date().toISOString(),
    });
  }
  const output = resolve(values.output);
  await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, { flag: 'wx' });
  console.log(`${output}: ${bom.components.length} components`);
}
