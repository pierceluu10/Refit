import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  addable,
  addAgents,
  builtInPackage,
  detectProviders,
  scaffoldChecks,
  v1IntegrationId,
} from './agent-catalog.ts';
import { parseObject } from './specifications.ts';
import { REPOSITORY_CONFIGURATION } from './workflow-configuration.ts';
import { terminalText } from './workflow-presentation.ts';
import { cliErrorMessage } from './cli-errors.ts';

const USAGE =
  'Usage: refit agents [--repository <root>] [--add <agent-id> ...] [--json]\nDetects provider SDKs from package manifests, lockfiles and raw API hostnames, and lists only the agents that match, with any API version the code pins for a provider that versions its API by header, option or path. --add writes an approved agent into .refit.json as a reviewable integration; it does not enroll, activate, download contracts or run code.\nAfter --add: save the contracts it lists, commit, then run refit doctor.';
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

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
          : builtInPackage(integration),
      );
    const configured = (agentPackages: string[]) =>
      agentPackages.some((name) => configuredPackages.has(name));
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
          ...(await scaffoldChecks(root)),
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
        agent: addable(detection)
          ? 'available'
          : detection.agent.adapter
            ? 'report-only'
            : 'none-yet',
        configured:
          configured(detection.agent.packages) ||
          Boolean(result?.added.includes(detection.agent.id)),
        packages: detection.packages,
        hostnames: detection.hostnames,
        ...(detection.apiVersions ? { apiVersions: detection.apiVersions } : {}),
        requests: detection.requests,
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
              `${item.ecosystem ? `${item.ecosystem}:` : ''}${item.name} ${item.version}${item.locked ? ` (locked ${item.locked})` : ''} in ${item.file}${item.line ? `:${item.line}` : ''}`,
          ),
          ...entry.hostnames.map((item) => `${item.hostname} at ${item.file}:${item.line}`),
          ...(entry.apiVersions ?? []).map(
            (item) =>
              `API version ${item.version} (${item.form}${item.use === 'test' ? ', test' : ''}) at ${item.file}:${item.line}`,
          ),
        ];
        const status = entry.configured
          ? 'configured'
          : entry.agent === 'available'
            ? `agent available: refit agents --add ${entry.id}`
            : entry.agent === 'report-only'
              ? 'report only: detected outside npm'
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
  console.error(cliErrorMessage(error, 'agents'));
  process.exitCode = 1;
}
