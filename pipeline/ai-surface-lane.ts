import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-compiler';
import type { ProofCall } from './ai-request-proof.ts';
import { findReviewSites, type ReviewFinding } from './ai-review-sites.ts';
import type { AiRuleTable } from './ai-rules.ts';
import type { AiOptions } from './ai-budget.ts';
import type { DeadlineEntry } from './deadline-registry.ts';
import { requestStructuredOutput } from './openai.ts';
import type { Repository, SourceEdit } from './types.ts';

// AI-drafted migrations for API surfaces with no one-to-one mapping (owner decision, main session
// on Furqan's delegation, 2026-10-29): OpenAI legacy Completions and the Assistants API, both shut
// down, move to Responses or Chat Completions. The model rewrites only the calls Refit flagged, in
// the files that hold them, from the provider's own guide; deterministic guards decide whether its
// output is kept at all. The model never picks a model ID: a retired one is replaced only by the
// replacement the deadline registry quotes from the provider, and with none named the site stops.
// AI runs only in refit-bench Actions, with Refit's key and the AI budget.

export const LANE_RULES = new Set(['openai-legacy-completions', 'openai-assistants-removed']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Responses-side calls an AI migration may write, checked against the target release's surface.
const NEW_CALL = /\.(responses|chat\.completions|conversations(?:\.items)?)\.([a-zA-Z]+)\s*\(/g;
const LEGACY_CALL =
  /\.(?:beta\.(?:assistants|threads)\.|completions\.create\s*\(|createCompletion\s*\()/;
const MODEL_LITERAL = /^(?:gpt-|o\d|chatgpt-|text-|davinci|babbage|curie|ada)[a-z0-9.-]*$/;
const GUIDES = [
  // The JavaScript examples and the prose of each guide, cut to fit the input limit.
  {
    file: 'docs/ai-docs/pages/openai-migrate-to-responses.md',
    from: '## Migrating from Chat Completions',
    to: '### 4. Decide when to store state',
  },
  {
    file: 'docs/ai-docs/pages/openai-assistants-migration.md',
    from: "### What's changed?",
    to: '## Comparing full examples',
  },
];
const MAX_GUIDE_BYTES = 14 * 1024;
const MAX_FILE_BYTES = 24 * 1024;
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const INSTRUCTIONS = `You migrate OpenAI API calls that no longer work. OpenAI shut down the Assistants API on 2026-08-26 and every legacy Completions model on 2026-09-28.
Rewrite ONLY the call sites listed in "sites", in the files given, to the Responses API (client.responses.create) or, where the code needs chat messages, Chat Completions (client.chat.completions.create), following the guide excerpts. Use the openai Node SDK 6.x.
Rules:
- Use exactly the model given for each site in "models". Never choose, rename or add any other model ID.
- Keep the function's inputs, outputs and error handling: return what the old code returned, from the new response (for Responses, response.output_text is the text).
- Change nothing outside the statements that contain the listed sites, except imports at the top of the file.
- Do not add dependencies, files, environment variables or configuration.
- Keep the file's style, quotes, indentation and line endings.
- If a site cannot be migrated faithfully (state kept in OpenAI threads, file_search, code_interpreter, assistants created in the dashboard), leave the file unchanged and say why in "unchanged".
Return each changed file whole in "files", the calls you wrote in "calls", and a short reason per site in "notes".`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files', 'calls', 'notes', 'unchanged'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
    },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['call', 'stream', 'tools', 'json'],
        properties: {
          call: { type: 'string' },
          stream: { type: 'boolean' },
          tools: { type: 'boolean' },
          json: { type: 'boolean' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    unchanged: { type: 'array', items: { type: 'string' } },
  },
};

export interface AiSurfaceProposal {
  findings: ReviewFinding[];
  edits: (SourceEdit & { rule: string })[];
  // Lines of each changed file the AI wrote, for the draft (decision 8: AI lines are marked).
  aiLines: { file: string; lines: number[] }[];
  calls: ProofCall[];
  notes: string[];
  // Why the AI output was not kept, or why a site was not sent; empty when every site moved.
  stops: { file: string; line: number; reason: string }[];
  ai: { model: string; responseId: string; costUsd: number | null } | null;
}

type Request = typeof requestStructuredOutput;

function guideExcerpt(text: string, from: string, to: string) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  const section = text.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
  // Other languages' examples go; prose and JavaScript stay.
  const kept = section.replace(/```(?!javascript)[a-z#+-]*\n[\s\S]*?```\n?/g, '');
  return kept.length > MAX_GUIDE_BYTES ? `${kept.slice(0, MAX_GUIDE_BYTES)}\n[cut]` : kept;
}

function parses(path: string, content: string) {
  const kind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : path.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  return (source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0;
}

// The line ranges an AI edit may touch: each top-level statement holding a site, and imports.
function allowedLines(path: string, content: string, lines: number[]) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  for (const statement of source.statements) {
    const [start, end] = [lineOf(statement.getStart()), lineOf(statement.getEnd())];
    if (ts.isImportDeclaration(statement) || lines.some((line) => line >= start && line <= end))
      ranges.push([start, end]);
  }
  return ranges;
}

// The old lines a new file removes or replaces, by a line-level longest common subsequence.
export function changedOldLines(before: string, after: string) {
  const a = before.split('\n');
  const b = after.split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  // One walk: removed old lines, added new lines, and for each insertion the old line it follows.
  const removed: number[] = [];
  const added: number[] = [];
  const anchors: number[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) {
      removed.push(++i);
    } else {
      added.push(++j);
      anchors.push(Math.max(1, i));
    }
  }
  return { removed, added, anchors };
}

function literals(content: string) {
  const found = new Set<string>();
  for (const match of content.matchAll(/["'`]([a-z0-9][a-z0-9.-]*)["'`]/g))
    if (MODEL_LITERAL.test(match[1])) found.add(match[1]);
  return found;
}

export async function proposeAiSurfaceMigration(options: {
  repository: Repository;
  directory: string;
  tables: AiRuleTable[];
  ai: AiOptions;
  // Model deadlines: a retired model at a site is replaced only by the registry's replacement.
  models: { entries: DeadlineEntry[]; now: Date };
  // The target release's client methods (data/sdk-surfaces/openai-6.json).
  surface: Set<string>;
  request?: Request;
}): Promise<AiSurfaceProposal | null> {
  const findings = (
    await findReviewSites(options.directory, options.tables, ['api-surface'])
  ).filter(
    (item) =>
      LANE_RULES.has(item.rule) &&
      item.status === 'review' &&
      !item.test &&
      !item.ambiguous &&
      SOURCE.test(item.file),
  );
  if (!findings.length) return null;
  const stops: AiSurfaceProposal['stops'] = [];
  const files = new Map<string, string>();
  for (const finding of findings) {
    const file = options.repository.files.find((item) => item.path === finding.file);
    if (!file) continue;
    if (file.content.length > MAX_FILE_BYTES) {
      stops.push({
        file: finding.file,
        line: finding.line,
        reason: 'The file is over the AI input limit for one file.',
      });
      continue;
    }
    files.set(file.path, file.content);
  }
  // The models the sites send, each mapped to the model the migration must use.
  const models: Record<string, string> = {};
  for (const [path, content] of files)
    for (const model of literals(content)) {
      const entry = options.models.entries.find(
        (item) =>
          item.provider === 'openai' && item.kind === 'model' && item.versions.includes(model),
      );
      const retired =
        entry && Date.parse(`${entry.date}T00:00:00Z`) <= options.models.now.getTime();
      if (!retired) {
        models[model] = model;
        continue;
      }
      if (entry.replacement && /^[a-z0-9][a-z0-9.-]*$/.test(entry.replacement))
        models[model] = entry.replacement;
      else {
        stops.push({
          file: path,
          line: 1,
          reason: `\`${model}\` was retired on ${entry.date} and the registry names no replacement, so the AI may not choose one.`,
        });
        files.delete(path);
      }
    }
  if (!files.size)
    return { findings, edits: [], aiLines: [], calls: [], notes: [], stops, ai: null };
  const guides = await Promise.all(
    GUIDES.map(async (guide) =>
      guideExcerpt(await readFile(join(ROOT, guide.file), 'utf8'), guide.from, guide.to),
    ),
  );
  const sites = findings
    .filter((item) => files.has(item.file))
    .map((item) => ({ file: item.file, line: item.line, call: item.text, rule: item.rule }));
  const request = options.request ?? requestStructuredOutput;
  const answer = await request(
    {
      name: 'ai_surface_migration',
      instructions: INSTRUCTIONS,
      schema: SCHEMA,
      evidence: {
        sites,
        models,
        files: [...files].map(([path, content]) => ({ path, content })),
        guides,
        sdk: 'openai 6.x',
      },
    },
    options.ai,
  );
  const ai = {
    model: answer.model,
    responseId: answer.responseId,
    costUsd: answer.budget?.costUsd ?? null,
  };
  let parsed: {
    files: { path: string; content: string }[];
    calls: ProofCall[];
    notes: string[];
    unchanged: string[];
  };
  try {
    parsed = JSON.parse(answer.content);
  } catch {
    return {
      findings,
      edits: [],
      aiLines: [],
      calls: [],
      notes: [],
      stops: [
        ...stops,
        {
          file: sites[0].file,
          line: sites[0].line,
          reason: 'The AI answer was not valid JSON; nothing was kept.',
        },
      ],
      ai,
    };
  }
  const reject = (file: string, line: number, reason: string) =>
    stops.push({ file, line, reason: `AI output not kept: ${reason}` });
  const edits: AiSurfaceProposal['edits'] = [];
  const aiLines: AiSurfaceProposal['aiLines'] = [];
  const allowedModels = new Set(Object.values(models));
  for (const changed of parsed.files) {
    const before = files.get(changed.path);
    const fileSites = sites.filter((item) => item.file === changed.path);
    const at = fileSites[0]?.line ?? 1;
    if (before === undefined) {
      reject(changed.path, 1, 'it changed a file with no flagged site.');
      continue;
    }
    if (!parses(changed.path, changed.content)) {
      reject(changed.path, at, 'the rewritten file does not parse.');
      continue;
    }
    if (LEGACY_CALL.test(changed.content)) {
      reject(changed.path, at, 'a legacy Completions or Assistants call is still in the file.');
      continue;
    }
    const unknown = [...changed.content.matchAll(NEW_CALL)]
      .map((match) => `${match[1]}.${match[2]}`)
      .filter((call) => !options.surface.has(call));
    if (unknown.length) {
      reject(changed.path, at, `it calls ${unknown.join(', ')}, which openai 6 does not have.`);
      continue;
    }
    const invented = [...literals(changed.content)].filter((model) => !allowedModels.has(model));
    if (invented.length) {
      reject(
        changed.path,
        at,
        `it names model ${invented.join(', ')}, which is neither the site's model nor its registry replacement.`,
      );
      continue;
    }
    const ranges = allowedLines(
      changed.path,
      before,
      fileSites.map((item) => item.line),
    );
    const diff = changedOldLines(before, changed.content);
    const outside = [...diff.removed, ...diff.anchors].filter(
      (line) => !ranges.some(([start, end]) => line >= start && line <= end + 1),
    );
    if (outside.length) {
      reject(
        changed.path,
        outside[0],
        `it changed line ${outside[0]}, outside the statements holding the flagged calls.`,
      );
      continue;
    }
    edits.push({
      file: changed.path,
      start: 0,
      end: before.length,
      replacement: changed.content,
      changeId: 'ai-surface',
      rule: 'ai-surface-migration',
    });
    aiLines.push({ file: changed.path, lines: diff.added });
  }
  for (const site of sites)
    if (
      !edits.some((item) => item.file === site.file) &&
      !stops.some((item) => item.file === site.file)
    )
      stops.push({
        file: site.file,
        line: site.line,
        reason: `The AI left this site unchanged: ${parsed.unchanged.join(' ') || 'no reason given'}`,
      });
  return {
    findings,
    edits,
    aiLines,
    calls: parsed.calls.filter((call) => options.surface.has(call.call)),
    notes: parsed.notes,
    stops,
    ai,
  };
}
