import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scanProviders, vendorStatus, vendorWatch } from './agent-catalog.ts';
import { parseVendorCatalog } from './vendor-catalog.ts';
import { scanVendorReferences } from './vendor-references.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'refit-vendors-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

it('detects vendors from every ecosystem, env names and hostnames, and labels and watches each', async () => {
  const root = await repository({
    'package.json': JSON.stringify({ name: 'app', dependencies: { stripe: '^17.7.0' } }),
    'pnpm-lock.yaml': [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      stripe:',
      '        specifier: ^17.7.0',
      '        version: 17.7.0',
      'packages:',
      '  stripe@17.7.0:',
      '    resolution: {integrity: sha512-x}',
      'snapshots:',
      '  stripe@17.7.0: {}',
      '',
    ].join('\n'),
    'go.mod':
      'module example.com/app\n\ngo 1.22\n\nrequire github.com/supabase-community/supabase-go v0.0.4\n',
    Gemfile: "source 'https://rubygems.org'\ngem 'posthog-ruby'\n",
    '.env.example': 'RESEND_API_KEY=\n',
    'worker/main.py': 'import os\nkey = os.environ["OPENAI_API_KEY"]\n',
    'worker/index.py': 'INDEX = "https://api.pinecone.io/indexes"\n',
    // Prose and tests are not integrations.
    'README.md': 'Set ANTHROPIC_API_KEY to try Claude.\n',
    'tests/test_llm.py': 'ANTHROPIC_API_KEY = "test"\n',
  });
  const { detections, vendorScan } = await scanProviders(root);
  expect(vendorScan).toEqual({ files: 4, truncated: false });
  const found = Object.fromEntries(
    detections.map((detection) => [
      detection.agent.id,
      {
        status: vendorStatus(detection, false),
        watch: vendorWatch(detection.agent).status,
        evidence: [
          ...detection.packages.map((item) => `${item.ecosystem ?? 'npm'} ${item.name}`),
          ...detection.hostnames.map((item) => `host ${item.file}`),
          ...detection.references.map((item) => `${item.kind} ${item.name} ${item.file}`),
        ],
      },
    ]),
  );
  expect(found).toEqual({
    stripe: {
      status: 'agent-available',
      watch: 'watched',
      evidence: ['npm stripe'],
    },
    openai: {
      status: 'report-only',
      watch: 'watched',
      evidence: ['env OPENAI_API_KEY worker/main.py'],
    },
    supabase: {
      status: 'no-agent',
      watch: 'watched',
      evidence: ['go github.com/supabase-community/supabase-go'],
    },
    resend: { status: 'no-agent', watch: 'watched', evidence: ['env RESEND_API_KEY .env.example'] },
    pinecone: {
      status: 'no-agent',
      watch: 'unwatched',
      evidence: ['hostname api.pinecone.io worker/index.py'],
    },
    posthog: { status: 'no-agent', watch: 'unwatched', evidence: ['rubygems posthog-ruby'] },
  });
  expect(detections.find((item) => item.agent.id === 'stripe')?.packages[0]?.locked).toBe('17.7.0');
  const stripe = detections.find((item) => item.agent.id === 'stripe')!;
  expect(vendorStatus(stripe, true)).toBe('configured');
  expect(vendorWatch(detections.find((item) => item.agent.id === 'posthog')!.agent)).toEqual({
    status: 'unwatched',
    reason: 'The vendor catalog has no OpenAPI document or changelog page for this vendor.',
  });
  const yarn = await scanProviders(
    await repository({
      'package.json': JSON.stringify({ name: 'app', dependencies: { openai: '^4.80.0' } }),
      'yarn.lock':
        '# yarn lockfile v1\n\n\nopenai@^4.80.0:\n  version "4.80.0"\n  resolved "https://registry.yarnpkg.com/openai/-/openai-4.80.0.tgz"\n',
    }),
  );
  expect(yarn.detections.map((item) => [item.agent.id, item.packages[0]?.locked])).toEqual([
    ['openai', '4.80.0'],
  ]);
});

it('matches names and hostnames standing alone and stops at the scan limits', async () => {
  const root = await repository({
    'a.py': 'AZURE_OPENAI_API_KEY = 1\nOPENAI_API_KEY_2 = 2\nhost = "api.example.com.evil"\n',
    'b.yml': 'key: ${OPENAI_API_KEY}\nurl: https://api.example.com/v1\n',
    'c.go': 'const x = 1\n',
  });
  const vendors = [{ id: 'v', hostnames: ['api.example.com'], envVars: ['OPENAI_API_KEY'] }];
  const { references, truncated } = await scanVendorReferences(root, vendors);
  expect(truncated).toBe(false);
  expect(references.get('v')).toEqual([
    { file: 'b.yml', line: 1, kind: 'env', name: 'OPENAI_API_KEY' },
    { file: 'b.yml', line: 2, kind: 'hostname', name: 'api.example.com' },
  ]);
  const limited = await scanVendorReferences(root, vendors, {
    files: 1,
    fileBytes: 1024,
    totalBytes: 1024,
  });
  expect(limited).toMatchObject({ files: 1, truncated: true });
});

it('rejects catalog entries without sources and keeps agents and vendors apart', () => {
  const entry = {
    name: 'Example',
    packages: ['example-sdk'],
    hostnames: [
      { names: ['api.example.com'], source: 'https://example.com/docs', checkedAt: '2026-10-27' },
    ],
    checkedAt: '2026-10-27',
  };
  expect(
    parseVendorCatalog(
      {
        formatVersion: 1,
        vendors: {
          example: entry,
          stripe: {
            envVars: [
              {
                names: ['STRIPE_SECRET_KEY'],
                source: 'https://docs.stripe.com/keys',
                checkedAt: '2026-10-27',
              },
            ],
          },
        },
      },
      ['stripe'],
    ),
  ).toMatchObject({
    sources: { stripe: { envVars: [{ names: ['STRIPE_SECRET_KEY'] }] } },
    vendors: [{ id: 'example' }],
  });
  expect(() =>
    parseVendorCatalog({ formatVersion: 1, vendors: { stripe: entry } }, ['stripe']),
  ).toThrow('stripe is already in the agent catalog.');
  expect(() =>
    parseVendorCatalog(
      {
        formatVersion: 1,
        vendors: {
          example: {
            ...entry,
            hostnames: [{ names: ['api.example.com'], checkedAt: '2026-10-27' }],
          },
        },
      },
      [],
    ),
  ).toThrow('needs an https URL');
  expect(() =>
    parseVendorCatalog(
      {
        formatVersion: 1,
        vendors: {
          example: {
            ...entry,
            envVars: [
              { names: ['API_KEY'], source: 'https://example.com', checkedAt: '2026-10-27' },
            ],
          },
        },
      },
      [],
    ),
  ).toThrow('API_KEY');
});
