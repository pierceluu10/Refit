import { listModel } from '../deadline-exposure.ts';
import type { DeadlineEntry, DeadlineRegistry } from '../deadline-registry.ts';
import type { ModelReplacementStop, ModelReplacementUnresolved } from '../model-retirements.ts';
import { isTextCall, PYTHON_SDKS, PYTHON_TEST_PATH, traceFiles } from './models.ts';
import { pythonModelMatches } from './model-uses.ts';
import { readPythonFiles } from './syntax.ts';

const PROVIDERS = new Set(PYTHON_SDKS.map((sdk) => sdk.provider));
const IMPORTS: Record<string, RegExp> = {
  openai: /^\s*(?:import\s+openai\b|from\s+openai\b)/m,
  anthropic: /^\s*(?:import\s+anthropic\b|from\s+anthropic\b)/m,
  gemini:
    /^\s*(?:import\s+google\.genai\b|from\s+google\.genai\b|from\s+google\s+import\s+(?:\([^)]*)?\bgenai\b)/m,
};

// The rule's own choices, passed in so this module stays independent of model-retirements.ts: the
// concrete replacement for an entry, and the request parameters that replacement may reject.
export interface ModelRules {
  replacement: (entry: DeadlineEntry, models: Map<string, DeadlineEntry>) => string | null;
  sensitive: (provider: string, to: string) => ReadonlySet<string>;
}

// Python requests that send a retiring model, as stops with the TypeScript rule's reasons, and
// every other live Python match with why no traced request sends it. Python is never edited
// (docs/ARCHITECTURE.md, "Other languages"), so nothing here becomes a replacement.
export async function pythonModelReports(
  directory: string,
  registry: DeadlineRegistry,
  rules: ModelRules,
): Promise<{ stops: ModelReplacementStop[]; unresolved: ModelReplacementUnresolved[] }> {
  const byProvider = new Map<string, Map<string, DeadlineEntry>>();
  for (const entry of registry.deadlines)
    if (entry.kind === 'model' && PROVIDERS.has(entry.provider)) {
      const models = byProvider.get(entry.provider) ?? new Map<string, DeadlineEntry>();
      byProvider.set(entry.provider, models);
      for (const version of entry.versions) models.set(version, entry);
    }
  if (!byProvider.size) return { stops: [], unresolved: [] };
  const files = await readPythonFiles(directory);
  const stops: ModelReplacementStop[] = [];
  const covered = new Set<string>();
  for (const call of await traceFiles(files)) {
    const models = byProvider.get(call.provider);
    if (!models || PYTHON_TEST_PATH.test(call.file)) continue;
    const model = call.arguments.model;
    for (const literal of model.literals) {
      const entry = models.get(literal.value);
      const key = `${literal.file}:${literal.line}`;
      if (!entry || PYTHON_TEST_PATH.test(literal.file) || covered.has(key)) continue;
      covered.add(key);
      const to = rules.replacement(entry, models);
      const name = `${call.resource}.${call.method}`;
      const sensitive = to
        ? call.options.filter((option) => rules.sensitive(call.provider, to).has(option))
        : [];
      const reason = !to
        ? 'The registry names no concrete replacement model ID.'
        : call.resource === 'langchain'
          ? `\`${call.method}\` is a LangChain chat model, which Refit reports but does not edit; change it by hand to ${to}.`
          : call.provider === 'gemini'
            ? `Gemini is report only, so Refit never edits its models; change it by hand to ${to}.`
            : !isTextCall(call)
              ? `\`${name}\` is not a call Refit edits; ${to} may change formats or parameters; change it by hand to ${to}.`
              : call.client.custom === 'a custom base URL' || call.client.custom === 'Azure OpenAI'
                ? `The client sets a custom base URL, so the model may name another provider's model or a deployment; change it by hand to ${to}.`
                : call.client.custom
                  ? `The client is set up for ${call.client.custom}, so the model may name a platform model ID; change it by hand to ${to}.`
                  : model.stop
                    ? `${model.stop} Change it by hand to ${to}.`
                    : literal.via !== 'literal'
                      ? `The model reaches this request through ${literal.via}, which Refit reports but does not edit yet; change it by hand to ${to}.`
                      : call.spread
                        ? 'The request spreads other options, which may set parameters the replacement rejects.'
                        : sensitive.length
                          ? `The request sets ${sensitive.join(', ')}, which ${to} may reject or treat differently.`
                          : `Refit reports Python requests but does not edit Python code yet; change it by hand to ${to}.`;
      stops.push({
        deadline: entry.id,
        provider: entry.provider,
        file: call.file,
        line: call.line,
        call: name,
        at: { file: literal.file, line: literal.line },
        model: literal.value,
        reason,
      });
    }
  }
  const all = new Map(
    [...byProvider].flatMap(([provider, models]) =>
      [...models.keys()].map((model) => [model, provider] as const),
    ),
  );
  const check = 'Check where it is used and change it by hand if it reaches the API.';
  const unresolved: ModelReplacementUnresolved[] = [];
  const matches = await pythonModelMatches(files, all, listModel(all));
  for (const match of matches) {
    if (match.use !== 'live' || covered.has(`${match.file}:${match.line}`)) continue;
    covered.add(`${match.file}:${match.line}`);
    const models = byProvider.get(match.provider)!;
    const entry = models.get(match.version)!;
    const sdk = PYTHON_SDKS.find((item) => item.provider === match.provider)!;
    unresolved.push({
      deadline: entry.id,
      provider: entry.provider,
      file: match.file,
      line: match.line,
      model: match.version,
      to: rules.replacement(entry, models),
      reason: files.some((file) => IMPORTS[match.provider].test(file.content))
        ? `No traced request sends it as its model; ${match.where}. ${check}`
        : `No Python file imports the \`${sdk.package}\` package, so the model may reach the API through another library or a wrapper (${match.where}). ${check}`,
    });
  }
  return { stops, unresolved };
}
