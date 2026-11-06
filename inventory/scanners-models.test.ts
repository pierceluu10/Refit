import { afterAll, describe, expect, it } from 'vitest';
import { DEMO_NODE_API, DEMO_PYTHON_APP, MONOREPO } from './sample-repos.ts';
import type { RepoFiles } from './sample-repos.ts';
import { findAiModels } from './scanners-models.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const repos: string[] = [];
async function scan(files: RepoFiles, maxResults?: number) {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return findAiModels(repoDir, { maxResults });
}
afterAll(() => Promise.all(repos.map(removeRepo)));

const modelNames = (found: Awaited<ReturnType<typeof scan>>) => found.models.map((m) => m.model);
const lineOf = (found: Awaited<ReturnType<typeof scan>>, model: string) =>
  found.models.find((m) => m.model === model)?.occurrences.map((o) => `${o.file}:${o.line}`);

describe('findAiModels on sample repos', () => {
  it('finds the model and the indirect setting in the Node API', async () => {
    const found = await scan(DEMO_NODE_API);
    expect(lineOf(found, 'text-davinci-003')).toEqual(['src/summarize.js:1']);
    expect(found.models[0].provider).toBe('OpenAI');
    expect(found.settings.map((s) => `${s.file}:${s.line}`)).toContain('src/summarize.js:6');
  });

  it('finds models across a monorepo and follows CHAT_MODEL', async () => {
    const found = await scan(MONOREPO);
    expect(lineOf(found, 'gpt-4o')).toEqual(['apps/web/src/ai.ts:4']);
    expect(lineOf(found, 'claude-3-opus-20240229')).toEqual(['services/worker/worker.py:8']);
    expect(found.models.find((m) => m.model === 'claude-3-opus-20240229')?.provider).toBe(
      'Anthropic',
    );
    expect(found.settings.some((s) => s.text.includes('CHAT_MODEL'))).toBe(true);
    expect(found.truncated).toBe(false);
  });

  it('reports no models in the Python app', async () => {
    const found = await scan(DEMO_PYTHON_APP);
    expect(found.models).toEqual([]);
  });
});

describe('findAiModels token rules', () => {
  it('matches only whole tokens and never reads real env files', async () => {
    const found = await scan({
      'package.json':
        '{ "name": "claude-code", "dependencies": { "@anthropic-ai/claude-agent-sdk": "1" } }',
      'helper.py': 'gpt_helper = 1\nsolo1 = 2\nname = "o1x"\ngpt = 3\nvar o1 = 4\n',
      '.env': 'OPENAI_MODEL=gpt-4\n',
      '.env.example': 'OPENAI_MODEL=\n',
    });
    expect(modelNames(found)).toEqual([]);
    expect(found.settings.map((s) => s.file)).toEqual(['.env.example']);
  });

  it('matches reasoning models only inside quotes', async () => {
    const found = await scan({ 'a.ts': 'const a = "o1-mini"; const b = \'o3\'; const o4 = 1;\n' });
    expect(modelNames(found).sort()).toEqual(['o1-mini', 'o3']);
  });

  it('recognises each provider family and Bedrock ids without double counting', async () => {
    const found = await scan({
      'models.ts': [
        'const ids = ["us.anthropic.claude-3-5-sonnet-20240620-v1:0", "amazon.titan-embed-text-v2:0"];',
        'const more = ["gemini-1.5-pro", "mistral-large-latest", "llama-3.1-70b", "command-r-plus"];',
        'const rest = ["deepseek-chat", "grok-2", "text-embedding-3-small", "whisper-1", "dall-e-3"];',
        'const old = "text-bison@001"; // trailing punctuation: gpt-4o.',
      ].join('\n'),
    });
    expect(modelNames(found).sort()).toEqual(
      [
        'amazon.titan-embed-text-v2:0',
        'command-r-plus',
        'dall-e-3',
        'deepseek-chat',
        'gemini-1.5-pro',
        'gpt-4o',
        'grok-2',
        'llama-3.1-70b',
        'mistral-large-latest',
        'text-bison',
        'text-embedding-3-small',
        'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
        'whisper-1',
      ].sort(),
    );
    expect(found.models.find((m) => m.model.startsWith('us.anthropic'))?.provider).toBe(
      'AWS Bedrock',
    );
  });

  it('groups repeats and lists a line once', async () => {
    const found = await scan({
      'a.ts': 'x("gpt-4o", "gpt-4o")\n',
      'b.ts': 'y("gpt-4o")\n',
    });
    expect(found.models).toHaveLength(1);
    expect(lineOf(found, 'gpt-4o')).toEqual(['a.ts:1', 'b.ts:1']);
  });
});

describe('findAiModels settings', () => {
  it('flags indirect model choices and ignores literal ones', async () => {
    const found = await scan({
      'cfg.ts': [
        'const c = { model: config.model };',
        'const d = { model: "gpt-4o" };',
        'const e = process.env.AZURE_DEPLOYMENT_NAME;',
        'const f = os.environ.get("MODEL", fallback)',
        'const g = 1;',
      ].join('\n'),
      'ci.yml': 'env:\n  OPENAI_ENGINE: davinci\n',
      Dockerfile: 'ENV MODEL_NAME=x\n',
    });
    expect(found.settings.map((s) => `${s.file}:${s.line}`).sort()).toEqual([
      'cfg.ts:1',
      'cfg.ts:3',
      'cfg.ts:4',
      'ci.yml:2',
    ]);
  });
});

describe('findAiModels limits', () => {
  it('truncates at maxResults and says so', async () => {
    const found = await scan({ 'a.ts': 'a("gpt-4o")\nb("gpt-4")\nc("gpt-3.5-turbo")\n' }, 2);
    expect(found.models.flatMap((m) => m.occurrences)).toHaveLength(2);
    expect(found.truncated).toBe(true);
  });
});
