import type { AgentTool } from '../../shared/types.ts';

// Tools are helpers the agent may call to check itself. They return information and never block:
// a thrown error is turned into an informational string, never a refusal.

export type ToolRun = (
  input: Record<string, unknown>,
  context: { repoDir: string },
) => Promise<string>;

export function defineTool(spec: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: ToolRun;
}): AgentTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: async (input, context) => {
      try {
        return await spec.run(asObject(input), context ?? { repoDir: '' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `${spec.name} could not complete (${message}). This is information, not a blocker: carry on with your own judgement and the provider docs.`;
      }
    },
  };
}

export function asObject(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON: treat a bare string as the main query.
    }
    return { query: input };
  }
  return {};
}

export function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

export function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function bool(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function obj(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = input[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}
