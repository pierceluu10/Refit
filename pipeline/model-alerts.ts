import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { daysUntil, type DeadlineEntry, type DeadlineRegistry } from './deadline-registry.ts';
import { TEST_PATH } from './source-paths.ts';

// Retiring AI models Refit finds but never edits, each with exactly why (item 7 and config files):
// - `embedding`: an embedding model. Vectors it wrote are stored somewhere the code cannot show,
//   and vectors from another model are not comparable with them, so a swap is a data migration.
// - `fine-tuned`: an OpenAI `ft:` model whose base model retires. It needs a new fine-tuning job
//   on a supported base with the customer's training data; no model ID can replace it.
// - `configuration`: a retiring model set in a `.env*`, JSON, YAML or TOML file. Deployed
//   environments set their own value, so editing the committed file proves nothing.
export type ModelAlertKind = 'embedding' | 'fine-tuned' | 'configuration';

export interface ModelAlert {
  kind: ModelAlertKind;
  deadline: string;
  provider: DeadlineEntry['provider'];
  date: string;
  days: number;
  file: string;
  line: number;
  // The ID as written, such as `ft:gpt-4o-mini-2024-07-18:acme::abc123`.
  model: string;
  // The retiring model the registry lists: the ID itself, or a fine-tuned model's base.
  retiring: string;
  replacement: string | null;
  // For a configuration value: the variable or key that sets it, and where source code reads it.
  key?: string;
  readAt?: string[];
  reason: string;
  // A sentence from the provider's own page, verbatim, where one states the rule.
  quote?: string;
}

const PROVIDERS = new Set(['openai', 'anthropic', 'gemini']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go)$/;
const CONFIG_FILE = /^\.env(?:\..*)?$|\.env$|\.(?:json|ya?ml|toml)$/i;
// Lockfiles and compiler settings name packages, never a model a request sends.
const NOT_CONFIG =
  /^(?:[jt]sconfig[\w.-]*\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|\.eslintrc\.json)$/i;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'vendor',
  '.venv',
  'venv',
]);
const MAX_FILES = 20_000;
const MAX_BYTES = 1024 * 1024;
// Embedding model families on the providers' deprecation pages.
const EMBEDDING = /(?:^|-)embedding(?:-|$)|^text-(?:similarity|search)-|^code-search-/;
// OpenAI fine-tuned model IDs: `ft:<base>:<organization>:<suffix>:<id>`.
const FINE_TUNED = /\bft:([a-z0-9][a-z0-9.-]*):[A-Za-z0-9_-]*(?::[A-Za-z0-9_.-]*){0,2}/g;
// A quoted string in source code, and one configuration line that sets one value.
const QUOTED = /['"`]([a-z0-9][a-z0-9./-]*)['"`]/g;
const ENV_VALUE =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([a-z0-9][a-z0-9./-]*)["']?\s*(?:#.*)?$/;
const KEY_VALUE =
  /^\s*(?:-\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([a-z0-9][a-z0-9./-]*)["']?\s*,?\s*(?:#.*)?$/;
// Quoted or bare IDs of the providers' model families, to tell a catalog file.
const MODEL_LIKE =
  /(?<![A-Za-z0-9.-])((?:models\/|openai\/|anthropic\/|google\/)?(?:gpt-[0-9a-z.-]+|o[1-9](?:-[a-z0-9-]+)?|claude-[0-9a-z.-]+|gemini-[0-9a-z.-]+|text-embedding-[0-9a-z-]+|embedding-[0-9a-z-]+|chatgpt-[0-9a-z.-]+))(?![A-Za-z0-9.-])/g;
// Gemini's `models/` prefix and gateway prefixes such as `openai/` name the same model.
const unprefixed = (model: string) => model.replace(/^(?:models|openai|anthropic|google)\//, '');

// The sentence on OpenAI's page that says when a fine-tuned model stops (saved copy,
// docs/benchmarks/deprecation-pages/openai.md, read 2026-10-29).
export const FINE_TUNED_QUOTE =
  'Inference on fine-tuned models will be disabled only when the underlying base model is deprecated.';
export const FINE_TUNED_SCHEDULE_QUOTE =
  'Fine-tuned versions of these models follow the same shutdown schedule as their underlying base models.';

export const isEmbeddingModel = (model: string) => EMBEDDING.test(model);

function reason(alert: Omit<ModelAlert, 'reason' | 'quote'>): string {
  const to = alert.replacement ? `\`${alert.replacement}\`` : 'no single model the page names';
  if (alert.kind === 'embedding')
    return (
      `\`${alert.model}\` is an embedding model that retires on ${alert.date}; the page recommends ${to}. ` +
      'Vectors from a different embedding model are not comparable with the vectors this one already ' +
      'stored, so swapping the ID would silently break search and similarity over existing data. ' +
      'Moving needs every stored vector re-embedded with the new model and the index rebuilt (often ' +
      'with a new dimension), a data migration Refit cannot run or check from the code. Refit does ' +
      'not change it.'
    );
  if (alert.kind === 'fine-tuned')
    return (
      `\`${alert.model}\` is fine-tuned on \`${alert.retiring}\`, which retires on ${alert.date}, and a ` +
      'fine-tuned model stops with its base model. No model ID replaces it: it needs a new ' +
      `fine-tuning job on a supported base model (the page recommends ${to} for the base) with your ` +
      'training data, then the new `ft:` ID. Refit cannot run that job or judge the result, so it ' +
      'does not change it.'
    );
  const where = alert.readAt?.length
    ? ` Source code reads ${alert.key} at ${alert.readAt.join(', ')}.`
    : '';
  return (
    `\`${alert.model}\` (retires on ${alert.date}; replacement ${to}) is set in configuration` +
    `${alert.key ? ` as ${alert.key}` : ''}, not in code. Refit does not edit configuration, because ` +
    'each deployed environment sets its own value and the committed one may not be the one in use. ' +
    `Change it wherever it is set, including hosting and CI secrets.${where}`
  );
}

async function walk(directory: string) {
  const files: { path: string; content: string }[] = [];
  let truncated = false;
  const visit = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) return void (truncated = true);
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(full);
      } else if (
        entry.isFile() &&
        (SOURCE_FILE.test(entry.name) ||
          (CONFIG_FILE.test(entry.name) && !NOT_CONFIG.test(entry.name)))
      ) {
        // Tests, fixtures and examples are not what a deployment sends, as in the exposure scan.
        if ((await stat(full)).size > MAX_BYTES || TEST_PATH.test(relative(directory, full)))
          continue;
        files.push({ path: relative(directory, full), content: await readFile(full, 'utf8') });
      }
    }
  };
  await visit(directory);
  return { files, truncated };
}

// Lines that read an environment variable or configuration key in source code.
function readers(files: { path: string; content: string }[], key: string) {
  const name = key.split('.').at(-1)!;
  const pattern = new RegExp(
    `(?:process\\.env|import\\.meta\\.env|os\\.environ|os\\.getenv|Getenv)[^\\n]{0,4}["'\\[.(]?${name.replace(/[.]/g, '\\.')}\\b`,
  );
  const found: string[] = [];
  for (const file of files)
    if (SOURCE_FILE.test(file.path))
      file.content.split('\n').forEach((line, index) => {
        if (pattern.test(line)) found.push(`${file.path}:${index + 1}`);
      });
  return found.slice(0, 5);
}

// Every embedding, fine-tuned and configuration use of a registry model in the repository.
export async function modelAlerts(
  directory: string,
  registry: DeadlineRegistry,
  now: Date,
): Promise<{ alerts: ModelAlert[]; truncated: boolean }> {
  const byModel = new Map<string, DeadlineEntry>();
  for (const entry of registry.deadlines)
    if (entry.kind === 'model' && PROVIDERS.has(entry.provider))
      for (const version of entry.versions) byModel.set(version, entry);
  const { files, truncated } = await walk(directory);
  const alerts: ModelAlert[] = [];
  const seen = new Set<string>();
  const add = (alert: Omit<ModelAlert, 'reason' | 'quote'>) => {
    const key = `${alert.kind}\t${alert.file}\t${alert.line}\t${alert.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    alerts.push({
      ...alert,
      reason: reason(alert),
      ...(alert.kind === 'fine-tuned' ? { quote: FINE_TUNED_QUOTE } : {}),
    });
  };
  for (const file of files) {
    // A file that names three or more distinct models is a catalog (a model list, pricing table or
    // provider registry), like the exposure scanner's `catalog` use: its IDs are not what a request
    // sends, so only fine-tuned IDs are read from it.
    const catalog =
      new Set([...file.content.matchAll(MODEL_LIKE)].map((match) => unprefixed(match[1]))).size >=
      3;
    const configuration = !SOURCE_FILE.test(file.path);
    const env = /(?:^|\/)\.env[^/]*$|\.env$/.test(file.path);
    file.content.split('\n').forEach((text, index) => {
      if (text.length > 2000) return;
      const line = index + 1;
      const base = {
        file: file.path,
        line,
      };
      for (const match of text.matchAll(FINE_TUNED)) {
        const entry = byModel.get(match[1]);
        if (!entry) continue;
        add({
          ...base,
          kind: 'fine-tuned',
          deadline: entry.id,
          provider: entry.provider,
          date: entry.date,
          days: daysUntil(entry.date, now),
          model: match[0],
          retiring: match[1],
          replacement: entry.replacement,
        });
      }
      // A whole quoted string in source; a whole value in configuration (`KEY=model`,
      // `"key": "model"`, `key: model`), so model lists, prose and catalogs never count.
      const value = configuration ? (env ? ENV_VALUE : KEY_VALUE).exec(text) : null;
      const candidates = configuration
        ? value
          ? [{ model: unprefixed(value[2]), key: value[1] }]
          : []
        : [...text.matchAll(QUOTED)].map((match) => ({
            model: unprefixed(match[1]),
            key: undefined,
          }));
      for (const { model, key } of catalog ? [] : candidates) {
        const entry = byModel.get(model);
        if (!entry) continue;
        const embedding = isEmbeddingModel(model);
        if (!embedding && !configuration) continue;
        add({
          ...base,
          kind: embedding ? 'embedding' : 'configuration',
          deadline: entry.id,
          provider: entry.provider,
          date: entry.date,
          days: daysUntil(entry.date, now),
          model,
          retiring: model,
          replacement: entry.replacement,
          ...(key && !embedding ? { key, readAt: readers(files, key) } : {}),
        });
      }
    });
  }
  return {
    alerts: alerts.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.model.localeCompare(b.model),
    ),
    truncated,
  };
}
