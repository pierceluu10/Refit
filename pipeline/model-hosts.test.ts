import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry, type DeadlineRegistry } from './deadline-registry.ts';
import { detectModelHosts, hostDeadlineMatches } from './model-hosts.ts';
import { proposeModelReplacements } from './model-retirements.ts';

// Real snippets copied from public repositories; each file's first line names its source commit.
const FIXTURES = join(import.meta.dirname, 'fixtures', 'model-hosts');
const NOW = new Date('2026-10-22T00:00:00Z');

async function fixture(name: string) {
  return { path: name, content: await readFile(join(FIXTURES, name), 'utf8') };
}

const sites = (files: { path: string; content: string }[]) =>
  detectModelHosts({ files }).map((site) => [
    site.host,
    site.kind,
    site.value,
    site.line,
    site.upstream ? `${site.upstream.provider}:${site.upstream.model}` : null,
    site.stop,
  ]);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-model-hosts-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('Amazon Bedrock', () => {
  it("finds versioned and unversioned model IDs in AWS's own Converse examples", async () => {
    expect(
      sites([
        await fixture('bedrock-anthropic-converse.js'),
        await fixture('bedrock-llama-converse.js'),
      ]),
    ).toEqual([
      [
        'bedrock',
        'model-id',
        'us.anthropic.claude-haiku-5-5',
        19,
        'anthropic:claude-haiku-5-5',
        'bedrock-lifecycle-unknown',
      ],
      [
        'bedrock',
        'model-id',
        'meta.llama3-8b-instruct-v1:0',
        17,
        null,
        'bedrock-lifecycle-unknown',
      ],
    ]);
  });

  it('finds ARNs and fully versioned IDs anywhere, and unversioned ones only where Bedrock is named', () => {
    expect(
      sites([
        {
          path: 'src/config.ts',
          content: [
            "export const PROFILE = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0';",
            "export const CLAUDE = 'anthropic.claude-3-sonnet-20240229-v1:0';",
            "export const LOOKS_LIKE = 'amazon.nova-pro';",
            "export const SITE = 'amazon.com';",
          ].join('\n'),
        },
      ]),
    ).toEqual([
      [
        'bedrock',
        'model-id',
        'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0',
        1,
        'anthropic:claude-3-5-sonnet-20241022',
        'bedrock-lifecycle-unknown',
      ],
      [
        'bedrock',
        'model-id',
        'anthropic.claude-3-sonnet-20240229-v1:0',
        2,
        'anthropic:claude-3-sonnet-20240229',
        'bedrock-lifecycle-unknown',
      ],
    ]);
  });
});

describe('Azure OpenAI', () => {
  it("reports the deployment variable in openai-node's Azure v1 example as a named stop", async () => {
    expect(sites([await fixture('azure-chat.ts')])).toEqual([
      ['azure-openai', 'deployment', 'deployment', 31, null, 'azure-deployment-name'],
      ['azure-openai', 'deployment', 'deployment', 39, null, 'azure-deployment-name'],
    ]);
  });

  it('reports api-version strings and literal deployment names on AzureOpenAI clients and REST URLs', () => {
    expect(
      sites([
        {
          path: 'src/azure.ts',
          content: [
            "import { AzureOpenAI } from 'openai';",
            "const client = new AzureOpenAI({ apiVersion: '2024-02-15-preview', deployment: 'gpt35-prod' });",
            "await client.chat.completions.create({ model: 'chat-prod', messages });",
            'await fetch(`${endpoint}/openai/deployments/embed-prod/embeddings?api-version=2023-05-15`);',
          ].join('\n'),
        },
        // The same names outside an Azure file are nothing.
        {
          path: 'src/plain.ts',
          content: "const options = { apiVersion: '2024-02-15', model: 'gpt-4o' };",
        },
      ]),
    ).toEqual([
      [
        'azure-openai',
        'api-version',
        '2024-02-15-preview',
        2,
        null,
        'azure-api-version-lifecycle-unknown',
      ],
      ['azure-openai', 'deployment', 'gpt35-prod', 2, null, 'azure-deployment-name'],
      ['azure-openai', 'deployment', 'chat-prod', 3, null, 'azure-deployment-name'],
      ['azure-openai', 'api-version', '2023-05-15', 4, null, 'azure-api-version-lifecycle-unknown'],
      ['azure-openai', 'deployment', 'embed-prod', 4, null, 'azure-deployment-name'],
    ]);
  });
});

describe('OpenRouter', () => {
  it("finds provider/model IDs in OpenRouter's fetch example", async () => {
    expect(sites([await fixture('openrouter-fetch.ts')])).toEqual([
      [
        'openrouter',
        'model-id',
        'openai/gpt-4o-mini',
        16,
        'openai:gpt-4o-mini',
        'openrouter-alias',
      ],
    ]);
  });

  it('maps an OpenRouter ID to a retired upstream model only when it names that registry model exactly', async () => {
    const registry = await loadDeadlineRegistry();
    const has = (provider: string, version: string) =>
      registry.deadlines.some(
        (entry) => entry.provider === provider && entry.versions.includes(version),
      );
    const found = detectModelHosts({
      files: [
        {
          path: 'src/router.ts',
          content: [
            "const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });",
            "await client.chat.completions.create({ model: 'openai/gpt-3.5-turbo' });",
            "await client.chat.completions.create({ model: 'anthropic/claude-3-opus-20240229' });",
            // OpenRouter's own alias names no dated Anthropic model.
            "await client.chat.completions.create({ model: 'anthropic/claude-3.5-sonnet' });",
            "await client.chat.completions.create({ model: 'meta-llama/llama-3-70b-instruct' });",
          ].join('\n'),
        },
      ],
    });
    expect(
      hostDeadlineMatches(found, has).map((match) => [
        match.provider,
        match.version,
        match.site.line,
      ]),
    ).toEqual([
      ['openai', 'gpt-3.5-turbo', 2],
      ['anthropic', 'claude-3-opus-20240229', 3],
    ]);
    expect(found.filter((site) => site.stop).map((site) => site.value)).toEqual([
      'openai/gpt-3.5-turbo',
      'anthropic/claude-3.5-sonnet',
      'meta-llama/llama-3-70b-instruct',
    ]);
  });

  it('maps an OpenRouter google/ ID to the gemini registry provider', () => {
    const found = detectModelHosts({
      files: [
        {
          path: 'src/router.ts',
          content: [
            "const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });",
            "await client.chat.completions.create({ model: 'google/gemini-1.5-pro-002' });",
          ].join('\n'),
        },
      ],
    });
    const has = (provider: string, version: string) =>
      provider === 'gemini' && version === 'gemini-1.5-pro-002';
    expect(hostDeadlineMatches(found, has).map((match) => [match.provider, match.version])).toEqual(
      [['gemini', 'gemini-1.5-pro-002']],
    );
  });
});

describe('feeding scanDeadlines and the model-replacement rule', () => {
  it('reports OpenRouter routes to retired models, and Bedrock and Azure only from their own entries', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
      'src/router.ts':
        "const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });\nexport const reply = client.chat.completions.create({ model: 'openai/gpt-4-0613', messages: [] });\n",
      'src/bedrock.ts':
        "import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';\nexport const modelId = 'anthropic.claude-3-sonnet-20240229-v1:0';\n",
      'src/azure.ts':
        "import { AzureOpenAI } from 'openai';\nexport const client = new AzureOpenAI({ apiVersion: '2024-02-15-preview' });\n",
    });
    const registry = await loadDeadlineRegistry();
    const shipped = await scanDeadlines(root, registry, NOW);
    const live = (scan: typeof shipped) =>
      scan.exposures.flatMap((exposure) =>
        exposure.evidence.map((item) => `${exposure.deadline.id} ${item.file}:${item.line}`),
      );
    // The shipped registry has no Bedrock or Azure entries, and Anthropic's own date for
    // claude-3-sonnet-20240229 is not Bedrock's, so only the OpenRouter route is an exposure.
    expect(live(shipped)).toEqual([
      `${registry.deadlines.find((entry) => entry.versions.includes('gpt-4-0613'))!.id} src/router.ts:2`,
    ]);
    // With host entries (illustrative dates, test only), Bedrock and Azure sites match them.
    const withHosts: DeadlineRegistry = {
      formatVersion: 1,
      deadlines: [
        ...registry.deadlines,
        {
          id: 'bedrock-test-claude-3-sonnet',
          provider: 'bedrock',
          kind: 'model',
          versions: ['anthropic.claude-3-sonnet-20240229-v1:0'],
          date: '2026-12-01',
          summary: 'Illustrative test entry.',
          replacement: null,
          source: 'https://example.com/bedrock',
          checkedAt: '2026-10-22',
        },
        {
          id: 'azure-test-2024-02-15-preview',
          provider: 'azure-openai',
          kind: 'api-version',
          versions: ['2024-02-15-preview'],
          date: '2026-12-01',
          summary: 'Illustrative test entry.',
          replacement: null,
          source: 'https://example.com/azure',
          checkedAt: '2026-10-22',
        },
      ],
    };
    expect(live(await scanDeadlines(root, withHosts, NOW))).toEqual(
      expect.arrayContaining([
        'bedrock-test-claude-3-sonnet src/bedrock.ts:2',
        'azure-test-2024-02-15-preview src/azure.ts:2',
      ]),
    );
  });

  it('lists host sites as named stops instead of model edits', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
      'src/router.ts':
        "import OpenAI from 'openai';\nconst client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });\nexport const reply = client.chat.completions.create({ model: 'openai/gpt-4-0613', messages: [] });\n",
      'src/direct.ts':
        "import OpenAI from 'openai';\nconst client = new OpenAI();\nexport const reply = client.chat.completions.create({ model: 'gpt-4-0613', messages: [] });\n",
    });
    const proposal = await proposeModelReplacements(root, await loadDeadlineRegistry(), NOW);
    // The direct request may be replaced; the routed one is never edited, only listed.
    expect(proposal.replacements.some((item) => item.file === 'src/router.ts')).toBe(false);
    expect(proposal.unresolved.filter((item) => item.file === 'src/router.ts')).toEqual([]);
    expect(
      proposal.stops
        .filter((stop) => stop.file === 'src/router.ts')
        .map((stop) => [stop.line, stop.call, stop.reason]),
    ).toEqual([
      [
        3,
        'OpenRouter',
        'OpenRouter model openai/gpt-4-0613: it routes to openai, so change it in the OpenRouter call.',
      ],
    ]);
  });

  it('lists, but never edits, a repository that only routes a retiring model through OpenRouter', async () => {
    const root = await repository({
      'package.json': JSON.stringify({ dependencies: { openai: '^4.0.0' } }),
      'src/router.ts':
        "import OpenAI from 'openai';\nconst client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1' });\nexport const reply = client.chat.completions.create({ model: 'openai/gpt-4-0613', messages: [] });\n",
    });
    const proposal = await proposeModelReplacements(root, await loadDeadlineRegistry(), NOW);
    // The route alone is still listed as a stop, never edited.
    expect(proposal).toMatchObject({ replacements: [], unresolved: [], patch: null });
    expect(proposal.stops.map((stop) => [stop.file, stop.line, stop.call])).toEqual([
      ['src/router.ts', 3, 'OpenRouter'],
    ]);
  });
});
