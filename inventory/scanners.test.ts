import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutsideRepoError, resolveInside } from './repo-files.ts';
import {
  findEnvNames,
  findGraphqlDocuments,
  findHttpCalls,
  findImports,
  findWebhookSignals,
  listManifests,
  lockedVersions,
  packageLinks,
  repoMap,
} from './scanners.ts';
import { makeRepo, removeRepo } from './test-fixtures.ts';

const PRIVATE_ENV_VALUE = 'sk_test_fixture_never_print';

const FILES: Record<string, string[]> = {
  'package.json': [
    '{',
    '  "name": "fixture",',
    '  "dependencies": {',
    '    "stripe": "^14.0.0",',
    '    "left-pad": "1.3.0"',
    '  },',
    '  "devDependencies": {',
    '    "vitest": "^3.0.0"',
    '  }',
    '}',
  ],
  'requirements.txt': [
    '# runtime',
    'requests==2.31.0',
    'boto3>=1.28 ; python_version > "3.8"',
    '-r other.txt',
    'openai[datalib]',
  ],
  'go.mod': [
    'module example.com/app',
    '',
    'go 1.22',
    '',
    'require github.com/stripe/stripe-go/v76 v76.8.0',
    '',
    'require (',
    '\tgithub.com/google/uuid v1.6.0',
    '\tgolang.org/x/net v0.20.0 // indirect',
    ')',
  ],
  'package-lock.json': [
    '{',
    '  "name": "fixture",',
    '  "lockfileVersion": 3,',
    '  "packages": {',
    '    "": {',
    '      "dependencies": {',
    '        "stripe": "^14.0.0"',
    '      }',
    '    },',
    '    "node_modules/stripe": {',
    '      "version": "14.25.0",',
    '      "resolved": "https://registry.npmjs.org/stripe/-/stripe-14.25.0.tgz"',
    '    },',
    '    "node_modules/other/node_modules/stripe": {',
    '      "version": "12.0.0"',
    '    }',
    '  }',
    '}',
  ],
  'web/yarn.lock': [
    '# yarn lockfile v1',
    '',
    '',
    '"@shopify/shopify-api@^9.0.0":',
    '  version "9.3.1"',
    '  resolved "https://registry.yarnpkg.com/@shopify/shopify-api/-/shopify-api-9.3.1.tgz"',
    '',
    'stripe@^14.0.0, stripe@^14.1.0:',
    '  version "14.20.0"',
  ],
  'poetry.lock': [
    '[[package]]',
    'name = "requests"',
    'version = "2.31.0"',
    'description = "HTTP for Humans."',
    '',
    '[[package]]',
    'name = "Boto3"',
    'version = "1.34.0"',
  ],
  'src/app.ts': [
    "import Stripe from 'stripe';",
    "import { readFile } from 'node:fs/promises';",
    "import path from 'path';",
    "import { helper } from './helper';",
    "import { S3Client } from '@aws-sdk/client-s3';",
    "const shopify = await import('@shopify/shopify-api/rest');",
    "const legacy = require('left-pad');",
  ],
  'src/billing.ts': ["import { Stripe } from 'stripe';"],
  'src/weather.ts': [
    "const base = process.env.WEATHER_API_URL ?? 'https://api.weather.example.org/v2';",
    'export async function forecast(city: string) {',
    '  const response = await fetch(`${base}/forecast?city=${city}`);',
    '  return response.json();',
    '}',
  ],
  'src/queries.ts': [
    "import { gql } from '@apollo/client';",
    '',
    'export const GET_USER = gql`',
    '  query GetUser($id: ID!) {',
    '    user(id: $id) { name }',
    '  }',
    '`;',
  ],
  'src/webhook.ts': [
    "import Stripe from 'stripe';",
    'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);',
    'export function handle(body: string, signature: string) {',
    '  const event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);',
    '  switch (event.type) {',
    "    case 'invoice.paid':",
    '      return true;',
    '  }',
    '}',
  ],
  'graphql/orders.graphql': [
    'mutation CreateOrder($input: OrderInput!) {',
    '  createOrder(input: $input) { id }',
    '}',
    '',
    'fragment OrderFields on Order {',
    '  id',
    '}',
  ],
  'py/app.py': [
    'import os, json',
    'import requests',
    'from stripe import Charge',
    'from .local import thing',
    'import boto3.session as session',
  ],
  'py/client.py': [
    'import os',
    'import requests',
    "key = os.environ.get('OPENAI_API_KEY')",
    'QUERY = """',
    'query ListProducts {',
    '  products { id }',
    '}',
    '"""',
  ],
  'py/hooks.py': [
    'import hmac, hashlib',
    '',
    'def verify(secret, body, header):',
    '    digest = hmac.new(secret, body, hashlib.sha256).hexdigest()',
    '    return hmac.compare_digest(digest, header)',
  ],
  'go/main.go': [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\tstripe "github.com/stripe/stripe-go/v76/client"',
    '\t"github.com/google/uuid"',
    ')',
    'import "net/http"',
  ],
  '.env.example': [
    '# Stripe',
    'STRIPE_SECRET_KEY=',
    'WEATHER_API_URL=https://api.weather.example.org',
  ],
  '.env': [
    `STRIPE_SECRET_KEY=${PRIVATE_ENV_VALUE}`,
    'PRIVATE_API_URL=https://secret-host.internal',
  ],
};

let base: string;
let repo: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'aptitude-scanners-'));
  repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(
    path.join(outside, 'leak.ts'),
    "fetch('https://outside.example.net'); process.env.OUTSIDE_SECRET;\n",
  );
  for (const [file, lines] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), `${lines.join('\n')}\n`);
  }
  await symlink(outside, path.join(repo, 'linked'));
  await symlink(path.join(outside, 'leak.ts'), path.join(repo, 'leak.ts'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('listManifests', () => {
  it('reads package.json entries with their exact lines and dev flags', async () => {
    const { manifests } = await listManifests(repo);
    const npm = manifests.find((manifest) => manifest.file === 'package.json');
    expect(npm?.ecosystem).toBe('npm');
    expect(npm?.dependencies).toEqual([
      { name: 'stripe', version: '^14.0.0', line: 4, hint: 'Stripe' },
      { name: 'left-pad', version: '1.3.0', line: 5 },
      { name: 'vitest', version: '^3.0.0', line: 8, dev: true },
    ]);
  });

  it('parses requirements.txt and go.mod require lines and blocks', async () => {
    const { manifests, lockfiles } = await listManifests(repo);
    const python = manifests.find((manifest) => manifest.file === 'requirements.txt');
    expect(python?.dependencies).toEqual([
      { name: 'requests', version: '==2.31.0', line: 2 },
      { name: 'boto3', version: '>=1.28', line: 3, hint: 'AWS' },
      { name: 'openai', version: '', line: 5, hint: 'OpenAI' },
    ]);
    const go = manifests.find((manifest) => manifest.file === 'go.mod');
    expect(go?.dependencies).toEqual([
      { name: 'github.com/stripe/stripe-go/v76', version: 'v76.8.0', line: 5, hint: 'Stripe' },
      { name: 'github.com/google/uuid', version: 'v1.6.0', line: 8 },
      { name: 'golang.org/x/net', version: 'v0.20.0', line: 9 },
    ]);
    expect(lockfiles).toEqual(['package-lock.json', 'poetry.lock', 'web/yarn.lock']);
  });
});

describe('lockedVersions', () => {
  it('resolves stripe in package-lock v3 (including nested copies) and yarn.lock', async () => {
    expect(await lockedVersions(repo, 'stripe')).toEqual([
      { lockfile: 'package-lock.json', version: '14.25.0', line: 11 },
      { lockfile: 'package-lock.json', version: '12.0.0', line: 15 },
      { lockfile: 'web/yarn.lock', version: '14.20.0', line: 9 },
    ]);
    expect(await lockedVersions(repo, '@shopify/shopify-api')).toEqual([
      { lockfile: 'web/yarn.lock', version: '9.3.1', line: 5 },
    ]);
  });

  it('matches poetry.lock packages by normalized name', async () => {
    expect(await lockedVersions(repo, 'boto3')).toEqual([
      { lockfile: 'poetry.lock', version: '1.34.0', line: 8 },
    ]);
    expect(await lockedVersions(repo, 'left-pad')).toEqual([]);
  });
});

describe('findImports', () => {
  it('groups JS, Python and Go imports by package root and drops relative and stdlib ones', async () => {
    const { modules, truncated } = await findImports(repo);
    expect(truncated).toBe(false);
    const names = modules.map((entry) => entry.module);
    expect(names[0]).toBe('stripe');
    expect(modules[0]).toMatchObject({ files: 4, occurrences: 4, hint: 'Stripe' });
    expect(modules[0].first.map(({ file, line }) => `${file}:${line}`)).toEqual([
      'py/app.py:3',
      'src/app.ts:1',
      'src/billing.ts:1',
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        '@aws-sdk/client-s3',
        '@shopify/shopify-api',
        '@apollo/client',
        'left-pad',
        'requests',
        'boto3',
        'github.com/stripe/stripe-go',
        'github.com/google/uuid',
      ]),
    );
    for (const excluded of ['fs', 'path', 'node:fs', 'os', 'json', 'fmt', 'net', 'hmac', '']) {
      expect(names).not.toContain(excluded);
    }
    expect(modules.find((entry) => entry.module === 'requests')).toMatchObject({ files: 2 });
  });

  it('returns every occurrence of one module with the module filter', async () => {
    const { modules } = await findImports(repo, { module: 'github.com/stripe/stripe-go' });
    expect(modules).toHaveLength(1);
    expect(modules[0].first).toEqual([
      { file: 'go/main.go', line: 5, text: 'stripe "github.com/stripe/stripe-go/v76/client"' },
    ]);
    const stripe = await findImports(repo, { module: 'stripe', maxResults: 2 });
    expect(stripe.modules[0].first).toHaveLength(2);
    expect(stripe.truncated).toBe(true);
  });
});

describe('findHttpCalls', () => {
  it('finds an unknown host and a fetch built from an env base URL', async () => {
    const { hosts, clientCalls } = await findHttpCalls(repo);
    const weather = hosts.find((entry) => entry.host === 'api.weather.example.org');
    expect(weather?.occurrences).toBe(2);
    expect(weather?.examples.map(({ file, line }) => `${file}:${line}`)).toEqual([
      '.env.example:3',
      'src/weather.ts:1',
    ]);
    const weatherCalls = clientCalls.filter((call) => call.file === 'src/weather.ts');
    expect(weatherCalls.map((call) => call.line)).toEqual([1, 3]);
    expect(weatherCalls[1].text).toBe(
      'const response = await fetch(`${base}/forecast?city=${city}`);',
    );
  });

  it('skips lockfiles, private env files and symlinks out of the repo', async () => {
    const output = JSON.stringify(await findHttpCalls(repo));
    expect(output).not.toContain('registry.npmjs.org');
    expect(output).not.toContain('secret-host');
    expect(output).not.toContain(PRIVATE_ENV_VALUE);
    expect(output).not.toContain('outside.example.net');
  });
});

describe('findGraphqlDocuments', () => {
  it('reads tagged templates, .graphql files and query strings with names and lines', async () => {
    const { documents } = await findGraphqlDocuments(repo);
    const summary = documents.map(({ file, line, kind, name }) => ({ file, line, kind, name }));
    expect(summary).toEqual([
      { file: 'graphql/orders.graphql', line: 1, kind: 'mutation', name: 'CreateOrder' },
      { file: 'graphql/orders.graphql', line: 5, kind: 'fragment', name: 'OrderFields' },
      { file: 'py/client.py', line: 5, kind: 'query', name: 'ListProducts' },
      { file: 'src/queries.ts', line: 4, kind: 'query', name: 'GetUser' },
    ]);
    expect(documents[3].text).toBe('query GetUser($id: ID!) {\n    user(id: $id) { name }\n  }');
  });
});

describe('findWebhookSignals', () => {
  it('flags Stripe constructEvent, event.type handlers and generic HMAC checks', async () => {
    const { matches } = await findWebhookSignals(repo);
    const at = matches.map(({ file, line }) => `${file}:${line}`);
    expect(at).toEqual(
      expect.arrayContaining([
        'src/webhook.ts:4',
        'src/webhook.ts:5',
        'src/webhook.ts:6',
        'py/hooks.py:4',
        'py/hooks.py:5',
      ]),
    );
    expect(at).not.toContain('py/hooks.py:1');
  });
});

describe('findEnvNames', () => {
  it('collects names from code and env files without ever returning env values', async () => {
    const names = await findEnvNames(repo);
    const byName = new Map(names.map((entry) => [entry.name, entry]));
    expect(byName.get('STRIPE_SECRET_KEY')).toEqual({
      name: 'STRIPE_SECRET_KEY',
      occurrences: 3,
      locations: [
        { file: '.env', line: 1 },
        { file: '.env.example', line: 2 },
        { file: 'src/webhook.ts', line: 2 },
      ],
    });
    expect(byName.get('WEATHER_API_URL')?.locations).toEqual([
      { file: '.env.example', line: 3 },
      { file: 'src/weather.ts', line: 1 },
    ]);
    expect(byName.get('OPENAI_API_KEY')?.locations).toEqual([{ file: 'py/client.py', line: 3 }]);
    expect(byName.get('PRIVATE_API_URL')?.locations).toEqual([{ file: '.env', line: 2 }]);
    expect(byName.has('OUTSIDE_SECRET')).toBe(false);
    const output = JSON.stringify(names);
    expect(output).not.toContain(PRIVATE_ENV_VALUE);
    expect(output).not.toContain('secret-host');
  });
});

describe('repoMap', () => {
  it('reports totals, directory counts, extensions and manifest paths', async () => {
    const map = await repoMap(repo);
    const fileCount = Object.keys(FILES).length;
    const tsCount = Object.keys(FILES).filter((file) => file.endsWith('.ts')).length;
    expect(map).toContain(`repo/ (${fileCount} files)`);
    expect(map).toContain(`Total files: ${fileCount}`);
    expect(map).toContain('  src/ (5 files)');
    expect(map).toContain(`.ts ${tsCount}`);
    expect(map).toMatch(/Manifests:\n {2}go\.mod\n {2}package\.json\n {2}requirements\.txt/);
    expect(map).toContain('Lockfiles:\n  package-lock.json\n  poetry.lock\n  web/yarn.lock');
    expect(map).not.toContain('linked/');
  });
});

describe('repo confinement', () => {
  it('rejects paths and symlinks that resolve outside the repository', async () => {
    await expect(resolveInside(repo, '../x')).rejects.toBeInstanceOf(OutsideRepoError);
    await expect(resolveInside(repo, 'linked/leak.ts')).rejects.toBeInstanceOf(OutsideRepoError);
  });
});

describe('packageLinks', () => {
  it('reads Home-page and Project-URL headers from a virtualenv, not the description', async () => {
    const pythonRepo = await makeRepo({
      'requirements.txt': 'twilio==9.0.0\n',
      '.venv/lib/python3.12/site-packages/twilio-9.0.0.dist-info/METADATA': [
        'Metadata-Version: 2.1',
        'Name: twilio',
        'Home-page: https://github.com/twilio/twilio-python/',
        'Project-URL: Changelog, https://github.com/twilio/twilio-python/blob/main/CHANGES.md',
        '',
        'Project-URL: Ignored, https://example.com/description',
      ].join('\n'),
    });
    try {
      const found = await packageLinks(pythonRepo, 'Twilio');
      console.log(found);
      expect(found).toEqual([
        {
          file: '.venv/lib/python3.12/site-packages/twilio-9.0.0.dist-info/METADATA',
          links: {
            'Home-page': 'https://github.com/twilio/twilio-python/',
            Changelog: 'https://github.com/twilio/twilio-python/blob/main/CHANGES.md',
          },
        },
      ]);
      expect(await packageLinks(pythonRepo, 'stripe')).toEqual([]);
    } finally {
      await removeRepo(pythonRepo);
    }
  });
});
