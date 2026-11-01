import { isAbsolute, relative, resolve } from 'node:path';
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DOCS_DOMAINS, type AgentFixInput, type AgentRunner } from './agent-fix.ts';

const TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch'];
// Installs, the type checker and read-only git; anything chained, redirected or substituted is refused.
const BASH_COMMANDS = [
  /^(npm|pnpm|yarn|bun) (install|i|add|ci|ls|list|view|info|why|remove|uninstall)( |$)/,
  /^(npx|pnpm exec|yarn|bunx) (--no-install )?tsc( |$)/,
  /^git (diff|status)( |$)/,
];
const SHELL_SYNTAX = /[;&|`$<>\n\\]|--output|--ext-diff/;
// Credentials the agent process does not need stay out of its environment, and so out of the
// repository's install scripts.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PRIVATE|DATABASE_URL|CREDENTIAL/i;
const AGENT_CREDENTIALS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

// Why a tool call is refused, or null when it may run.
export function toolPolicy(
  repoDir: string,
  provider: AgentFixInput['provider'],
  tool: string,
  input: Record<string, unknown>,
): string | null {
  const inside = (path: unknown) => {
    if (path === undefined) return true;
    if (typeof path !== 'string') return false;
    const offset = relative(repoDir, resolve(repoDir, path));
    return !offset.startsWith('..') && !isAbsolute(offset);
  };
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return inside(input.file_path) && input.file_path !== undefined
        ? null
        : 'Only files inside the repository may be read or edited.';
    case 'Glob':
    case 'Grep':
      return inside(input.path) ? null : 'Only the repository may be searched.';
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      return !SHELL_SYNTAX.test(command) && BASH_COMMANDS.some((pattern) => pattern.test(command))
        ? null
        : 'Bash may only install dependencies, run tsc, or run git diff and git status, one command at a time.';
    }
    case 'WebFetch': {
      let host = '';
      try {
        const url = new URL(String(input.url));
        if (url.protocol === 'https:') host = url.hostname;
      } catch {
        // An unparsable URL is refused below.
      }
      return DOCS_DOMAINS[provider].some((domain) => host === domain || host.endsWith(`.${domain}`))
        ? null
        : `Only ${DOCS_DOMAINS[provider].join(', ')} may be fetched.`;
    }
    default:
      return `${tool} is not available to the agent fixer.`;
  }
}

// Runs Claude Code through the Agent SDK with none of the repository's own configuration: no
// CLAUDE.md, .claude/ settings, hooks, plugins or .mcp.json, since the repository is untrusted.
export const sdkRunner: AgentRunner = ({ repoDir, model, provider, maxBudgetUsd }) => {
  const inbox: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* input() {
    for (;;) {
      while (inbox.length) yield inbox.shift()!;
      if (closed) return;
      await new Promise<void>((done) => (wake = done));
    }
  }
  const policy = (tool: string, toolInput: unknown) =>
    toolPolicy(repoDir, provider, tool, (toolInput ?? {}) as Record<string, unknown>);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => AGENT_CREDENTIALS.has(name) || !SECRET_NAME.test(name),
    ),
  );
  const messages: AsyncIterator<SDKMessage> = query({
    prompt: input(),
    options: {
      cwd: repoDir,
      model,
      maxBudgetUsd,
      env,
      tools: TOOLS,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      canUseTool: async (tool, toolInput) => {
        const reason = policy(tool, toolInput);
        return reason ? { behavior: 'deny', message: reason } : { behavior: 'allow' };
      },
      // Also refuses calls Claude Code would approve on its own, such as reads it deems safe.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hook) => {
                const reason =
                  hook.hook_event_name === 'PreToolUse'
                    ? policy(hook.tool_name, hook.tool_input)
                    : null;
                return reason
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: reason,
                      },
                    }
                  : {};
              },
            ],
          },
        ],
      },
    },
  })[Symbol.asyncIterator]();
  return {
    async send(text) {
      inbox.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      wake?.();
      for (;;) {
        const next = await messages.next();
        if (next.done) throw new Error('the agent session ended before answering');
        const message = next.value;
        if (message.type !== 'result') continue;
        return message.subtype === 'success'
          ? { text: message.result, costUsd: message.total_cost_usd, stopped: false }
          : {
              text: `The agent stopped: ${message.subtype}.`,
              costUsd: message.total_cost_usd,
              stopped: true,
            };
      }
    },
    async close() {
      closed = true;
      wake?.();
      while (!(await messages.next()).done);
    },
  };
};
