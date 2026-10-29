import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAiRuleTables } from './ai-rules.ts';
import { proposeOpenAiSdkMajor } from './ai-sdk-majors.ts';
import { applySourceEdits } from './patches.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function lockfile(version: string) {
  return JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: { openai: `^${version}` } },
      'node_modules/openai': {
        version,
        resolved: `https://registry.npmjs.org/openai/-/openai-${version}.tgz`,
      },
    },
  });
}

async function repository(version: string, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-ai-sdk-majors-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: 'app', dependencies: { openai: `^${version}` } }),
    'package-lock.json': lockfile(version),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

async function propose(version: string, files: Record<string, string>) {
  const proposal = await proposeOpenAiSdkMajor(
    await repository(version, files),
    await loadAiRuleTables(),
  );
  const changed = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      applySourceEdits(
        content,
        (proposal?.edits ?? []).filter((edit) => edit.file === path),
      ),
    ]),
  );
  return { proposal: proposal!, changed };
}

describe('openai v3 to 6', () => {
  it('rewrites the documented client, method and response shapes', async () => {
    const { proposal, changed } = await propose('3.3.0', {
      'src/ai.ts': `import { Configuration, OpenAIApi } from 'openai';

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

export async function ask(prompt: string) {
  const completion = await openai.createChatCompletion({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  return completion.data.choices[0].message?.content;
}

export async function embed(input: string) {
  const { data } = await openai.createEmbedding({ model: 'text-embedding-3-small', input });
  return data.data[0].embedding;
}

export async function moderate(input: string) {
  return (await openai.createModeration({ input })).data.results[0].flagged;
}
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(proposal.major).toBe(3);
    expect(changed['src/ai.ts']).toBe(`import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function ask(prompt: string) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  return completion.choices[0].message?.content;
}

export async function embed(input: string) {
  const data = await openai.embeddings.create({ model: 'text-embedding-3-small', input });
  return data.data[0].embedding;
}

export async function moderate(input: string) {
  return (await openai.moderations.create({ input })).results[0].flagged;
}
`);
    expect(proposal.rules.map((rule) => rule.rule)).toContain('openai-node-v4-response-data');
  });

  it('follows an exported client into another file and maps createTranscription', async () => {
    const { proposal, changed } = await propose('3.2.1', {
      'lib/openai.js': `const { Configuration, OpenAIApi } = require('openai');
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.KEY }));
module.exports = { openai };
`,
      'routes/audio.js': `const fs = require('fs');
const { openai } = require('../lib/openai');

async function transcribe(path) {
  const response = await openai.createTranscription(fs.createReadStream(path), 'whisper-1');
  return response.data.text;
}
module.exports = { transcribe };
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(changed['lib/openai.js']).toBe(`const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.KEY });
module.exports = { openai };
`);
    expect(changed['routes/audio.js']).toContain(
      `await openai.audio.transcriptions.create({ file: fs.createReadStream(path), model: 'whisper-1' });`,
    );
    expect(changed['routes/audio.js']).toContain('return response.text;');
  });

  it('stops where the guide gives no mapping, and never edits those sites', async () => {
    const source = `import { Configuration, OpenAIApi, ChatCompletionRequestMessage } from 'openai';
const openai = new OpenAIApi(new Configuration({ apiKey: 'k', basePath: 'https://proxy' }));
export async function run(messages: ChatCompletionRequestMessage[]) {
  const response = await openai.createChatCompletion({ model: 'gpt-4o', messages }, { responseType: 'stream' });
  try {
    const edit = await openai.createEdit({ model: 'x', input: 'a', instruction: 'b' });
    return [response, edit.headers];
  } catch (error: any) {
    return error.response.status;
  }
}
export const other = (client: any) => client.createCompletion({ model: 'x' });
`;
    const { proposal, changed } = await propose('3.3.0', { 'src/run.ts': source });
    const reasons = proposal.stops.map((item) => item.rule);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'openai-node-v4-types',
        'openai-node-v4-client',
        'openai-node-v4-request-options',
        'openai-node-v4-create-edit',
        'openai-node-v4-errors',
        'openai-node-untraced-v3-call',
      ]),
    );
    expect(changed['src/run.ts']).not.toContain('chat.completions.create');
    expect(changed['src/run.ts']).not.toContain('edits.create');
  });

  it('stops when the result is used whole', async () => {
    const { proposal } = await propose('3.3.0', {
      'a.ts': `import { Configuration, OpenAIApi } from 'openai';
const configuration = new Configuration({ apiKey: process.env.K });
const openai = new OpenAIApi(configuration);
export async function f() {
  const response = await openai.createCompletion({ model: 'gpt-3.5-turbo-instruct', prompt: 'x' });
  console.log(response.status);
  return response.data.choices[0].text;
}
`,
    });
    expect(proposal.stops).toEqual([
      expect.objectContaining({ rule: 'openai-node-v4-response-data', line: 5 }),
    ]);
  });

  it('proposes nothing for a project already on 6', async () => {
    const proposal = await proposeOpenAiSdkMajor(
      await repository('6.2.0', { 'a.ts': "import OpenAI from 'openai';\n" }),
      await loadAiRuleTables(),
    );
    expect(proposal).toBeNull();
  });
});

describe('openai v4 to 6', () => {
  it('renames v5 methods and namespaces on traced clients and import paths', async () => {
    const { proposal, changed } = await propose('4.67.0', {
      'src/files.ts': `import OpenAI from 'openai';
import type { ParsedChatCompletion } from 'openai/resources/beta/chat/completions';
const client = new OpenAI();
export async function clean(id: string) {
  await client.files.del(id);
  const parsed: ParsedChatCompletion<null> = await client.beta.chat.completions.parse({ model: 'gpt-4o', messages: [] });
  return client.chat.completions
    .runTools({ model: 'gpt-4o', messages: [], tools: [] })
    .on('functionCall', (call) => console.log(call));
}
`,
    });
    expect(proposal.stops).toEqual([]);
    expect(changed['src/files.ts']).toContain('await client.files.delete(id);');
    expect(changed['src/files.ts']).toContain('await client.chat.completions.parse(');
    expect(changed['src/files.ts']).toContain("from 'openai/resources/chat/completions'");
    expect(changed['src/files.ts']).toContain(".on('functionToolCall'");
  });

  it('stops on runFunctions, fileFromPath and httpAgent', async () => {
    const { proposal } = await propose('4.20.0', {
      'a.ts': `import OpenAI from 'openai';
import { Agent } from 'http';
const client = new OpenAI({ httpAgent: new Agent() });
export const file = OpenAI.fileFromPath('x');
export const run = () => client.beta.chat.completions.runFunctions({ model: 'x', messages: [], functions: [] });
`,
    });
    expect(proposal.stops.map((item) => item.rule).sort()).toEqual([
      'openai-node-v5-file-from-path',
      'openai-node-v5-http-agent',
      'openai-node-v5-run-functions',
    ]);
  });
});
