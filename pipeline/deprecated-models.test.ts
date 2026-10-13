import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  proposeDeprecatedModelPatch,
  runDeprecationPipeline,
  scanDeprecatedModels,
  type DeprecatedModelFinding,
} from './deprecated-models.ts';
import { hashDeprecationModels, type DeprecationSnapshot } from './deprecation-snapshots.ts';
import type { ProviderAdapter } from './providers.ts';
import type { Repository } from './types.ts';

const execute = promisify(execFile);
const directories: string[] = [];
const retired = {
  id: 'old-model',
  status: 'retired' as const,
  shutdownDate: '2026-01-02',
  replacement: 'new-model',
  sourceNote: 'Synthetic detector test fixture.',
};
const withoutReplacement = {
  id: 'no-replacement',
  status: 'deprecated' as const,
  shutdownDate: null,
  replacement: null,
  sourceNote: 'Synthetic detector test fixture.',
};
const snapshot: DeprecationSnapshot = {
  kind: 'refit-deprecation-snapshot',
  version: 1,
  provider: 'openai',
  source: {
    url: 'https://fixture.invalid/deprecations',
    retrievedAt: '2026-01-01T00:00:00.000Z',
    sha256: hashDeprecationModels([retired, withoutReplacement]),
  },
  models: [retired, withoutReplacement],
};
const provider: ProviderAdapter = {
  id: 'openai',
  packageName: 'openai',
  defaultImport: true,
  namedExport: 'OpenAI',
  operations: [
    {
      resource: 'completions',
      method: 'create',
      requestChecks: [{ argument: 'model', kind: 'model-id' }],
    },
    {
      resource: 'chat.completions',
      method: 'create',
      requestChecks: [{ argument: 'model', kind: 'model-id' }],
    },
  ],
};

function repository(files: Record<string, string>): Repository {
  return {
    root: '/virtual',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    dependencies: [],
    lockfiles: [],
    warnings: [],
  };
}

function scan(content: string) {
  return scanDeprecatedModels(
    repository({
      'index.ts': `import OpenAI from 'openai';
const client = new OpenAI();
${content}`,
    }),
    provider,
    snapshot,
  );
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('deprecated model findings', () => {
  it('matches the shared finding contract and confirms only direct literals for flat and nested calls', () => {
    const result = scan(`
client.completions.create({ model: 'old-model', prompt: 'hello' });
client.chat.completions.create({ model: "old-model", messages: [] });`);

    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual({
      kind: 'deprecated-model',
      provider: 'openai',
      modelId: 'old-model',
      status: 'retired',
      replacement: 'new-model',
      shutdownDate: '2026-01-02',
      location: { file: 'index.ts', line: 4, column: 36 },
      call: 'client.completions.create',
      confidence: 'confirmed',
      reason: '',
    } satisfies DeprecatedModelFinding);
    expect(Object.keys(result.findings[0]).sort()).toEqual(
      [
        'call',
        'confidence',
        'kind',
        'location',
        'modelId',
        'provider',
        'reason',
        'replacement',
        'shutdownDate',
        'status',
      ].sort(),
    );
    expect(result.findings[1]).toMatchObject({
      call: 'client.chat.completions.create',
      confidence: 'confirmed',
    });
    expect(result.edits).toHaveLength(2);
  });

  it.each([
    [
      "const selected = 'old-model'; client.completions.create({ model: selected });",
      'variable or configuration',
    ],
    [
      "client.completions.create({ model: process.env.MODEL || 'old-model' });",
      'environment lookup',
    ],
    [
      "const config = { model: 'old-model' }; client.completions.create({ model: config.model });",
      'variable or configuration',
    ],
    [
      "function complete(model: string) { return client.completions.create({ model }); } complete('old-model');",
      'function argument',
    ],
    ['client.completions.create({ model: `old-model` });', 'template string'],
    [
      "const options = { model: 'old-model' }; client.completions.create({ ...options });",
      'object spread',
    ],
    [
      "const extra = {}; client.completions.create({ model: 'old-model', ...extra });",
      'object spread',
    ],
    ["client.completions.create({ ['model']: 'old-model' });", 'computed key'],
    [
      "const options = { model: 'old-model' }; client.completions.create(options);",
      'not an inline object literal',
    ],
  ])('keeps supported dynamic provenance in review: %s', (content, reason) => {
    const result = scan(content);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      modelId: 'old-model',
      confidence: 'needs-review',
    });
    expect(result.findings[0].reason).toContain(reason);
    expect(result.edits).toEqual([]);
  });

  it('traces direct relative imported clients and wrapper arguments independent of file order', () => {
    const input = repository({
      'use.ts':
        "import { complete } from './wrapper.ts'; export const run = () => complete('old-model');",
      'wrapper.ts':
        "import { client } from './client.ts'; export function complete(model: string) { return client.completions.create({ model }); }",
      'client.ts':
        "import OpenAI from 'openai'; export const client = new OpenAI({ apiKey: 'test' });",
    });
    const result = scanDeprecatedModels(input, provider, snapshot);

    expect(result.findings).toEqual([
      expect.objectContaining({
        modelId: 'old-model',
        call: 'client.completions.create',
        confidence: 'needs-review',
        reason: expect.stringContaining('function argument'),
      }),
    ]);
  });

  it('confirms calls through a directly imported immutable client', () => {
    const result = scanDeprecatedModels(
      repository({
        'use.ts':
          "import { client } from './client.ts'; client.completions.create({ model: 'old-model' });",
        'client.ts': "import OpenAI from 'openai'; export const client = new OpenAI();",
      }),
      provider,
      snapshot,
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        call: 'client.completions.create',
        confidence: 'confirmed',
        modelId: 'old-model',
      }),
    ]);
    expect(result.edits).toHaveLength(1);
  });

  it.each(['configure(client);', 'const alias = client; configure(alias);', 'export { client };'])(
    'downgrades direct literals when the SDK client is mutated or escapes: %s',
    (escape) => {
      const result = scan(`${escape}
client.completions.create({ model: 'old-model' });`);
      expect(result.findings[0]).toMatchObject({
        confidence: 'needs-review',
        reason: expect.stringContaining('mutated or escape'),
      });
      expect(result.edits).toEqual([]);
    },
  );

  it('emits no finding when no statically discovered candidate matches the verified snapshot', () => {
    const result = scan(`
const selected = process.env.MODEL;
client.completions.create({ model: 'current-model' });
client.completions.create({ model: selected });`);
    expect(result).toEqual({ findings: [], edits: [] });
  });

  it('does not patch a confirmed model with a null replacement', () => {
    const result = scan("client.completions.create({ model: 'no-replacement' });");
    expect(result.findings).toEqual([
      expect.objectContaining({
        confidence: 'confirmed',
        modelId: 'no-replacement',
        replacement: null,
      }),
    ]);
    expect(result.edits).toEqual([]);
    expect(
      proposeDeprecatedModelPatch(
        repository({
          'index.ts':
            "import OpenAI from 'openai'; const client = new OpenAI(); client.completions.create({ model: 'no-replacement' });",
        }),
        provider,
        snapshot,
      ),
    ).toMatchObject({
      status: 'unsupported',
      edits: 0,
      unresolvedFindings: 1,
      diff: '',
    });
  });
});

describe('deprecated model deterministic patch', () => {
  it('changes literal tokens only, rescans, warns about behavior, and produces a git-applicable diff', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'refit-model-patch-'));
    directories.push(directory);
    const content = `import OpenAI from 'openai';
const client = new OpenAI();
client.completions.create({ model: 'old-model', prompt: 'old-model remains prompt text' });
`;
    const input = repository({ 'src/index.ts': content });
    const patch = proposeDeprecatedModelPatch(input, provider, snapshot);

    expect(patch).toMatchObject({
      generator: 'deterministic',
      status: 'proposed',
      edits: 1,
      unresolvedFindings: 0,
      remainingFindings: [],
    });
    expect(patch.diff).toContain("-client.completions.create({ model: 'old-model'");
    expect(patch.diff).toContain("+client.completions.create({ model: 'new-model'");
    expect(patch.diff).toContain("prompt: 'old-model remains prompt text'");
    expect(patch.warnings.join(' ')).toMatch(/differ in behavior.+test the migration/i);

    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src/index.ts'), content);
    await execute('git', ['init', '-q'], { cwd: directory });
    const patchPath = join(directory, 'migration.patch');
    await writeFile(patchPath, patch.diff);
    await execute('git', ['apply', '--check', patchPath], { cwd: directory });
    await execute('git', ['apply', patchPath], { cwd: directory });
    expect(await readFile(join(directory, 'src/index.ts'), 'utf8')).toBe(
      content.replace("'old-model', prompt", "'new-model', prompt"),
    );
  });

  it('provides a callable path that reads repository, adapter, and verified snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'refit-model-pipeline-'));
    directories.push(directory);
    const repositoryPath = join(directory, 'repository');
    await mkdir(repositoryPath);
    await writeFile(
      join(repositoryPath, 'index.ts'),
      "import OpenAI from 'openai'; const client = new OpenAI(); client.completions.create({ model: 'old-model' });",
    );
    await writeFile(
      join(repositoryPath, 'package.json'),
      JSON.stringify({ dependencies: { openai: '^1.0.0' } }),
    );
    const adapterPath = join(directory, 'provider.json');
    const snapshotPath = join(directory, 'snapshot.json');
    await writeFile(adapterPath, JSON.stringify(provider));
    await writeFile(snapshotPath, JSON.stringify(snapshot));

    const report = await runDeprecationPipeline({
      repository: repositoryPath,
      providerConfig: adapterPath,
      snapshot: snapshotPath,
      proposePatch: true,
    });
    expect(report).toMatchObject({
      provider: 'openai',
      status: 'affected',
      findings: [expect.objectContaining({ confidence: 'confirmed', modelId: 'old-model' })],
      patch: { status: 'proposed', unresolvedFindings: 0 },
    });
    expect(
      (
        await runDeprecationPipeline({
          repository: repositoryPath,
          providerConfig: adapterPath,
          snapshot: snapshotPath,
        })
      ).runId,
    ).toBe(report.runId);
  });

  it('rejects adapter and snapshot provider mismatches', () => {
    expect(() =>
      scanDeprecatedModels(
        repository({ 'index.ts': '' }),
        { ...provider, id: 'other-provider' },
        snapshot,
      ),
    ).toThrow(/does not match adapter/);
  });
});
