import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addAgents, detectProviders, v1IntegrationId } from './agent-catalog.ts';
import { parseObject } from './specifications.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';
import { terminalText } from './workflow-presentation.ts';

const USAGE =
  'Usage: refit agents [--repository <root>] [--add <agent-id> ...] [--json]\nDetects provider SDKs from package manifests, lockfiles and raw API hostnames, and lists only the agents that match. --add writes an approved agent into .refit.json as a reviewable integration; it does not enroll, activate, download contracts or run code.';
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLACEHOLDER_TEST = /no test specified/;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

try {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      add: { type: 'string', multiple: true },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.log(USAGE);
  else {
    const root = resolve(values.repository ?? '.');
    const detections = await detectProviders(root);
    const configurationPath = join(root, REPOSITORY_CONFIGURATION);
    const configuration = existsSync(configurationPath)
      ? parseObject(await readFile(configurationPath, 'utf8'), REPOSITORY_CONFIGURATION)
      : undefined;
    const v1Adapter =
      configuration?.formatVersion === 1 && typeof configuration.providerConfig === 'string'
        ? parseObject(
            await readFile(resolve(root, configuration.providerConfig), 'utf8'),
            'Provider adapter',
          ).id
        : undefined;
    const v1Id = v1IntegrationId(typeof v1Adapter === 'string' ? v1Adapter : undefined);
    // An agent is configured when any integration's adapter targets one of its packages.
    const integrations = (
      configuration?.formatVersion === 2
        ? configuration.integrations
        : configuration
          ? [configuration]
          : []
    ) as Record<string, unknown>[];
    const configuredPackages = new Set<string>();
    for (const integration of integrations)
      configuredPackages.add(
        typeof integration.providerConfig === 'string'
          ? String(
              parseObject(
                await readFile(resolve(root, integration.providerConfig), 'utf8'),
                'Provider adapter',
              ).packageName,
            )
          : 'stripe',
      );
    const configured = (agentPackages: string[]) =>
      agentPackages.some((name) => configuredPackages.has(name));
    const manifest = existsSync(join(root, 'package.json'))
      ? parseObject(await readFile(join(root, 'package.json'), 'utf8'), 'package.json')
      : {};
    const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
    const result = values.add?.length
      ? addAgents({
          configuration,
          v1Id,
          detections: detections.filter((detection) => !configured(detection.agent.packages)),
          ids: values.add.filter(
            (id) =>
              !detections.some(
                (detection) => detection.agent.id === id && configured(detection.agent.packages),
              ),
          ),
          testScript: typeof scripts.test === 'string' && !PLACEHOLDER_TEST.test(scripts.test),
          lockfile: LOCKFILES.some((name) => existsSync(join(root, name))),
        })
      : undefined;
    if (result?.added.length) {
      for (const file of result.adapterFiles) {
        const target = join(root, file.target);
        await mkdir(dirname(target), { recursive: true });
        if (!existsSync(target)) await copyFile(join(PACKAGE_ROOT, file.source), target);
      }
      await writeFile(configurationPath, `${JSON.stringify(result.configuration, null, 2)}\n`);
    }
    const report = {
      repository: root,
      detected: detections.map((detection) => ({
        id: detection.agent.id,
        name: detection.agent.name,
        agent: detection.agent.adapter ? 'available' : 'none-yet',
        configured:
          configured(detection.agent.packages) ||
          Boolean(result?.added.includes(detection.agent.id)),
        packages: detection.packages,
        hostnames: detection.hostnames,
      })),
      added: result?.added ?? [],
      nextSteps: result?.nextSteps ?? [],
    };
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      const lines = [`Providers detected in ${root}`, ''];
      if (!report.detected.length) lines.push('No catalog provider SDK or API hostname was found.');
      for (const entry of report.detected) {
        const evidence = [
          ...entry.packages.map(
            (item) =>
              `${item.name} ${item.version}${item.locked ? ` (locked ${item.locked})` : ''} in ${item.file}`,
          ),
          ...entry.hostnames.map((item) => `${item.hostname} at ${item.file}:${item.line}`),
        ];
        const status = entry.configured
          ? 'configured'
          : entry.agent === 'available'
            ? `agent available: refit agents --add ${entry.id}`
            : 'no agent yet';
        lines.push(`${entry.name.padEnd(16)}${status}`, ...evidence.map((item) => `  ${item}`));
      }
      if (report.added.length)
        lines.push(
          '',
          `Added to ${REPOSITORY_CONFIGURATION}: ${report.added.join(', ')}`,
          ...report.nextSteps.map((step) => `- ${step}`),
        );
      console.log(lines.map(terminalText).join('\n'));
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error.name}: ${terminalText(error.message)}`);
  process.exitCode = 1;
}
