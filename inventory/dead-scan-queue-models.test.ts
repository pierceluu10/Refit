import { afterEach, describe, expect, it } from 'vitest';
import { scanDeadApis, type DeadScanReport } from './dead-scan.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const TODAY = '2026-11-05';
const manifest = (dependencies: Record<string, string>) =>
  JSON.stringify({ dependencies }, null, 2);
const OPENAI_PACKAGE = { 'package.json': manifest({ openai: '^6.0.0' }) };
const ANTHROPIC_PACKAGE = { 'package.json': manifest({ '@anthropic-ai/sdk': '^1.0.0' }) };
const BEDROCK_PACKAGE = {
  'package.json': manifest({ '@aws-sdk/client-bedrock-runtime': '^3.0.0' }),
};

const repos: string[] = [];
async function scan(files: Record<string, string>): Promise<DeadScanReport> {
  const repoDir = await makeRepo(files);
  repos.push(repoDir);
  return scanDeadApis(repoDir, 'test/repo', { today: TODAY });
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(removeRepo));
});

/** Shows the whole report when a check fails, since a wrong class is usually about its reason. */
function explain(report: DeadScanReport): string {
  return report.details
    .map((one) => `${one.matchClass} ${one.entryId} ${one.file}:${one.line} ${one.reason}`)
    .concat(report.quiet.map((one) => `quiet ${one.entryId} ${one.file}:${one.line} ${one.reason}`))
    .join('\n');
}

const idsOn = (report: DeadScanReport, prefix: string) =>
  report.details.filter((one) => one.entryId.startsWith(prefix)).map((one) => one.entryId);

const linesOf = (report: DeadScanReport, prefix: string) =>
  report.details.filter((one) => one.entryId.startsWith(prefix)).map((one) => one.line);

describe('azure-openai', () => {
  const AZURE_CLIENT =
    'from openai import AzureOpenAI\nclient = AzureOpenAI(azure_endpoint="https://x.openai.azure.com")\n';

  it('flags a retired deployment name as unclear, and not the live one beside it', async () => {
    const report = await scan({
      'a.py': `${AZURE_CLIENT}client.chat.completions.create(model="gpt-5-chat")\nclient.chat.completions.create(model="gpt-5.6-sol")\n`,
    });
    expect(linesOf(report, 'AZ-'), explain(report)).toEqual([3]);
    expect(idsOn(report, 'AZ-')).toEqual(['AZ-1.gpt-5-chat']);
    const hit = report.details.find((one) => one.entryId === 'AZ-1.gpt-5-chat');
    expect(hit?.matchClass, explain(report)).toBe('unclear');
  });

  it('reads a deployment in a REST path and a router name', async () => {
    const report = await scan({
      'a.ts': 'const u = `https://x.openai.azure.com/openai/deployments/gpt-image-1/images`;\n',
      'b.py': 'import litellm\nlitellm.completion(model="azure/gpt-4.5-preview")\n',
    });
    expect(idsOn(report, 'AZ-'), explain(report)).toEqual(
      expect.arrayContaining(['AZ-3.gpt-image-1', 'AZ-4.gpt-4.5-preview']),
    );
  });

  it('keeps a version-level death off the plain name, whose later version lives', async () => {
    const report = await scan({
      'a.py': `${AZURE_CLIENT}client.audio.transcriptions.create(model="gpt-4o-mini-transcribe")\nclient.audio.transcriptions.create(model="gpt-4o-mini-transcribe-2025-03-20")\n`,
    });
    expect(linesOf(report, 'AZ-'), explain(report)).toEqual([4]);
  });

  it("doesn't fire on a word that only reads as a model: davinci outside a model field", async () => {
    const report = await scan({
      'a.py': `${AZURE_CLIENT}painter = "davinci"\nclient.completions.create(model="davinci")\n`,
    });
    expect(linesOf(report, 'AZ-'), explain(report)).toEqual([4]);
  });

  it('flags the Assistants API on an Azure client', async () => {
    const report = await scan({
      'a.ts':
        "const u = 'https://x.openai.azure.com/openai/threads/1/runs';\nconst r = 'https://x.openai.azure.com/openai/responses';\n",
    });
    expect(linesOf(report, 'AZ-10'), explain(report)).toEqual([1]);
  });

  it('flags the retired azure-ai-inference package at its import and in the manifest', async () => {
    const report = await scan({
      'requirements.txt': 'azure-ai-inference==1.0.0\n',
      'a.py': 'from azure.ai.inference import ChatCompletionsClient\n',
    });
    const files = report.details
      .filter((one) => one.entryId === 'AZ-11.azure-ai-inference')
      .map((one) => one.file);
    expect(new Set(files), explain(report)).toEqual(new Set(['requirements.txt', 'a.py']));
  });

  it("leaves a picker row with a shared name in another provider's file alone", async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'azure.ts': "export const endpoint = 'https://acme.openai.azure.com';\n",
      'openai.tsx':
        'export const Pick = () => <option value="gpt-4-32k-0613">GPT-4 32k</option>;\n',
      'azure.tsx':
        'export const url = "https://acme.openai.azure.com";\nexport const Pick = () => <option value="gpt-4-32k-0613">GPT-4 32k</option>;\n',
    });
    const inFile = (file: string) =>
      report.details.filter((one) => one.file === file && one.entryId === 'AZ-5.gpt-4-32k');
    expect(inFile('openai.tsx'), explain(report)).toEqual([]);
    expect(
      inFile('azure.tsx').map((one) => one.matchClass),
      explain(report),
    ).toEqual(['unclear']);
  });

  it("doesn't fire on OpenAI's own calls with the same names", async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts':
        "import OpenAI from 'openai';\nconst c = new OpenAI();\nc.images.generate({ model: 'gpt-image-1' });\nc.beta.assistants.list();\nc.audio.transcriptions.create({ model: 'gpt-4o-transcribe' });\nfetch('https://api.openai.com/v1/threads');\n",
    });
    expect(idsOn(report, 'AZ-'), explain(report)).toEqual([]);
    expect(idsOn(report, 'OA-'), explain(report)).toContain('OA-1.gpt-image-1');
    expect(report.quiet.map((one) => one.entryId)).toContain('AZ-3.gpt-image-1');
  });
});

describe('aws-bedrock', () => {
  it('flags a dead Bedrock id, and not the live id beside it', async () => {
    const report = await scan({
      ...BEDROCK_PACKAGE,
      'a.ts':
        "const dead = 'anthropic.claude-sonnet-4-20250514-v1:0';\nconst live = 'anthropic.claude-sonnet-4-6';\nconst legacy = 'anthropic.claude-sonnet-4-5-20250929-v1:0';\n",
    });
    expect(linesOf(report, 'AW-'), explain(report)).toEqual([1]);
    expect(idsOn(report, 'AW-')).toEqual(['AW-1.claude-sonnet-4']);
    expect(report.details[0].matchClass, explain(report)).toBe('live');
  });

  it('flags a cross-Region prefix, an ARN and a router form', async () => {
    const report = await scan({
      ...BEDROCK_PACKAGE,
      'a.ts': [
        "const a = 'us.anthropic.claude-3-haiku-20240307-v1:0';",
        "const b = 'arn:aws:bedrock:us-east-1::foundation-model/cohere.command-r-v1:0';",
        "const c = 'bedrock/meta.llama3-2-90b-instruct-v1:0';",
        "const d = 'global.amazon.nova-reel-v1:1';",
        '',
      ].join('\n'),
    });
    expect(idsOn(report, 'AW-'), explain(report)).toEqual([
      'AW-1.claude-3-haiku',
      'AW-3.command-r',
      'AW-4.llama3-2-90b',
      'AW-2.nova-reel',
    ]);
  });

  it('holds a date still ahead in future, so it is no break yet', async () => {
    const report = await scan({
      ...BEDROCK_PACKAGE,
      'a.ts': "const m = 'anthropic.claude-opus-4-1-20250805-v1:0';\n",
    });
    expect(idsOn(report, 'AW-'), explain(report)).toEqual([]);
  });

  it("gives Anthropic's direct call no Bedrock finding", async () => {
    const report = await scan({
      ...ANTHROPIC_PACKAGE,
      'a.ts':
        "import Anthropic from '@anthropic-ai/sdk';\nnew Anthropic().messages.create({ model: 'claude-sonnet-4-20250514' });\n",
    });
    expect(idsOn(report, 'AW-'), explain(report)).toEqual([]);
    expect(idsOn(report, 'AN-'), explain(report)).toContain('AN-1.claude-sonnet-4-20250514');
  });

  it("doesn't give a Bedrock id Anthropic's finding for the same model", async () => {
    const report = await scan({
      ...BEDROCK_PACKAGE,
      'a.ts': "const m = 'anthropic.claude-sonnet-4-20250514-v1:0';\n",
    });
    expect(idsOn(report, 'AN-'), explain(report)).toEqual([]);
  });
});

describe('xai', () => {
  const XAI_CLIENT =
    "import OpenAI from 'openai';\nconst c = new OpenAI({ baseURL: 'https://api.x.ai/v1' });\n";

  it('flags a retired slug that still resolves, and not the live one beside it', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': `${XAI_CLIENT}c.chat.completions.create({ model: 'grok-4-0709' });\nc.chat.completions.create({ model: 'grok-4.3' });\nc.images.generate({ model: 'grok-imagine-image' });\n`,
    });
    expect(linesOf(report, 'XA-'), explain(report)).toEqual([3]);
    expect(idsOn(report, 'XA-')).toEqual(['XA-1.grok-4-0709']);
  });

  it('flags a name other hosts share when the file calls xAI', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': `${XAI_CLIENT}c.chat.completions.create({ model: 'grok-3' });\n`,
    });
    expect(idsOn(report, 'XA-'), explain(report)).toEqual(['XA-1.grok-3']);
  });

  it("doesn't fire on Azure Foundry's or a gateway's grok, where the same name has its own dates", async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.py':
        'from openai import AzureOpenAI\nc = AzureOpenAI(azure_endpoint="https://x.services.ai.azure.com")\nc.chat.completions.create(model="grok-4-1-fast-reasoning")\n',
      'b.ts':
        "const r = fetch('https://openrouter.ai/api/v1/chat/completions', { body: JSON.stringify({ model: 'x-ai/grok-3' }) });\n",
    });
    expect(idsOn(report, 'XA-'), explain(report)).toEqual([]);
    expect(report.quiet.map((one) => one.entryId)).toContain('XA-1.grok-4-1-fast-reasoning');
  });

  it('holds grok-voice-2.0 back: deprecated with no end', async () => {
    const report = await scan({
      ...OPENAI_PACKAGE,
      'a.ts': `${XAI_CLIENT}const voice = 'grok-voice-2.0';\n`,
    });
    expect(idsOn(report, 'XA-'), explain(report)).toEqual([]);
  });
});
