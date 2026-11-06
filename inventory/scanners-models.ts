// Scanner for AI model names and the lines that choose a model indirectly. Like the other scanners
// it returns leads: provider names only annotate, and a model nobody listed here is the agent's to find.
import { lineMatch, readLines, sourceAndConfigFiles } from './scanners.ts';
import type { LineMatch } from './repo-files.ts';

const DEFAULT_MAX_RESULTS = 200;
// shortcut: Dockerfiles (no extension) are not in sourceAndConfigFiles, so their ENV/ARG lines are not scanned, upgrade when the agent misses a model set there.

// A model token starts at a word edge and runs through name characters, so `gpt_helper` and
// `claude-code` never match.
function modelToken(head: string): RegExp {
  return new RegExp(String.raw`(?<![\w-])(?:${head})[\w.:-]*`, 'gi');
}

// Bedrock first: its ids contain the plain Claude and Llama names, and the first match on a span wins.
const MODEL_FAMILIES: { provider: string; pattern: RegExp }[] = [
  {
    provider: 'AWS Bedrock',
    pattern: modelToken(
      String.raw`(?:[a-z]{2}\.)?anthropic\.claude-|amazon\.(?:titan|nova)-|meta\.llama|cohere\.command|mistral\.(?:mistral|mixtral)-|ai21\.`,
    ),
  },
  {
    provider: 'OpenAI',
    pattern: modelToken(
      String.raw`gpt-(?=\w)|text-davinci-|davinci-002|babbage-002|text-embedding-(?=\w)|text-moderation-|omni-moderation-|whisper-1|dall-e-|tts-1|chatgpt-`,
    ),
  },
  // Reasoning models are too short to match unquoted: `o1` appears inside many identifiers.
  { provider: 'OpenAI', pattern: /(?<=["'`])o[134](?:-[\w.:-]+)?(?=["'`])/gi },
  {
    provider: 'Anthropic',
    pattern: modelToken(String.raw`claude-(?=\d|opus|sonnet|haiku|instant|v\d)`),
  },
  {
    provider: 'Google',
    pattern: modelToken(
      String.raw`gemini-(?=\w)|text-bison|chat-bison|textembedding-gecko|embedding-001`,
    ),
  },
  {
    provider: 'Mistral',
    pattern: modelToken(
      String.raw`(?:open-)?(?:mistral|mixtral|codestral|pixtral|ministral)-(?=\w)`,
    ),
  },
  { provider: 'Meta', pattern: modelToken(String.raw`llama-?\d`) },
  {
    provider: 'Cohere',
    pattern: modelToken(
      String.raw`command-(?:r|a|light|nightly|xlarge|medium)\b|embed-(?:english|multilingual)-`,
    ),
  },
  { provider: 'DeepSeek', pattern: modelToken(String.raw`deepseek-(?=\w)`) },
  { provider: 'xAI', pattern: modelToken(String.raw`grok-(?=\w)`) },
];

const TRAILING_PUNCTUATION = /[.:-]+$/;
const MODEL_WORDS = String.raw`(?:MODEL|DEPLOYMENT|ENGINE)`;

// Generous on purpose: a `model` key with a non-literal value, an env read naming a model, or a
// `NAME=` / `NAME:` key (.env templates, compose, workflows, Dockerfile ENV and ARG).
const MODEL_SETTING = new RegExp(
  [
    String.raw`\w*model\w*["']?\s*[:=]\s*[^\s"'\`=]`,
    String.raw`\b(?:process\.env|import\.meta\.env|os\.environ|environ|getenv|Getenv|LookupEnv|ENV)\b[^\n]{0,60}?\b[A-Z0-9_]*${MODEL_WORDS}`,
    String.raw`^\s*(?:-\s*)?(?:export\s+|ENV\s+|ARG\s+)?[A-Z][A-Z0-9_]*${MODEL_WORDS}[A-Z0-9_]*\s*[:=]`,
  ].join('|'),
  'i',
);

type FoundModel = { model: string; provider: string };

function modelsIn(line: string): FoundModel[] {
  const taken: [number, number][] = [];
  const found = new Map<string, FoundModel>();
  for (const { provider, pattern } of MODEL_FAMILIES) {
    for (const match of line.matchAll(pattern)) {
      const span: [number, number] = [match.index, match.index + match[0].length];
      if (taken.some(([from, to]) => span[0] < to && span[1] > from)) continue;
      taken.push(span);
      const model = match[0].replace(TRAILING_PUNCTUATION, '');
      found.set(model.toLowerCase(), { model, provider });
    }
  }
  return [...found.values()];
}

export async function findAiModels(
  repoDir: string,
  options: { maxResults?: number } = {},
): Promise<{
  models: { model: string; provider?: string; occurrences: LineMatch[] }[];
  settings: LineMatch[];
  truncated: boolean;
}> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const groups = new Map<string, { model: string; provider: string; occurrences: LineMatch[] }>();
  const settings: LineMatch[] = [];
  let modelCount = 0;
  let truncated = false;
  for (const file of await sourceAndConfigFiles(repoDir)) {
    const lines = await readLines(repoDir, file);
    if (!lines) continue;
    for (const [index, line] of lines.entries()) {
      for (const { model, provider } of modelsIn(line)) {
        if (modelCount >= maxResults) {
          truncated = true;
          continue;
        }
        const group = groups.get(model.toLowerCase()) ?? { model, provider, occurrences: [] };
        groups.set(model.toLowerCase(), group);
        group.occurrences.push(lineMatch(file, index, line));
        modelCount += 1;
      }
      if (!MODEL_SETTING.test(line)) continue;
      if (settings.length >= maxResults) truncated = true;
      else settings.push(lineMatch(file, index, line));
    }
  }
  const models = [...groups.values()].sort(
    (a, b) => b.occurrences.length - a.occurrences.length || a.model.localeCompare(b.model),
  );
  return { models, settings, truncated };
}
