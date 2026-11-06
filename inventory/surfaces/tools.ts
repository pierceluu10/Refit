// The surfaces agent's whole tool surface: read-only file access confined to repoDir, the lead
// scanner, and the record tools. There is no shell, no write tool and no network tool.
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { grepLines, listFiles, readText } from '../repo-files.ts';
import { SURFACE_KINDS } from './collector.ts';
import type { SurfaceCollector, SurfaceReport } from './collector.ts';
import { findSurfaceLeads, formatLeads, SURFACE_AREAS } from './scanners.ts';
import type { SurfaceArea } from './scanners.ts';

export const SERVER_NAME = 'surfaces';

export type SurfaceTool = {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (input: Record<string, unknown>) => Promise<string>;
};

const DEFAULT_READ_LINES = 400;
const MAX_READ_LINES = 1500;
const DEFAULT_GREP_RESULTS = 100;
const MAX_LISTED_FILES = 500;

const surfaceShape = {
  kind: z
    .enum(SURFACE_KINDS)
    .describe(
      'platform (app stores, mobile OS, browsers, extensions), infrastructure (Kubernetes, serverless, Terraform, cloud services), security-standard (TLS, certificates, OAuth, password or basic-auth logins), regulated-surface (payments, personal data, UI and forms, AI features)',
    ),
  name: z
    .string()
    .describe(
      'What it is, short and stable, e.g. "android-app", "chrome-extension", "kubernetes Ingress", "aws-lambda", "tls-client-config", "oauth-github", "checkout", "cookie-consent", "signup-form", "ai-chatbot"',
    ),
  ecosystem: z
    .string()
    .optional()
    .describe(
      'e.g. "android", "ios", "chrome", "kubernetes", "aws", "gcp", "azure", "stripe", "web"',
    ),
  version: z
    .string()
    .optional()
    .describe(
      'The version that a platform or rule change would be checked against: targetSdk, apiVersion, runtime, manifest_version, TLS minimum. Leave out when nothing is versioned.',
    ),
  locations: z
    .array(
      z.object({
        file: z.string().describe('Repo-relative path'),
        line: z.number().int().describe('1-based line'),
      }),
    )
    .min(1)
    .describe('Every file and line where it is declared, configured or implemented'),
  notes: z
    .string()
    .describe(
      'Why it matters: which platform rules or regulations could force this code to change, what the code does here, and anything you are unsure of',
    ),
};

export function readTools(repoDir: string): SurfaceTool[] {
  return [
    {
      name: 'list_files',
      description:
        'List repo files under a directory, optionally filtered by a glob such as "**/*.yaml". Skips node_modules, build output and .git.',
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
      name: 'find_surface_leads',
      description:
        'Fast pointers to files and lines that often hold a platform, infrastructure, security or regulated surface (mobile and extension manifests, Kubernetes and serverless config, TLS and auth code, checkout, cookies, forms, AI calls). Noisy and incomplete: read before recording. Pass area to limit it.',
      shape: {
        area: z.enum(SURFACE_AREAS).optional(),
        perSignal: z.number().int().min(1).max(200).optional(),
      },
      run: async (input) =>
        formatLeads(
          await findSurfaceLeads(repoDir, {
            area: input.area as SurfaceArea | undefined,
            perSignal: input.perSignal as number | undefined,
          }),
        ),
    },
  ];
}

export function recordTools(collector: SurfaceCollector): SurfaceTool[] {
  return [
    {
      name: 'record_surface',
      description:
        'Record one surface with every file and line it is found in and why it matters. Call again with the same kind, name and ecosystem to add locations. Each location is checked against the file and its text is returned so you can confirm it; rejected lines are not saved.',
      shape: surfaceShape,
      run: async (input) => JSON.stringify(await collector.record(input as SurfaceReport), null, 1),
    },
    {
      name: 'list_recorded_surfaces',
      description: 'List everything recorded so far, by key, to review, merge or fill gaps.',
      shape: {},
      run: async () => JSON.stringify(collector.list(), null, 1),
    },
    {
      name: 'remove_surface',
      description:
        'Remove a recorded surface by key, or only some of its locations (for duplicates or mistakes).',
      shape: {
        key: z.string(),
        locations: z.array(z.object({ file: z.string(), line: z.number().int() })).optional(),
      },
      run: async (input) =>
        JSON.stringify({
          removed: collector.remove(
            input.key as string,
            input.locations as { file: string; line: number }[] | undefined,
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
  surfaceTool: SurfaceTool,
  input: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  try {
    return { text: await surfaceTool.run(input), isError: false };
  } catch (error) {
    return { text: `${(error as Error).name}: ${(error as Error).message}`, isError: true };
  }
}

export function buildServer(tools: SurfaceTool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SERVER_NAME,
    tools: tools.map((surfaceTool) =>
      tool(surfaceTool.name, surfaceTool.description, surfaceTool.shape, async (input) => {
        const { text, isError } = await runTool(surfaceTool, input as Record<string, unknown>);
        return { content: [{ type: 'text', text }], isError };
      }),
    ),
  });
}
