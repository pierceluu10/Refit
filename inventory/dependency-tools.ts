// What the dependency agent gets on top of the API inventory's tools: scanners that point at version
// declarations, and the tools that record what it decides after reading them.
import { z } from 'zod';
import type { DependencyCollector, DependencyEntry } from './dependency-collector.ts';
import { findDirectDependencies } from './scanners-libraries.ts';
import { findAiModels } from './scanners-models.ts';
import { findCiVersions, findContainerImages, findRuntimeVersions } from './scanners-platform.ts';
import { callSiteSchema, hintsSchema, json } from './tools.ts';
import type { InventoryTool } from './tools.ts';

const KINDS = [
  'api',
  'sdk',
  'library',
  'framework',
  'runtime',
  'ai-model',
  'container-image',
  'ci',
  'platform',
  'infrastructure',
  'security-standard',
  'regulated-surface',
] as const;

const entrySchema = z.object({
  kind: z.enum(KINDS),
  name: z
    .string()
    .describe(
      'e.g. "node", "next", "gpt-4o", "stripe", "node:18-bookworm", "actions/checkout", "ubuntu-22.04"',
    ),
  ecosystem: z
    .string()
    .optional()
    .describe('e.g. "npm", "pypi", "docker", "github-actions", "openai", "anthropic"'),
  version: z
    .string()
    .optional()
    .describe('The resolved version from the lockfile when there is one, else the declared one'),
  package: z
    .string()
    .optional()
    .describe(
      "Repo-relative directory of the monorepo package that declares this version; leave out for the repository's root",
    ),
  declaredIn: z
    .array(
      z.object({
        file: z.string().describe('Repo-relative path'),
        line: z.number().int().optional().describe('1-based line'),
      }),
    )
    .describe('Every place this version is set or implied, each with its line'),
  callSites: z.array(callSiteSchema).optional().describe('For AI models: where the model is used'),
  notes: z
    .string()
    .optional()
    .describe('Why it matters, what is implied rather than stated, and any uncertainty'),
  hints: hintsSchema,
});

export function dependencyScanTools(repoDir: string): InventoryTool[] {
  return [
    {
      name: 'find_runtime_versions',
      description:
        'Find language runtime versions in manifests, version files, and serverless and cloud config. Leads only.',
      shape: {},
      run: async () => json(await findRuntimeVersions(repoDir)),
    },
    {
      name: 'find_container_images',
      description:
        'Find Dockerfile FROM lines and image: keys in compose, Kubernetes, CI and devcontainer files. Leads only.',
      shape: {},
      run: async () => json(await findContainerImages(repoDir)),
    },
    {
      name: 'find_ci_versions',
      description:
        'Find GitHub Actions versions, runner images, setup-action versions and matrix values, and list other CI files to read. Leads only.',
      shape: {},
      run: async () => json(await findCiVersions(repoDir)),
    },
    {
      name: 'find_direct_dependencies',
      description:
        "List each package root's direct dependencies with the declared range, manifest line, and the version resolved in its nearest lockfile. Leads only.",
      shape: {},
      run: async () => json(await findDirectDependencies(repoDir)),
    },
    {
      name: 'find_ai_models',
      description:
        'Find strings shaped like AI model names, and lines that choose a model indirectly. It only knows names it has seen; read the code around any model call.',
      shape: { maxResults: z.number().int().optional() },
      run: async (input) =>
        json(await findAiModels(repoDir, { maxResults: input.maxResults as number | undefined })),
    },
  ];
}

export function dependencyRecordTools(collector: DependencyCollector): InventoryTool[] {
  return [
    {
      name: 'record_dependencies',
      description:
        'Record dependencies in a batch. Each location is checked against the file and its line text returned so you can confirm it; rejected locations are not saved. Recording the same kind, name, ecosystem, version and package again adds to the entry.',
      shape: { dependencies: z.array(entrySchema) },
      run: async (input) => {
        const outcomes = [];
        for (const entry of input.dependencies as DependencyEntry[]) {
          outcomes.push(await collector.record(entry));
        }
        return json(outcomes);
      },
    },
    {
      name: 'list_recorded_dependencies',
      description: 'List every dependency recorded so far, by key, to review or fill gaps.',
      shape: {},
      run: async () => json(collector.list()),
    },
    {
      name: 'remove_dependency',
      description: 'Remove a recorded dependency by key, for duplicates or mistakes.',
      shape: { key: z.string() },
      run: async (input) => json({ removed: collector.remove(input.key as string) }),
    },
  ];
}
