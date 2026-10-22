import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CATALOG, detectProviders } from './agent-catalog.ts';
import { scanCloudSdkClients, type CloudSdkClient } from './cloud-sdk-clients.ts';
import { scanDeadlines } from './deadline-exposure.ts';
import { loadDeadlineRegistry } from './deadline-registry.ts';

const NOW = new Date('2026-10-22T00:00:00Z');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(files: Record<string, string>, manifest: object = { name: 'app' }) {
  const root = await mkdtemp(join(tmpdir(), 'refit-cloud-sdk-'));
  roots.push(root);
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify(manifest, null, 2),
    ...files,
  })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

async function clients(files: Record<string, string>, manifest?: object) {
  return (await scanCloudSdkClients(await repository(files, manifest))).clients;
}

function summary(found: CloudSdkClient[]) {
  return found.map((item) => `${item.file}:${item.line} ${item.sdk} ${item.name} ${item.use}`);
}

describe('AWS SDK v2 clients', () => {
  it('reports clients constructed through the AWS namespace in every import style', async () => {
    const found = await clients({
      'src/require.js': `const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION });
const s3 = new AWS.S3({ apiVersion: '2006-03-01' });
const ses = new AWS.SES();
const credentials = new AWS.Credentials('id', 'secret');
`,
      'src/default.ts': `import AWS from 'aws-sdk';
export const queue = new AWS.SQS({ region: 'us-east-1' });
`,
      'src/star.ts': `import * as AWS from 'aws-sdk';
const db = new AWS.DynamoDB.DocumentClient();
`,
      'src/equals.ts': `import AWS = require('aws-sdk');
const lambda = new AWS.Lambda();
`,
    });
    expect(summary(found)).toEqual([
      'src/default.ts:2 aws-sdk-v2 SQS live',
      'src/equals.ts:2 aws-sdk-v2 Lambda live',
      'src/require.js:3 aws-sdk-v2 S3 live',
      'src/require.js:4 aws-sdk-v2 SES live',
      'src/star.ts:2 aws-sdk-v2 DynamoDB.DocumentClient live',
    ]);
    const s3 = found.find((item) => item.service === 'S3')!;
    expect(s3.replacement).toEqual(['@aws-sdk/client-s3']);
    expect(s3.deadline).toEqual({ id: 'aws-sdk-js-v2-2025-09-08', date: '2025-09-08' });
    expect(s3.text).toBe("const s3 = new AWS.S3({ apiVersion: '2006-03-01' });");
    expect(found.find((item) => item.service === 'DynamoDB')!.replacement).toEqual([
      '@aws-sdk/client-dynamodb',
    ]);
  });

  it('reports named imports, per-client paths and destructured clients', async () => {
    const found = await clients({
      'src/named.ts': `import { S3, CognitoIdentityServiceProvider as Cognito } from 'aws-sdk';
const s3 = new S3();
const idp = new Cognito({ region: 'eu-west-1' });
`,
      'src/path.js': `const S3 = require('aws-sdk/clients/s3');
import DynamoDB from 'aws-sdk/clients/dynamodb';
import { DocumentClient } from 'aws-sdk/clients/dynamodb';
const s3 = new S3();
const raw = new DynamoDB();
const docs = new DocumentClient({ convertEmptyValues: true });
`,
      'src/destructured.js': `const { SNS, DynamoDB } = require('aws-sdk');
const { DocumentClient } = DynamoDB;
const AWS = require('aws-sdk');
const { Kinesis } = AWS;
const Firehose = AWS.Firehose;
new SNS();
new DocumentClient();
new Kinesis();
new Firehose();
new (require('aws-sdk').SQS)();
new (require('aws-sdk/clients/ses'))();
`,
    });
    expect(summary(found)).toEqual([
      'src/destructured.js:6 aws-sdk-v2 SNS live',
      'src/destructured.js:7 aws-sdk-v2 DynamoDB.DocumentClient live',
      'src/destructured.js:8 aws-sdk-v2 Kinesis live',
      'src/destructured.js:9 aws-sdk-v2 Firehose live',
      'src/destructured.js:10 aws-sdk-v2 SQS live',
      'src/destructured.js:11 aws-sdk-v2 SES live',
      'src/named.ts:2 aws-sdk-v2 S3 live',
      'src/named.ts:3 aws-sdk-v2 CognitoIdentityServiceProvider live',
      'src/path.js:4 aws-sdk-v2 S3 live',
      'src/path.js:5 aws-sdk-v2 DynamoDB live',
      'src/path.js:6 aws-sdk-v2 DynamoDB.DocumentClient live',
    ]);
    expect(
      found.find((item) => item.name === 'CognitoIdentityServiceProvider')!.replacement,
    ).toEqual(['@aws-sdk/client-cognito-identity-provider']);
  });

  it('ignores non-client classes, other SDKs and same-named local classes', async () => {
    const found = await clients({
      'src/other.js': `const AWS = require('aws-sdk');
const config = new AWS.Config({ region: 'us-east-1' });
const endpoint = new AWS.Endpoint('http://localhost:4566');
class S3 {}
const local = new S3();
`,
      'src/minio.js': `const Minio = require('minio');
const S3 = require('./s3');
new Minio.Client({});
new S3();
`,
    });
    expect(found).toEqual([]);
  });

  it('marks clients in tests and examples, and keeps the service a client belongs to', async () => {
    const scan = await scanCloudSdkClients(
      await repository({
        'src/upload.js': `import AWS from 'aws-sdk';
const upload = new AWS.S3.ManagedUpload({ params: {} });
`,
        'test/upload.test.js': `const AWS = require('aws-sdk');
const s3 = new AWS.S3();
`,
      }),
    );
    expect(summary(scan.clients)).toEqual([
      'src/upload.js:2 aws-sdk-v2 S3.ManagedUpload live',
      'test/upload.test.js:2 aws-sdk-v2 S3 test',
    ]);
    expect(scan.services).toEqual([
      {
        sdk: 'aws-sdk-v2',
        service: 'S3',
        replacement: ['@aws-sdk/client-s3'],
        live: 1,
        test: 1,
        files: ['src/upload.js', 'test/upload.test.js'],
      },
    ]);
  });
});

describe('AWS SDK v3 clients', () => {
  it('reports bare and aggregated clients, not commands or errors, beside v2 in a half migration', async () => {
    const scan = await scanCloudSdkClients(
      await repository({
        'src/new.ts': `import { S3Client, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import * as sqs from '@aws-sdk/client-sqs';
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const client = new S3Client({ region: 'us-east-1' });
await client.send(new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'x' }));
const db = new DynamoDB({});
const queue = new sqs.SQSClient({});
const mail = new SESv2Client({});
new SendEmailCommand({});
throw new S3ServiceException({ name: 'x', $fault: 'client', $metadata: {} });
`,
        'src/old.js': `const AWS = require('aws-sdk');
const s3 = new AWS.S3();
`,
      }),
    );
    expect(summary(scan.clients)).toEqual([
      'src/new.ts:5 aws-sdk-v3 S3Client live',
      'src/new.ts:7 aws-sdk-v3 DynamoDB live',
      'src/new.ts:8 aws-sdk-v3 SQSClient live',
      'src/new.ts:9 aws-sdk-v3 SESv2Client live',
      'src/old.js:2 aws-sdk-v2 S3 live',
    ]);
    expect(scan.services.map((row) => `${row.sdk} ${row.service} ${row.live}`)).toEqual([
      'aws-sdk-v2 S3 1',
      'aws-sdk-v3 @aws-sdk/client-dynamodb 1',
      'aws-sdk-v3 @aws-sdk/client-s3 1',
      'aws-sdk-v3 @aws-sdk/client-sesv2 1',
      'aws-sdk-v3 @aws-sdk/client-sqs 1',
    ]);
    expect(scan.clients.find((item) => item.sdk === 'aws-sdk-v3')!.deadline).toBeNull();
  });
});

describe('legacy Azure SDK packages', () => {
  it('lists where each retired package is loaded, with its deadline and replacements', async () => {
    const found = await clients({
      'src/storage.js': `const azure = require('azure-storage');
const blobService = azure.createBlobService(process.env.AZURE_STORAGE_CONNECTION_STRING);
`,
      'src/bus.ts': `import * as azureSb from 'azure-sb';
import { BlobServiceClient } from '@azure/storage-blob';
const errors = require('azure-storage/lib/common/errors/errors');
`,
    });
    expect(summary(found)).toEqual([
      'src/bus.ts:1 azure-legacy azure-sb live',
      'src/bus.ts:3 azure-legacy azure-storage live',
      'src/storage.js:1 azure-legacy azure-storage live',
    ]);
    const storage = found.find((item) => item.file === 'src/storage.js')!;
    expect(storage.deadline).toEqual({ id: 'azure-sdk-legacy-2023-03-31', date: '2023-03-31' });
    expect(storage.replacement).toEqual([
      '@azure/storage-blob',
      '@azure/storage-queue',
      '@azure/storage-file-share',
      '@azure/data-tables',
    ]);
    expect(found.find((item) => item.service === 'azure-sb')!.deadline).toEqual({
      id: 'azure-sdk-legacy-2023-12-31',
      date: '2023-12-31',
    });
  });
});

describe('registry and catalog', () => {
  it('monitors aws-sdk and legacy Azure packages declared in manifests through scanDeadlines', async () => {
    const root = await repository(
      {
        'src/index.js':
          "const AWS = require('aws-sdk');\nconst azure = require('azure-storage');\n",
        'examples/demo/package.json': JSON.stringify({ dependencies: { 'aws-sdk': '^2.0.0' } }),
      },
      { name: 'app', dependencies: { 'aws-sdk': '^2.1500.0', 'azure-storage': '^2.10.7' } },
    );
    const scan = await scanDeadlines(root, await loadDeadlineRegistry(), NOW);
    const aws = scan.exposures.find((item) => item.deadline.id === 'aws-sdk-js-v2-2025-09-08')!;
    expect(aws.evidence.map((item) => `${item.file}:${item.line} ${item.use}`)).toEqual([
      'package.json:4 live',
    ]);
    expect(aws.nonLive.map((item) => `${item.file} ${item.use}`)).toEqual([
      'examples/demo/package.json test',
    ]);
    expect(aws.days).toBeLessThan(0);
    expect(
      scan.exposures.find((item) => item.deadline.id === 'azure-sdk-legacy-2023-03-31')!.evidence[0]
        .version,
    ).toBe('azure-storage');
  });

  it('does not tie v3 packages to the v2 deadline', async () => {
    const root = await repository(
      { 'src/index.ts': "import { S3Client } from '@aws-sdk/client-s3';\n" },
      { name: 'app', dependencies: { '@aws-sdk/client-s3': '^3.600.0' } },
    );
    const scan = await scanDeadlines(root, await loadDeadlineRegistry(), NOW);
    expect(scan.exposures.filter((item) => item.deadline.provider === 'aws')).toEqual([]);
  });

  it('keeps the Azure catalog, registry and generated retirement list in step', async () => {
    const data = JSON.parse(
      await readFile(new URL('../data/azure-sdk-retirements.json', import.meta.url), 'utf8'),
    );
    const registry = await loadDeadlineRegistry();
    const names = data.packages.map((item: { name: string }) => item.name).sort();
    const registered = registry.deadlines
      .filter((entry) => entry.provider === 'azure')
      .flatMap((entry) => entry.versions)
      .sort();
    expect(registered).toEqual(names);
    expect([...AGENT_CATALOG.find((agent) => agent.id === 'azure')!.packages].sort()).toEqual(
      names,
    );
    for (const entry of registry.deadlines.filter((item) => item.provider === 'azure'))
      for (const name of entry.versions)
        expect(data.packages.find((item: { name: string }) => item.name === name).endOfLife).toBe(
          entry.date,
        );
    expect(names).toContain('azure-storage');
    expect(names).toContain('azure-sb');
    // Rows that retire only old versions of a maintained package are left out.
    expect(names).not.toContain('@azure/event-hubs');
    expect(names).not.toContain('@azure/cosmos');
  });

  it('detects AWS v2 and legacy Azure packages as catalog providers', async () => {
    const root = await repository(
      { 'src/index.js': "fetch('https://my-bucket.s3.us-east-1.amazonaws.com/key');\n" },
      { name: 'app', dependencies: { 'aws-sdk': '2.1693.0', 'azure-sb': '0.11.1' } },
    );
    const detections = await detectProviders(root);
    const aws = detections.find((item) => item.agent.id === 'aws')!;
    expect(aws.packages.map((item) => item.name)).toEqual(['aws-sdk']);
    expect(aws.hostnames).toEqual([{ file: 'src/index.js', line: 1, hostname: 'amazonaws.com' }]);
    expect(
      detections.find((item) => item.agent.id === 'azure')!.packages.map((item) => item.name),
    ).toEqual(['azure-sb']);
    expect(AGENT_CATALOG.find((agent) => agent.id === 'aws')!.adapter).toBeNull();
  });
});
