// The inventory agent's whole tool surface: read-only file access confined to repoDir, the fast
// scanners, and the record tools. There is no shell, no write tool and no network tool.
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { UsageCollector } from './collector.ts';
import { grepLines, listFiles, readText } from './repo-files.ts';
import {
  findEnvNames,
  findGraphqlDocuments,
  findHttpCalls,
  findImports,
  findWebhookSignals,
  listManifests,
  lockedVersions,
  repoMap,
} from './scanners.ts';

export const SERVER_NAME = 'inventory';

export type InventoryTool = {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (input: Record<string, unknown>) => Promise<string>;
};

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 1500;
const DEFAULT_GREP_RESULTS = 100;
const MAX_LISTED_FILES = 500;

const callSiteSchema = z.object({
  file: z.string().describe('Repo-relative path'),
  line: z.number().int().describe('1-based line of the call (or of the handler for webhooks)'),
  operation: z
    .string()
    .describe('What is called, e.g. "charges.create", "POST /v1/messages", "query GetOrders"'),
  fields: z.array(z.string()).optional().describe('Fields or params sent, where visible'),
  notes: z
    .string()
    .optional()
    .describe('What the code does with the response, wrappers involved, uncertainty'),
});

const usageShape = {
  provider: z
    .string()
    .describe(
      'Lowercase vendor id such as "stripe", or the API host such as "api.weather.example.org" when the vendor is unknown',
    ),
  via: z.enum(['sdk', 'http', 'graphql', 'webhook']),
  purpose: z.string().optional().describe('What the repo uses this API for, in a few words'),
  sdk: z
    .object({
      name: z.string(),
      version: z.string().describe('Resolved version from the lockfile, else the manifest range'),
      lockfile: z.string().optional(),
    })
    .optional(),
  pinnedVersion: z
    .object({ value: z.string(), file: z.string(), line: z.number().int() })
    .optional()
    .describe('The API version the code pins (apiVersion option, /v1/ path, version header)'),
  callSites: z.array(callSiteSchema),
};

function json(value: unknown): string {
  return JSON.stringify(value, null, 1);
}

export function readTools(repoDir: string): InventoryTool[] {
  return [
    {
      name: 'repo_map',
      description:
        'Map the repository: directory tree with file counts, file types and manifest paths. Start here.',
      shape: { depth: z.number().int().min(1).max(5).optional() },
      run: async (input) => repoMap(repoDir, input.depth as number | undefined),
    },
    {
      name: 'list_files',
      description:
        'List repo files under a directory, optionally filtered by a glob such as "**/*.ts". Skips node_modules, build output and .git.',
      shape: { directory: z.string().optional(), glob: z.string().optional() },
      run: async (input) => {
        const glob = input.glob as string | undefined;
        const files = (await listFiles(repoDir, (input.directory as string) ?? '.')).filter(
          (file) => !glob || path.matchesGlob(file, glob),
        );
        const shown = files.slice(0, MAX_LISTED_FILES).join('\n');
        return files.length > MAX_LISTED_FILES
          ? `${shown}\n… ${files.length - MAX_LISTED_FILES} more; narrow the directory or glob`
          : shown || 'No files matched.';
      },
    },
    {
      name: 'read_file',
      description: `Read a repo file with line numbers. Reads ${DEFAULT_READ_LINES} lines from offset by default.`,
      shape: {
        path: z.string(),
        offset: z.number().int().min(1).optional().describe('1-based first line'),
        limit: z.number().int().min(1).max(MAX_READ_LINES).optional(),
      },
      run: async (input) => {
        const file = input.path as string;
        const text = await readText(repoDir, file);
        if (text === undefined) return `${file} is binary or larger than the read limit.`;
        const lines = text.split('\n');
        const start = (input.offset as number | undefined) ?? 1;
        const end = Math.min(
          lines.length,
          start - 1 + ((input.limit as number) ?? DEFAULT_READ_LINES),
        );
        const body = lines
          .slice(start - 1, end)
          .map((line, index) => `${start + index}\t${line}`)
          .join('\n');
        const rest = end < lines.length ? `\n… lines ${end + 1}-${lines.length} not shown` : '';
        return `${file} (${lines.length} lines)\n${body}${rest}`;
      },
    },
    {
      name: 'grep',
      description:
        'Search repo text files for a JavaScript regular expression, line by line. Returns file:line matches.',
      shape: {
        pattern: z.string(),
        glob: z.string().optional().describe('Limit to files matching this glob'),
        directory: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(500).optional(),
      },
      run: async (input) => {
        const glob = input.glob as string | undefined;
        const files = (await listFiles(repoDir, (input.directory as string) ?? '.')).filter(
          (file) => !glob || path.matchesGlob(file, glob),
        );
        const pattern = new RegExp(input.pattern as string, input.ignoreCase ? 'i' : '');
        const { matches, truncated } = await grepLines(repoDir, pattern, {
          files,
          maxResults: (input.maxResults as number) ?? DEFAULT_GREP_RESULTS,
        });
        const body = matches
          .map((match) => `${match.file}:${match.line}: ${match.text}`)
          .join('\n');
        return (body || 'No matches.') + (truncated ? '\n… more matches; narrow the search' : '');
      },
    },
    {
      name: 'list_manifests',
      description:
        'List every dependency manifest and lockfile with each dependency, its version range and line. Known SDKs carry a hint; all dependencies are returned.',
      shape: {},
      run: async () => json(await listManifests(repoDir)),
    },
    {
      name: 'locked_versions',
      description: 'Look up the resolved version of a package in every lockfile, with the line.',
      shape: { package: z.string() },
      run: async (input) => json(await lockedVersions(repoDir, input.package as string)),
    },
    {
      name: 'find_imports',
      description:
        'Group external imports (JS/TS, Python, Go, Ruby, PHP, JVM, C#) by package with counts and examples. Pass module to get every import of one package.',
      shape: { module: z.string().optional(), maxResults: z.number().int().optional() },
      run: async (input) =>
        json(
          await findImports(repoDir, {
            module: input.module as string | undefined,
            maxResults: input.maxResults as number | undefined,
          }),
        ),
    },
    {
      name: 'find_http_calls',
      description:
        'Find URL hosts in source and config, HTTP client calls (fetch, axios, requests, net/http…) and base URLs built from env or config.',
      shape: { maxResults: z.number().int().optional() },
      run: async (input) =>
        json(await findHttpCalls(repoDir, { maxResults: input.maxResults as number | undefined })),
    },
    {
      name: 'find_graphql_documents',
      description: 'Find GraphQL documents: .graphql files, gql tagged templates, query strings.',
      shape: { maxResults: z.number().int().optional() },
      run: async (input) =>
        json(
          await findGraphqlDocuments(repoDir, {
            maxResults: input.maxResults as number | undefined,
          }),
        ),
    },
    {
      name: 'find_webhook_signals',
      description:
        'Find webhook receivers: signature verification, HMAC checks, webhook routes and event-type handlers.',
      shape: { maxResults: z.number().int().optional() },
      run: async (input) =>
        json(
          await findWebhookSignals(repoDir, { maxResults: input.maxResults as number | undefined }),
        ),
    },
    {
      name: 'find_env_names',
      description:
        'List environment variable names the code reads (and keys in .env examples), with locations. Never returns values.',
      shape: {},
      run: async () => json(await findEnvNames(repoDir)),
    },
  ];
}

export function recordTools(collector: UsageCollector): InventoryTool[] {
  return [
    {
      name: 'record_usage',
      description:
        'Record one external API usage and its call sites. Call it as soon as you have confirmed call sites; call again to add more sites to the same provider/via/sdk. Each location is checked against the file and the line text is returned so you can confirm it.',
      shape: usageShape,
      run: async (input) =>
        json(await collector.record(input as Parameters<UsageCollector['record']>[0])),
    },
    {
      name: 'list_recorded_usages',
      description: 'List everything recorded so far, by key, to review, merge or fill gaps.',
      shape: {},
      run: async () => json(collector.list()),
    },
    {
      name: 'remove_usage',
      description:
        'Remove a recorded usage by key, or only some of its call sites (for duplicates or mistakes).',
      shape: {
        key: z.string(),
        sites: z.array(z.object({ file: z.string(), line: z.number().int() })).optional(),
      },
      run: async (input) =>
        json({
          removed: collector.remove(
            input.key as string,
            input.sites as { file: string; line: number }[] | undefined,
          ),
        }),
    },
  ];
}

export function mcpToolName(name: string): string {
  return `mcp__${SERVER_NAME}__${name}`;
}

// Tool errors go back to the model as text so it can correct itself; they never end the run.
export async function runTool(
  inventoryTool: InventoryTool,
  input: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: await inventoryTool.run(input), isError: false };
  } catch (error) {
    return { text: `${(error as Error).name}: ${(error as Error).message}`, isError: true };
  }
}

export function buildServer(tools: InventoryTool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SERVER_NAME,
    tools: tools.map((inventoryTool) =>
      tool(inventoryTool.name, inventoryTool.description, inventoryTool.shape, async (input) => {
        const { text, isError } = await runTool(inventoryTool, input as Record<string, unknown>);
        return { content: [{ type: 'text', text }], isError };
      }),
    ),
  });
}
