import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { callMatches, findReviewSites } from './ai-review-sites.ts';
import { loadAiRuleTables } from './ai-rules.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function review(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-review-'));
  roots.push(root);
  for (const [name, content] of Object.entries({ 'package.json': '{"name":"app"}', ...files })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return findReviewSites(root, await loadAiRuleTables());
}

it('matches call chains by their end or a namespace', () => {
  expect(callMatches('openai.beta.threads.runs.create', 'beta.threads.*')).toBe(true);
  expect(callMatches('client.completions.create', 'completions.create')).toBe(true);
  expect(callMatches('client.chat.completions.create', 'completions.create')).toBe(true);
  expect(callMatches('client.beta', 'beta.threads.*')).toBe(false);
});

it('lists removed OpenAI surfaces and the Realtime beta, never as edits', async () => {
  const findings = await review({
    'src/a.ts': `import OpenAI from 'openai';
const client = new OpenAI();
export const run = (thread: string) => client.beta.threads.runs.create(thread, { assistant_id: 'asst' });
export const legacy = () => client.completions.create({ model: 'gpt-3.5-turbo-instruct', prompt: 'x' });
export const ws = { headers: { 'OpenAI-Beta': 'realtime=v1' } };
`,
  });
  expect(findings.map((item) => [item.rule, item.line, item.breaking])).toEqual([
    ['openai-assistants-removed', 3, true],
    ['openai-legacy-completions', 4, true],
    ['openai-realtime-beta-removed', 5, true],
  ]);
  expect(findings[0].source.url).toBe(
    'https://developers.openai.com/api/docs/assistants/migration',
  );
});

it('lists Anthropic Text Completions, a retired beta and a graduated one', async () => {
  const findings = await review({
    'a.js': `const Anthropic = require('@anthropic-ai/sdk');
const { HUMAN_PROMPT, AI_PROMPT } = Anthropic;
const client = new Anthropic();
module.exports = {
  old: () => client.completions.create({ model: 'claude-2.1', prompt: HUMAN_PROMPT + ' hi' + AI_PROMPT, max_tokens_to_sample: 10 }),
  big: () => client.beta.messages.create({ betas: ['context-1m-2025-08-07', 'files-api-2025-04-14'], model: 'm', max_tokens: 1, messages: [] }),
};
`,
  });
  expect(findings.map((item) => `${item.rule}:${item.line}:${item.breaking}`)).toEqual([
    'anthropic-text-completions:2:true',
    'anthropic-text-completions:5:true',
    'anthropic-beta-graduated-files-api:6:false',
    'anthropic-context-1m-retired:6:true',
  ]);
});

it('reports Python, PaLM and the Gemini SDK swap as report only', async () => {
  const findings = await review({
    'app.py': `import openai
openai.api_key = "x"
x = openai.Embedding.create(model="text-embedding-3-small", input="a")
# openai.Completion.create(model="x")
r = openai.ChatCompletion.create(model="gpt-4o", messages=[])
`,
    'llm.py': `headers = {"anthropic-beta": "files-api-2025-04-14", "x": 1}\n# "realtime=v1"\n`,
    'palm.js': `const { TextServiceClient } = require('@google-ai/generativelanguage');\nmodule.exports = { model: 'models/text-bison-001' };\n`,
    'gem.ts': `import { GoogleGenerativeAI } from '@google/generative-ai';\nexport const f = async (m: any) => (await m.generateContent('x')).response.text();\n`,
  });
  expect(findings.map((item) => `${item.file}:${item.line}:${item.rule}:${item.status}`)).toEqual([
    'app.py:3:openai-python-v1:report',
    'app.py:5:openai-python-v1:report',
    'gem.ts:1:gemini-generative-ai-js:report',
    'gem.ts:2:gemini-response-text-method:report',
    'llm.py:1:anthropic-beta-graduated-files-api:report',
    'palm.js:1:gemini-palm-decommissioned:report',
    'palm.js:2:gemini-palm-decommissioned:report',
  ]);
});

it('stays silent for current APIs', async () => {
  expect(
    await review({
      'a.ts': `import OpenAI from 'openai';\nconst c = new OpenAI();\nexport const f = () => c.responses.create({ model: 'gpt-5.6-luna', input: 'x' });\nexport const g = () => c.chat.completions.create({ model: 'gpt-5.6-luna', messages: [] });\n`,
    }),
  ).toEqual([]);
});

it("marks a call two providers' rules match in a file importing both SDKs", async () => {
  const findings = await review({
    'both.ts': `import OpenAI from 'openai';\nimport Anthropic from '@anthropic-ai/sdk';\nconst anthropic = new Anthropic();\nexport const f = () => anthropic.completions.create({ model: 'm', prompt: 'x', max_tokens_to_sample: 1 });\nexport const o = new OpenAI();\n`,
  });
  expect(findings.map((item) => [item.rule, item.ambiguous])).toEqual([
    ['anthropic-text-completions', true],
    ['openai-legacy-completions', true],
  ]);
});

it('labels findings in test paths', async () => {
  const findings = await review({
    'src/models.test.ts': "export const names = ['chat-bison-001'];\n",
  });
  expect(findings).toEqual([
    expect.objectContaining({ rule: 'gemini-palm-decommissioned', test: true }),
  ]);
});
