// Lists lines a labeller should read in each checkout of a frozen Python model benchmark, with an
// independent text search that never runs Refit's tracer: in Python files that name the openai,
// anthropic or google-genai SDK, every line that quotes a string and mentions `model`; in every
// Python file, every line that quotes a model-shaped ID. Repository code is never run.
//
//   node scripts/python-models-candidates.mjs --list <repos.json> --root <checkouts> --output <candidates.json> [--repos a/b,c/d]
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const SDK =
  /\b(?:import\s+openai|from\s+openai\b|import\s+anthropic|from\s+anthropic\b|from\s+google\s+import\s+genai|google\.genai)\b/;
const MODEL_SHAPED =
  /(['"])((?:openai\/|anthropic\/|models\/)?(?:gpt-|chatgpt-|o\d(?:-|\1)|text-davinci|claude-|gemini-|dall-e-|tts-|whisper-|text-embedding-)[^'"]*)\1/;
const QUOTED = /(['"])[^'"]*\1/;
const { values } = parseArgs({
  options: {
    list: { type: 'string' },
    root: { type: 'string' },
    output: { type: 'string' },
    repos: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.list || !values.root || !values.output) {
  console.log(
    'Usage: node scripts/python-models-candidates.mjs --list <repos.json> --root <checkouts> --output <candidates.json> [--repos a/b,c/d]',
  );
  process.exit(values.help ? 0 : 1);
}
const only = values.repos ? new Set(values.repos.split(',')) : undefined;
const list = JSON.parse(await readFile(values.list, 'utf8'));
const repos = [];
for (const entry of list.repos) {
  if (only && !only.has(entry.repo)) continue;
  const directory = join(values.root, entry.repo.replace('/', '__'));
  const { stdout } = await execute('git', ['-C', directory, 'ls-files', '*.py'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const candidates = [];
  for (const file of stdout.split('\n').filter(Boolean)) {
    let content;
    try {
      content = await readFile(join(directory, file), 'utf8');
    } catch {
      continue;
    }
    const sdk = SDK.test(content);
    for (const [index, line] of content.split('\n').entries())
      if (MODEL_SHAPED.test(line) || (sdk && /model/i.test(line) && QUOTED.test(line)))
        candidates.push({ file, line: index + 1, text: line.trim().slice(0, 200) });
  }
  repos.push({ repo: entry.repo, commit: entry.commit, candidates });
  console.error(`${entry.repo}: ${candidates.length}`);
}
await writeFile(values.output, `${JSON.stringify({ formatVersion: 1, repos }, null, 2)}\n`);
