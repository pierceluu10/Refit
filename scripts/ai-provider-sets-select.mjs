// Freezes Refit's AI-provider benchmark sets for OpenAI, Anthropic and Gemini: one measurement-only
// set and one debugging (dev) set per provider, drawn from the same population and disjoint. The
// population is GitHub code search, one stratum of queries per change type (retired models,
// parameter changes, legacy endpoints, old SDK majors, response parsing, beta headers, embeddings
// and fine-tunes) plus a general stratum of plain SDK use. Candidates are ordered by SHA-256 of a
// fixed seed and their name, so the order depends on nothing Refit or a person saw; each set is
// filled from that order, first with a minimum per change type, then in plain seeded order.
// Usage: node scripts/ai-provider-sets-select.mjs --work <dir> [--provider openai|anthropic|gemini]
//          [--output-dir docs/benchmarks/subsets] [--inputs docs/benchmarks/ai-provider-selection]
//          [--seed refit-ai-providers-2026-10-29] [--names-at <ref>...] [--frozen-at YYYY-MM-DD]
//          [--batch 50] [--pages 5]
// The token is read from GITHUB_TOKEN, or from `gh auth token` when unset, and never printed. Each
// phase caches its result in --work, so an interrupted selection resumes; the committed inputs and
// frozen lists are the record, because GitHub's search index moves.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { validRepoName } from './ai-app-helpers.mjs';
import { seededOrder, slugTokens } from './stripe-holdout-select.mjs';

const execute = promisify(execFile);

export const DEFAULT_SEED = 'refit-ai-providers-2026-10-29';
export const FROZEN_AT = '2026-10-29';
// The Stripe holdout sets' filters.
export const PUSHED_SINCE = '2024-01-01';
export const MAX_DISK_KB = 50 * 1024;
export const MAX_BATCH = 50;
const CLONE_CONCURRENCY = 2;
const METADATA_BATCH = 10;
const CODE_SEARCH_PAUSE_MS = 6500;

export const CHANGE_TYPES = [
  'retired-model',
  'parameter-change',
  'legacy-endpoint',
  'old-sdk-major',
  'response-parsing',
  'beta-header',
  'embeddings-fine-tunes',
];

// Models each provider shut down before the registry's first entry for it, so data/deadlines.json
// does not list them. Each line is a public deprecation page.
export const UNREGISTERED_RETIRED = {
  // platform.openai.com/docs/deprecations: 2024-01-04 (InstructGPT, edits), 2024-06-13
  // (gpt-3.5-turbo-0301/0613/16k-0613, gpt-4-0314 snapshots of 32k), 2024-12-06 (gpt-4-vision-preview),
  // 2025-06-06 (gpt-4-32k).
  openai: [
    'text-davinci-003',
    'text-davinci-002',
    'text-curie-001',
    'text-babbage-001',
    'text-ada-001',
    'code-davinci-002',
    'text-davinci-edit-001',
    'gpt-3.5-turbo-0301',
    'gpt-3.5-turbo-0613',
    'gpt-3.5-turbo-16k',
    'gpt-3.5-turbo-16k-0613',
    'gpt-4-32k',
    'gpt-4-32k-0613',
    'gpt-4-vision-preview',
    'gpt-4-1106-vision-preview',
    'text-search-ada-doc-001',
  ],
  // docs.anthropic.com/en/docs/resources/model-deprecations: claude-2 and claude-instant-1 aliases.
  anthropic: ['claude-2', 'claude-instant-1', 'claude-instant-v1', 'claude-v1', 'claude-v2'],
  // ai.google.dev/gemini-api/docs/changelog: PaLM (2024-08), Gemini 1.0 (2025-04), 1.5 (2025-09).
  gemini: [
    'text-bison-001',
    'chat-bison-001',
    'gemini-pro',
    'gemini-pro-vision',
    'gemini-1.0-pro',
    'gemini-1.0-pro-001',
    'gemini-1.0-pro-vision',
    'gemini-1.5-pro',
    'gemini-1.5-pro-latest',
    'gemini-1.5-pro-001',
    'gemini-1.5-pro-002',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-001',
    'gemini-1.5-flash-002',
    'gemini-1.5-flash-8b',
  ],
};

// The newest SDK major on the freeze date (npm and PyPI `latest`, read 2026-10-29). A repository
// whose locked or declared SDK is on an older major is tagged old-sdk-major; a deprecated package
// (Gemini's @google/generative-ai and google-generativeai) always is.
export const CURRENT_MAJOR = {
  openai: { js: { openai: 7 }, py: { openai: 3 } },
  anthropic: { js: { '@anthropic-ai/sdk': 1 }, py: { anthropic: 2 } },
  gemini: {
    js: { '@google/genai': 2, '@google/generative-ai': Infinity },
    py: { 'google-genai': 2, 'google-generativeai': Infinity },
  },
};

const ts = (query) => `${query} language:TypeScript`;
const js = (query) => `${query} language:JavaScript`;
const py = (query) => `${query} language:Python`;

// Per provider: the SDK packages, how application code imports and constructs a client, the code
// searches per stratum, and the code patterns that tag a checked clone with each change type.
export const PROVIDERS = {
  openai: {
    packages: { js: ['openai'], py: ['openai'] },
    imports: {
      js: /(?:from\s*|require\(\s*|import\(\s*)['"]openai['"]/,
      py: /^\s*(?:import\s+openai\b|from\s+openai(?:\.[\w.]+)?\s+import\b)/m,
    },
    clients: {
      js: /\bnew\s+(?:OpenAI|AzureOpenAI|OpenAIApi)\s*\(/,
      py: /\b(?:Async)?(?:Azure)?OpenAI\s*\(|\bopenai\.(?:ChatCompletion|Completion|Embedding|chat|completions|embeddings|beta|responses|FineTune|fine_tuning)\b/,
    },
    queries: {
      general: [
        ts(`"from 'openai'" "new OpenAI("`),
        js(`"require('openai')"`),
        py('"from openai import OpenAI"'),
      ],
      'retired-model': [
        ts('"gpt-3.5-turbo" "new OpenAI("'),
        ts('"gpt-4-turbo" openai'),
        ts('"text-davinci-003"'),
        py('"gpt-3.5-turbo" "OpenAI("'),
        py('"gpt-4-vision-preview"'),
      ],
      'parameter-change': [
        ts('"max_tokens" "o3-mini"'),
        ts('"function_call" "chat.completions.create"'),
        py('"max_tokens" "o1-mini"'),
        py('"functions=" "ChatCompletion.create"'),
      ],
      'legacy-endpoint': [
        ts('"openai.completions.create"'),
        ts('"beta.assistants.create"'),
        js('"createCompletion" "OpenAIApi"'),
        py('"beta.threads.runs.create"'),
        py('"openai.Completion.create"'),
      ],
      'old-sdk-major': [
        ts('"new OpenAIApi("'),
        js('"new OpenAIApi("'),
        py('"openai.ChatCompletion.create"'),
      ],
      'response-parsing': [
        ts('"data.choices[0].message"'),
        ts('"beta.chat.completions.parse"'),
        py(`"['choices'][0]['message']['content']"`),
        py('"beta.chat.completions.parse"'),
      ],
      'beta-header': [ts('"OpenAI-Beta"'), py('"OpenAI-Beta"')],
      'embeddings-fine-tunes': [
        ts('"text-embedding-ada-002" openai'),
        ts('"fineTuning.jobs.create"'),
        py('"client.embeddings.create"'),
        py('"fine_tuning.jobs.create"'),
      ],
    },
    tags: {
      // Reasoning and GPT-5 models reject max_tokens and non-default sampling; functions and
      // function_call are the deprecated forms of tools and tool_choice.
      'parameter-change': [
        /\bfunction_call\s*[:=]|\bfunctions\s*[:=]\s*\[/,
        /['"`](?:o1|o3|o4|gpt-5)[\w.-]*['"`][\s\S]{0,400}\bmax_tokens\b|\bmax_tokens\b[\s\S]{0,400}['"`](?:o1|o3|o4|gpt-5)[\w.-]*['"`]/,
      ],
      'legacy-endpoint': [
        /(?<!chat\.)\bcompletions\.create\s*\(/,
        /\bcreateCompletion\s*\(|\bcreateEdit\s*\(|\bopenai\.(?:Completion|Edit)\.create\s*\(/,
        /\bbeta\.(?:assistants|threads|vector_stores|vectorStores)\b/,
      ],
      'response-parsing': [
        /\.data\.choices\s*\[|\[['"]choices['"]\]\s*\[\s*0\s*\]|\.choices\s*\[\s*0\s*\]\.text\b/,
        /\bbeta\.chat\.completions\.(?:parse|stream)\b|\bresponse_format\s*[:=]/,
      ],
      'beta-header': [/['"]OpenAI-Beta['"]/i],
      'embeddings-fine-tunes': [
        /\bembeddings\.create\s*\(|\bcreateEmbedding\s*\(|\bopenai\.Embedding\.create\s*\(/,
        /\bfine_?[tT]uning\b|\bFineTune\.create\b|\bcreateFineTune\s*\(/,
      ],
    },
  },
  anthropic: {
    packages: { js: ['@anthropic-ai/sdk'], py: ['anthropic'] },
    imports: {
      js: /(?:from\s*|require\(\s*|import\(\s*)['"]@anthropic-ai\/sdk(?:\/[\w./-]*)?['"]/,
      py: /^\s*(?:import\s+anthropic\b|from\s+anthropic(?:\.[\w.]+)?\s+import\b)/m,
    },
    clients: {
      js: /\bnew\s+(?:Anthropic|AnthropicBedrock|AnthropicVertex|Client)\s*\(/,
      py: /\b(?:Async)?Anthropic(?:Bedrock|Vertex)?\s*\(|\banthropic\.Client\s*\(/,
    },
    queries: {
      general: [
        ts(`"from '@anthropic-ai/sdk'" "new Anthropic("`),
        js(`"require('@anthropic-ai/sdk')"`),
        py('"from anthropic import Anthropic"'),
      ],
      'retired-model': [
        ts('"claude-3-opus-20240229"'),
        ts('"claude-3-5-sonnet-20241022"'),
        ts('"claude-3-haiku-20240307" anthropic'),
        py('"claude-3-sonnet-20240229"'),
        py('"claude-3-5-sonnet-20240620"'),
      ],
      'parameter-change': [
        ts('"max_tokens_to_sample"'),
        ts('"top_k" "messages.create" anthropic'),
        py('"max_tokens_to_sample"'),
        py('"top_p" "messages.create" anthropic'),
      ],
      'legacy-endpoint': [
        ts('"anthropic.completions.create"'),
        ts('"HUMAN_PROMPT"'),
        py('"HUMAN_PROMPT" anthropic'),
        py('"completions.create" "AI_PROMPT"'),
      ],
      'old-sdk-major': [
        py('"anthropic.Client("'),
        py('"client.completion(" anthropic'),
        js(`"@anthropic-ai/sdk" "completions.create"`),
      ],
      'response-parsing': [
        ts('"content[0].text" anthropic'),
        py('"content[0].text" anthropic'),
        ts('".completion" "HUMAN_PROMPT"'),
      ],
      'beta-header': [
        ts('"anthropic-beta"'),
        ts('"beta.messages.create"'),
        py('"anthropic-beta"'),
        py('"betas=" anthropic'),
      ],
      // Anthropic has no embeddings or fine-tuning API, so this stratum stays empty.
      'embeddings-fine-tunes': [],
    },
    tags: {
      // max_tokens_to_sample is the Text Completions name; current models accept only one of
      // temperature and top_p, and some no top_k (data/model-parameters.json).
      'parameter-change': [
        /\bmax_tokens_to_sample\b/,
        /\btop_k\s*[:=]/,
        /\btemperature\s*[:=][^\n]*\n(?:[^\n]*\n){0,6}?[^\n]*\btop_p\s*[:=]|\btop_p\s*[:=][^\n]*\n(?:[^\n]*\n){0,6}?[^\n]*\btemperature\s*[:=]/,
      ],
      'legacy-endpoint': [
        /(?<!\bchat\.)\bcompletions\.create\s*\(/,
        /\bHUMAN_PROMPT\b|\bAI_PROMPT\b|\\n\\nHuman:/,
        /\bclient\.completion\s*\(/,
      ],
      'response-parsing': [
        /\.completion\b(?!s)/,
        /\.content\s*\[\s*0\s*\]\s*\.\s*text\b|\[['"]content['"]\]\s*\[\s*0\s*\]\s*\[['"]text['"]\]/,
      ],
      'beta-header': [
        /['"]anthropic-beta['"]/i,
        /\bbeta\.(?:messages|prompt_caching|promptCaching|tools)\b|\bbetas\s*[:=]/,
      ],
      'embeddings-fine-tunes': [],
    },
  },
  gemini: {
    packages: {
      js: ['@google/genai', '@google/generative-ai'],
      py: ['google-genai', 'google-generativeai'],
    },
    imports: {
      js: /(?:from\s*|require\(\s*|import\(\s*)['"]@google\/(?:genai|generative-ai)['"]/,
      py: /^\s*(?:from\s+google\s+import\s+genai\b|import\s+google\.generativeai\b|from\s+google\.generativeai\b|from\s+google\.genai\b)/m,
    },
    clients: {
      js: /\bnew\s+(?:GoogleGenAI|GoogleGenerativeAI)\s*\(/,
      py: /\bgenai\.Client\s*\(|\bgenai\.configure\s*\(|\bGenerativeModel\s*\(/,
    },
    queries: {
      general: [
        ts(`"from '@google/genai'" "new GoogleGenAI("`),
        js('"@google/genai" "new GoogleGenAI("'),
        py('"from google import genai" "genai.Client("'),
      ],
      'retired-model': [
        ts('"gemini-pro" "GoogleGenerativeAI"'),
        ts('"gemini-1.5-flash"'),
        py('"gemini-1.5-pro"'),
        py('"gemini-pro" generativeai'),
      ],
      'parameter-change': [ts('"thinkingBudget"'), py('"thinking_budget"')],
      'legacy-endpoint': [
        ts('"@google-ai/generativelanguage"'),
        ts('"text-bison-001"'),
        py('"palm.generate_text"'),
        py('"chat-bison-001"'),
      ],
      'old-sdk-major': [
        ts('"new GoogleGenerativeAI("'),
        js('"new GoogleGenerativeAI("'),
        py('"import google.generativeai as genai"'),
      ],
      'response-parsing': [
        ts('"response.text()" "getGenerativeModel"'),
        py('"response.text" "generate_content"'),
      ],
      'beta-header': [
        ts(`"apiVersion: 'v1alpha'" genai`),
        ts('"v1beta" "GoogleGenerativeAI"'),
        py('"v1alpha" "genai.Client"'),
      ],
      'embeddings-fine-tunes': [
        ts('"embedContent"'),
        ts('"text-embedding-004"'),
        py('"embed_content"'),
        py('"embedding-001"'),
      ],
    },
    tags: {
      // Gemini 3 replaces thinkingBudget with thinkingLevel.
      'parameter-change': [/\bthinking_?[bB]udget\b/],
      'legacy-endpoint': [
        /@google-ai\/generativelanguage|\bgenerateText\s*\(|\bgenerate_text\s*\(|\bpalm\.|generativelanguage\.googleapis\.com\/v1beta2/,
      ],
      // The old SDK's `response.text()` method is a property in @google/genai.
      'response-parsing': [
        /\bresponse\.text\s*\(\s*\)|\.response\.text\s*\(/,
        /\.candidates\s*\[\s*0\s*\]\.content\.parts\b/,
      ],
      'beta-header': [
        /['"]v1alpha['"]|apiVersion\s*[:=]\s*['"]v1beta['"]|api_version\s*=\s*['"]v1alpha['"]/,
      ],
      'embeddings-fine-tunes': [
        /\bembed_?[cC]ontent\b|\bbatchEmbedContents\b|\bembedding-001\b|\btext-embedding-004\b/,
        /\btunedModels\b|\btuned_models\b|create_tuned_model/,
      ],
    },
  },
};

// Sets in the order they are filled from each provider's seeded order. `js` and `py` are the
// repositories per language; each change type gets at least `minimum` repositories per language
// where the population has them (the rest of the slots follow plain seeded order).
export const SETS = {
  openai: [
    { name: 'openai-100', purpose: 'measurement', js: 70, py: 30, minimum: { js: 6, py: 3 } },
    { name: 'openai-dev-30', purpose: 'dev', js: 21, py: 9, minimum: { js: 2, py: 1 } },
  ],
  anthropic: [
    { name: 'anthropic-100', purpose: 'measurement', js: 70, py: 30, minimum: { js: 6, py: 3 } },
    { name: 'anthropic-dev-30', purpose: 'dev', js: 21, py: 9, minimum: { js: 2, py: 1 } },
  ],
  gemini: [
    { name: 'gemini-30', purpose: 'measurement', js: 21, py: 9, minimum: { js: 2, py: 1 } },
    { name: 'gemini-dev-15', purpose: 'dev', js: 11, py: 4, minimum: { js: 1, py: 1 } },
  ],
};

const LOCKFILES = { 'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn' };
const PY_MANIFESTS = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'setup.cfg'];
const PY_LOCKS = ['poetry.lock', 'uv.lock', 'Pipfile.lock', 'pdm.lock'];
const SOURCE = { js: /\.(?:[cm]?[jt]s|tsx|jsx)$/, py: /\.py$/ };
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
]);
// Files whose SDK use is not the application's own code.
const NOT_APPLICATION =
  /(?:^|\/)(?:tests?|__tests__|__mocks__|spec|e2e|fixtures?|examples?)\/|(?:\.(?:test|spec|stories)\.[^/]+|(?:^|\/)test_[^/]*\.py|_test\.py)$/;

// Lower-cased owner/name tokens Refit's tracked files mention.
export { slugTokens };

// The JS SDK packages a root package.json declares, with their declared ranges.
export function declaredJs(text, packages) {
  try {
    const manifest = JSON.parse(text);
    const found = {};
    for (const name of packages)
      for (const section of ['dependencies', 'devDependencies'])
        if (typeof manifest?.[section]?.[name] === 'string')
          found[name] ??= manifest[section][name];
    return found;
  } catch {
    return {};
  }
}

// The Python SDK packages root manifests declare (requirements, pyproject, setup.py, Pipfile), with
// the version text after the name, or '' when unversioned. `langchain-openai` and the like are not
// the SDK: the name must not follow a letter, digit, hyphen, underscore or dot.
export function declaredPy(text, packages) {
  const found = {};
  for (const name of packages) {
    const escaped = name.replace(/[.-]/g, (c) => `\\${c}`);
    const match = new RegExp(
      `(?<![\\w.-])${escaped}(?![\\w.-])\\s*(?:\\[[^\\]]*\\])?\\s*(?:=\\s*(?=['"]))?(['"]?)\\s*([<>=~!^]=?\\s*[\\d.*]+[^"'\\n,;]*)?`,
      'i',
    ).exec(text);
    if (match) found[name] = (match[2] ?? '').trim();
  }
  return found;
}

// The major a version range or locked version starts at, or null when it names none.
export function majorOf(spec) {
  const match = /(\d+)(?:\.\d+)*/.exec(spec ?? '');
  return match ? Number(match[1]) : null;
}

export function lockedVersion(text, manager, name) {
  const escaped = name.replace(/[/.@-]/g, (c) => `\\${c}`);
  try {
    const match =
      manager === 'npm'
        ? JSON.parse(text).packages?.[`node_modules/${name}`]?.version
        : manager === 'pnpm'
          ? new RegExp(
              `^ {6}'?${escaped}'?:\\n {8}specifier: [^\\n]+\\n {8}version: (\\d+\\.\\d+\\.\\d+)`,
              'm',
            ).exec(text)?.[1]
          : new RegExp(`^"?${escaped}@[^\\n]*:\\n {2}version:? "?(\\d+\\.\\d+\\.\\d+)`, 'm').exec(
              text,
            )?.[1];
    return typeof match === 'string' ? match : null;
  } catch {
    return null;
  }
}

// Retired models: registry entries for the provider dated before the freeze, plus the ones retired
// before the registry starts.
export function retiredModels(registry, provider, frozenAt = FROZEN_AT) {
  const models = new Set(UNREGISTERED_RETIRED[provider]);
  for (const entry of registry.deadlines)
    if (entry.provider === provider && entry.kind === 'model' && entry.date < frozenAt)
      for (const model of entry.versions ?? []) models.add(model);
  return [...models].sort();
}

export function retiredPattern(models) {
  const escaped = models.map((model) => model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Longest first, so `gpt-4-32k` is not read as `gpt-4`.
  escaped.sort((a, b) => b.length - a.length);
  return new RegExp(`['"\`](?:models\\/)?(${escaped.join('|')})['"\`]`);
}

// The change types a clone's application code shows, from the provider's tag patterns, its
// retired-model literals and its SDK major.
export function changeTypes({ files, provider, retired, sdkVersions, language }) {
  const config = PROVIDERS[provider];
  const tags = new Set();
  for (const file of files) {
    if (retired.test(file.text)) tags.add('retired-model');
    for (const [type, patterns] of Object.entries(config.tags))
      if (patterns.some((pattern) => pattern.test(file.text))) tags.add(type);
  }
  const current = CURRENT_MAJOR[provider][language];
  for (const [name, version] of Object.entries(sdkVersions)) {
    const major = majorOf(version);
    if (current[name] === Infinity || (major !== null && major < current[name]))
      tags.add('old-sdk-major');
  }
  return CHANGE_TYPES.filter((type) => tags.has(type));
}

// Whether application files of a language import the SDK and construct a client.
export function usesSdk(files, provider, language) {
  const { imports, clients } = PROVIDERS[provider];
  return (
    files.some((file) => imports[language].test(file.text)) &&
    files.some((file) => clients[language].test(file.text))
  );
}

export function applicationFiles(files) {
  return files.filter((file) => !NOT_APPLICATION.test(file.path));
}

// Why a metadata record cannot be selected, or null. The holdout sets' filters, with the SDK
// declared in a root manifest for at least one language.
export function metadataIneligibility(record) {
  if (!record) return 'unavailable';
  if (record.isArchived) return 'archived';
  if (record.isFork) return 'fork';
  if (record.diskUsage >= MAX_DISK_KB) return 'over 50 MB';
  if (!record.pushedAt || record.pushedAt.slice(0, 10) < PUSHED_SINCE)
    return `no push since ${PUSHED_SINCE}`;
  if (!record.defaultBranchRef?.target?.oid) return 'no default branch';
  if (!Object.keys(record.declared.js).length && !Object.keys(record.declared.py).length)
    return 'SDK not in a root manifest';
  return null;
}

// The language a checked clone counts for: JS/TS when its application code uses the declared JS
// SDK (Refit edits JS/TS), else Python when its Python code uses the declared Python SDK.
export function languageOf(check) {
  if (check.uses?.js) return 'js';
  if (check.uses?.py) return 'py';
  return null;
}

export function checkIneligibility(check) {
  if (!check || check.error) return 'clone failed';
  if (!languageOf(check)) return 'no SDK client in application code';
  return null;
}

// Fills the sets from checked candidates in seeded order. For each set and language, each change
// type first gets its minimum (walking that type's search stratum in seeded order, keeping only
// clones whose code shows the type), then the remaining slots follow the provider's plain seeded
// order. `next(stratum, language)` checks and returns the next unused kept candidate of a stratum
// ('all' for the plain order) or null when the stratum is spent. A candidate is used once.
export async function fillSets(sets, next) {
  const filled = [];
  for (const set of sets) {
    const repos = [];
    const shortfall = {};
    for (const language of ['js', 'py']) {
      const chosen = [];
      for (const type of CHANGE_TYPES) {
        const have = () => chosen.filter((entry) => entry.changeTypes.includes(type)).length;
        while (have() < set.minimum[language] && chosen.length < set[language]) {
          const entry = await next(type, language, (candidate) =>
            candidate.changeTypes.includes(type),
          );
          if (!entry) break;
          chosen.push({ ...entry, stratum: type });
        }
        if (have() < set.minimum[language])
          shortfall[`${language} ${type}`] = set.minimum[language] - have();
      }
      while (chosen.length < set[language]) {
        const entry = await next('all', language, () => true);
        if (!entry)
          throw new Error(
            `${set.name} needs ${set[language]} ${language} repositories, got ${chosen.length}`,
          );
        chosen.push({ ...entry, stratum: 'seeded order' });
      }
      repos.push(...chosen);
    }
    filled.push({ ...set, repos, shortfall });
  }
  return filled;
}

async function sourceFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path, root)));
    else if (entry.isFile() && (SOURCE.js.test(entry.name) || SOURCE.py.test(entry.name)))
      files.push({
        path: relative(root, path),
        text: await readFile(path, 'utf8').catch(() => ''),
      });
  }
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string' },
      provider: { type: 'string', multiple: true },
      'output-dir': { type: 'string', default: 'docs/benchmarks/subsets' },
      inputs: { type: 'string', default: 'docs/benchmarks/ai-provider-selection' },
      seed: { type: 'string', default: DEFAULT_SEED },
      'names-at': { type: 'string', multiple: true },
      'frozen-at': { type: 'string', default: FROZEN_AT },
      batch: { type: 'string', default: String(MAX_BATCH) },
      pages: { type: 'string', default: '5' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.work) {
    console.log(
      'Usage: node scripts/ai-provider-sets-select.mjs --work <dir> [--provider openai|anthropic|gemini]... [--output-dir docs/benchmarks/subsets] [--inputs docs/benchmarks/ai-provider-selection] [--seed <seed>] [--names-at <ref>]... [--frozen-at YYYY-MM-DD] [--batch 50] [--pages 5]',
    );
    process.exit(values.help ? 0 : 1);
  }
  const batchSize = Number(values.batch);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH)
    throw new Error(`--batch must be 1 to ${MAX_BATCH}`);
  const pages = Number(values.pages);
  const { seed } = values;
  const providers = values.provider ?? Object.keys(PROVIDERS);
  const work = resolve(values.work);
  await mkdir(join(work, 'repos'), { recursive: true });
  const token = process.env.GITHUB_TOKEN || (await execute('gh', ['auth', 'token'])).stdout.trim();
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const registry = JSON.parse(await readFile('data/deadlines.json', 'utf8'));

  async function github(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          ...init.headers,
        },
      });
      if (response.ok) return response.json();
      if ([403, 429, 502, 503].includes(response.status) && attempt < 8) {
        const retry = Number(response.headers.get('retry-after')) || 60 * (attempt + 1);
        console.error(`GitHub ${response.status}; retrying in ${retry}s`);
        await pause(retry * 1000);
        continue;
      }
      // A query GitHub cannot run (422) yields nothing rather than failing the selection.
      if (response.status === 422) return { items: [], invalid: true };
      throw new Error(`GitHub ${path} returned ${response.status}: ${await response.text()}`);
    }
  }

  async function cached(name, compute) {
    const path = join(work, name);
    if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
    const value = await compute();
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }
  const write = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

  // Every owner/name any tracked Refit file mentions at each --names-at ref (default: origin/main
  // and every other origin branch, so unmerged work counts as seen). These outputs are left out.
  const refs =
    values['names-at'] ??
    (await execute('git', ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])).stdout
      .split('\n')
      .filter((ref) => ref && !ref.endsWith('/HEAD'));
  const namesAt = Object.fromEntries(
    await Promise.all(
      refs.map(async (ref) => [ref, (await execute('git', ['rev-parse', ref])).stdout.trim()]),
    ),
  );
  const outputs = [
    ...Object.values(SETS)
      .flat()
      .map(({ name }) => relative(process.cwd(), join(values['output-dir'], `${name}.json`))),
    relative(process.cwd(), values.inputs),
  ];
  const named = await cached('named.json', async () => {
    const tokens = new Set();
    for (const commit of new Set(Object.values(namesAt))) {
      const { stdout } = await execute(
        'git',
        ['grep', '-I', '-h', '-F', '/', commit, '--', '.', ...outputs.map((path) => `:!${path}`)],
        { maxBuffer: 1024 * 1024 * 1024 },
      ).catch((error) => (error.code === 1 ? { stdout: '' } : Promise.reject(error)));
      for (const token of slugTokens(stdout)) tokens.add(token);
    }
    return [...tokens].sort();
  });
  const namedSet = new Set(named);
  const inputs = resolve(values.inputs);
  await mkdir(inputs, { recursive: true });

  for (const provider of providers) {
    const config = PROVIDERS[provider];
    const retired = retiredPattern(retiredModels(registry, provider, values['frozen-at']));

    // 1. Code searches per stratum: up to `pages` x 100 results each, 10 requests a minute.
    const search = await cached(`${provider}-search.json`, async () => {
      const strata = {};
      const counts = {};
      for (const [stratum, queries] of Object.entries(config.queries)) {
        for (const query of queries) {
          counts[query] = 0;
          for (let page = 1; page <= pages; page++) {
            const result = await github(
              `/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
            );
            for (const item of result.items) {
              const repo = item.repository.full_name;
              (strata[repo] ??= new Set()).add(stratum);
              counts[query]++;
            }
            console.error(`${provider} ${query} page ${page}: ${result.items.length}`);
            await pause(CODE_SEARCH_PAUSE_MS);
            if (result.items.length < 100) break;
          }
        }
      }
      return {
        queries: config.queries,
        hits: counts,
        repositories: Object.fromEntries(
          Object.entries(strata)
            .sort()
            .map(([repo, set]) => [repo, [...set].sort()]),
        ),
      };
    });
    const unnamed = Object.keys(search.repositories).filter(
      (repo) => validRepoName(repo) && !namedSet.has(repo.toLowerCase()),
    );

    // 2. Metadata and root manifests, fetched lazily in seeded order, METADATA_BATCH repositories
    // per GraphQL query: filtering then ordering selects the same repositories as ordering then
    // filtering, and only the candidates the sets reach are fetched.
    const order = seededOrder(seed, unnamed);
    const metadataPath = join(work, `${provider}-metadata.json`);
    const metadata = existsSync(metadataPath)
      ? JSON.parse(await readFile(metadataPath, 'utf8'))
      : {};
    const files = ['package.json', ...PY_MANIFESTS, ...Object.keys(LOCKFILES), ...PY_LOCKS];
    async function fetchMetadata(batch) {
      const aliases = batch
        .map((repo, index) => {
          const [owner, name] = repo.split('/');
          return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
            nameWithOwner isArchived isFork diskUsage pushedAt stargazerCount
            defaultBranchRef { target { ... on Commit { oid } } }
            ${files.map((file, at) => `f${at}: object(expression: "HEAD:${file}") { ... on Blob { ${PY_LOCKS.includes(file) || file in LOCKFILES ? 'oid' : 'text'} } }`).join('\n')}
          }`;
        })
        .join('\n');
      const result = await github('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: `query { ${aliases} }` }),
      });
      for (const [index, repo] of batch.entries()) {
        const record = result.data?.[`r${index}`] ?? null;
        if (!record) {
          metadata[repo] = null;
          continue;
        }
        const text = (file) => record[`f${files.indexOf(file)}`]?.text ?? '';
        const present = (file) => Boolean(record[`f${files.indexOf(file)}`]);
        metadata[repo] = {
          nameWithOwner: record.nameWithOwner,
          isArchived: record.isArchived,
          isFork: record.isFork,
          diskUsage: record.diskUsage,
          pushedAt: record.pushedAt,
          stargazerCount: record.stargazerCount,
          defaultBranchRef: record.defaultBranchRef,
          declared: {
            js: declaredJs(text('package.json'), config.packages.js),
            py: PY_MANIFESTS.reduce(
              (found, file) => ({ ...declaredPy(text(file), config.packages.py), ...found }),
              {},
            ),
          },
          locks: { js: Object.keys(LOCKFILES).filter(present), py: PY_LOCKS.filter(present) },
        };
      }
      await write(metadataPath, metadata);
      console.error(`${provider} metadata ${Object.keys(metadata).length}/${order.length}`);
      await pause(1000);
    }
    // Why a candidate cannot be selected before cloning, or null. A repository renamed to a name
    // Refit already mentions is excluded too.
    const metadataReason = (repo) =>
      metadataIneligibility(metadata[repo]) ??
      (namedSet.has(metadata[repo].nameWithOwner.toLowerCase()) ? 'named in Refit' : null);
    const records = { get: (repo) => metadata[repo] };
    const strataOf = { get: (repo) => search.repositories[repo] };

    // 3. Checks: shallow clones at the default-branch HEAD, read only for SDK use, language, SDK
    // version and change types, then deleted. Clones run in batches of at most --batch.
    const checksPath = join(work, `${provider}-checks.json`);
    const checks = existsSync(checksPath) ? JSON.parse(await readFile(checksPath, 'utf8')) : {};
    async function check(repo) {
      const record = records.get(repo);
      const commit = record.defaultBranchRef.target.oid;
      const directory = join(work, 'repos', repo.replace('/', '__'));
      try {
        await execute('git', ['init', '-q', directory]);
        await execute(
          'git',
          ['-C', directory, 'fetch', '-q', '--depth', '1', `https://github.com/${repo}`, commit],
          {
            timeout: 300_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
          },
        );
        await execute('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD']);
        const files = applicationFiles(await sourceFiles(directory));
        const byLanguage = {
          js: files.filter((file) => SOURCE.js.test(file.path)),
          py: files.filter((file) => SOURCE.py.test(file.path)),
        };
        const uses = {
          js: Object.keys(record.declared.js).length > 0 && usesSdk(byLanguage.js, provider, 'js'),
          py: Object.keys(record.declared.py).length > 0 && usesSdk(byLanguage.py, provider, 'py'),
        };
        const language = languageOf({ uses });
        const manager =
          record.locks.js.length === 1
            ? LOCKFILES[record.locks.js[0]]
            : record.locks.js.length
              ? 'several'
              : 'none';
        const sdkVersions = {};
        if (language === 'js') {
          for (const [name, range] of Object.entries(record.declared.js)) {
            const lockfile = Object.entries(LOCKFILES).find(([, value]) => value === manager)?.[0];
            const locked = lockfile
              ? await readFile(join(directory, lockfile), 'utf8')
                  .then((text) => lockedVersion(text, manager, name))
                  .catch(() => null)
              : null;
            sdkVersions[name] = locked ?? range;
          }
        } else if (language === 'py') Object.assign(sdkVersions, record.declared.py);
        checks[repo] = {
          commit,
          stars: record.stargazerCount,
          uses,
          language,
          sdk: sdkVersions,
          packageManager:
            language === 'js'
              ? manager
              : record.locks.py.length
                ? record.locks.py.join(', ')
                : 'none',
          changeTypes: language
            ? changeTypes({ files: byLanguage[language], provider, retired, sdkVersions, language })
            : [],
          strata: strataOf.get(repo),
        };
      } catch (error) {
        checks[repo] = { commit, error: String(error?.code ?? 'clone failed') };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    // Checks the next unchecked candidates of a stratum in seeded order, up to --batch at a time.
    async function checkAhead(candidates) {
      const batch = candidates.filter((repo) => !(repo in checks)).slice(0, batchSize);
      const queue = [...batch];
      await Promise.all(
        Array.from({ length: CLONE_CONCURRENCY }, async () => {
          for (let repo = queue.shift(); repo; repo = queue.shift()) await check(repo);
        }),
      );
      await write(checksPath, checks);
      console.error(`${provider}: checked ${Object.keys(checks).length}/${order.length}`);
    }

    const used = new Set();
    async function next(stratum, language, accept) {
      const candidates = order.filter(
        (repo) => !used.has(repo) && (stratum === 'all' || strataOf.get(repo)?.includes(stratum)),
      );
      for (let index = 0; index < candidates.length; index++) {
        const repo = candidates[index];
        if (!(repo in metadata))
          await fetchMetadata(
            candidates
              .slice(index)
              .filter((other) => !(other in metadata))
              .slice(0, METADATA_BATCH),
          );
        if (metadataReason(repo)) continue;
        if (!(repo in checks))
          await checkAhead(
            candidates.slice(index).filter((other) => other in metadata && !metadataReason(other)),
          );
        const candidate = checks[repo];
        if (checkIneligibility(candidate) || candidate.language !== language || !accept(candidate))
          continue;
        used.add(repo);
        return { ...candidate, repo: metadata[repo].nameWithOwner };
      }
      return null;
    }
    const sets = await fillSets(SETS[provider], next);

    const excluded = { 'named in Refit': Object.keys(search.repositories).length - unnamed.length };
    const fetched = order.filter((repo) => repo in metadata);
    for (const repo of fetched) {
      const reason = metadataReason(repo);
      if (reason) excluded[reason] = (excluded[reason] ?? 0) + 1;
    }
    const eligible = fetched.filter((repo) => !metadataReason(repo));
    const walked = eligible.filter((repo) => repo in checks);
    const dropped = {};
    for (const repo of walked) {
      const reason = checkIneligibility(checks[repo]);
      if (reason) dropped[reason] = (dropped[reason] ?? 0) + 1;
    }
    const assigned = new Map(
      sets.flatMap((set) => set.repos.map((entry) => [entry.repo, set.name])),
    );
    await write(join(inputs, `${provider}-search.json`), search);
    await write(join(inputs, `${provider}-candidates.json`), {
      seed,
      namesAt,
      rank: 'sha256(seed + "\\n" + lowercase(repo)), ascending',
      excluded,
      note: 'Every unnamed search result in seeded order. Metadata was fetched only for the ones a stratum walk reached (metadata.json); the rest were never looked at.',
      order,
    });
    await write(
      join(inputs, `${provider}-metadata.json`),
      Object.fromEntries(
        fetched.map((repo) => [
          repo,
          metadata[repo] && { ...metadata[repo], outcome: metadataReason(repo) ?? 'eligible' },
        ]),
      ),
    );
    await write(
      join(inputs, `${provider}-checks.json`),
      Object.fromEntries(
        walked.map((repo) => [
          repo,
          {
            ...checks[repo],
            outcome:
              checkIneligibility(checks[repo]) ??
              assigned.get(metadata[repo].nameWithOwner) ??
              'kept, not needed',
          },
        ]),
      ),
    );

    const criteria = `GitHub code searches for ${provider} SDK use, one stratum per change type plus a general stratum (${relative(process.cwd(), inputs)}/${provider}-search.json), excluding every owner/name any tracked Refit file mentions at origin/main and every other origin branch (${relative(process.cwd(), inputs)}/${provider}-candidates.json namesAt). Kept, as for the Stripe holdout sets: not archived, not a fork, under 50 MB, pushed since ${PUSHED_SINCE}, and the SDK (${[...config.packages.js, ...config.packages.py].join(', ')}) declared in a root manifest. Ordered by SHA-256 of the seed "${seed}", a newline and the lower-cased name, and walked in that order with shallow clones at the default-branch HEAD, read only for SDK use, language, SDK version and change types, then deleted. Kept: an application file (not a test, example, spec, fixture or mock) imports the SDK and one constructs a client; JS/TS when that holds for JS/TS code, else Python. Each set takes its JS/TS and Python repositories by first giving every change type its minimum (walking that type's search stratum in seeded order and keeping only clones whose application code shows the type) and then following plain seeded order. Measurement sets are filled first, then dev sets, so they are disjoint.`;
    for (const set of sets) {
      const entries = set.repos.map((entry) => ({
        repo: entry.repo,
        stars: entry.stars,
        commit: entry.commit,
        language: entry.language,
        sdk: entry.sdk,
        packageManager: entry.packageManager,
        changeTypes: entry.changeTypes,
        stratum: entry.stratum,
      }));
      const coverage = Object.fromEntries(
        CHANGE_TYPES.map((type) => [
          type,
          entries.filter((entry) => entry.changeTypes.includes(type)).length,
        ]),
      );
      await write(resolve(values['output-dir'], `${set.name}.json`), {
        frozenAt: values['frozen-at'],
        provider,
        purpose:
          set.purpose === 'measurement'
            ? `Measurement-only ${provider} set: no repository was named anywhere in Refit, opened by a person, scanned by Refit or used to tune it before this list was frozen. Run it only at milestones; never open, trace or debug its repositories, rows or diffs to design a fix (docs/benchmarks/AI-PROVIDER-SETS.md). Debug on ${SETS[provider].find((other) => other.purpose === 'dev').name} instead.`
            : `Debugging set for ${provider}: open, trace and tune on it freely. Disjoint from the measurement set ${SETS[provider].find((other) => other.purpose === 'measurement').name}, drawn the same way from the same population.`,
        criteria,
        seed,
        selection: {
          script: 'scripts/ai-provider-sets-select.mjs',
          inputs: relative(process.cwd(), inputs),
          searchRepositories: Object.keys(search.repositories).length,
          excluded,
          unnamed: order.length,
          metadataFetched: fetched.length,
          eligible: eligible.length,
          walked: walked.length,
          dropped,
          languages: { js: set.js, py: set.py },
          minimumPerChangeType: set.minimum,
          shortfall: set.shortfall,
        },
        changeTypeCoverage: coverage,
        retiredModels: retiredModels(registry, provider, values['frozen-at']),
        currentMajors: CURRENT_MAJOR[provider],
        repos: entries,
      });
    }
    console.log(
      JSON.stringify(
        {
          provider,
          search: Object.keys(search.repositories).length,
          metadataFetched: fetched.length,
          eligible: eligible.length,
          walked: walked.length,
          excluded,
          dropped,
          sets: sets.map((set) => [set.name, set.repos.length, set.shortfall]),
        },
        null,
        2,
      ),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
